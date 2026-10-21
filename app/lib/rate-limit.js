/*!
 * rate-limit.js : api/* のレート制限(未認証と認証済みを別枠にする)と、その上限の設定
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 未認証は IP ごと(総当たり・スクレイピング等の悪用が主目的なので低め)、認証済みは利用者ごと
 * (正規利用者・AI 連携の API キー。複数文書の一括操作でまとまった量になる)に数える。
 *
 * 上限(5 分あたりの回数)の決まり方は、ほかの管理画面の設定(app-settings.js)と同じ:
 *   管理画面で保存した値 → 環境変数(RATE_LIMIT_AUTHENTICATED・RATE_LIMIT_ANONYMOUS)→ 既定(10000・300)
 * API を呼ぶたびに参照するので、毎回 DB を読まず 30 秒だけ覚えておく。複数台で動かしていても 30 秒以内に全台に効く
 * (保存した台はすぐ効く)。
 *
 * 上限を超えたときは 429 と {error, code: "rate_limited", retryAfterSeconds} を返す(Retry-After ヘッダーも付く)。
 * 誰が・どの API で上限に当たったかをログに残す(同じ相手は 1 分に 1 回だけ。その間に断った回数を添える)。
 */

const {rateLimit, ipKeyGenerator} = require("express-rate-limit");

const WINDOW_MS = 5 * 60 * 1000;
const DEFAULTS = Object.freeze({authenticated: 10000, anonymous: 300});
// 管理画面で入れられる範囲(小さすぎると画面も使えなくなるので下限を設ける)
const RANGES = Object.freeze({authenticated: {min: 100, max: 1000000}, anonymous: {min: 10, max: 100000}});
const KINDS = Object.freeze(["authenticated", "anonymous"]);
const SETTING_KEYS = Object.freeze({authenticated: "ratelimit.authenticated", anonymous: "ratelimit.anonymous"});
const CACHE_MS = 30 * 1000;
const MESSAGE = "リクエストが多すぎます。しばらく待ってから再度お試しください。";
const LOG_EVERY_MS = 60 * 1000;
Object.assign(module.exports, {WINDOW_MS, DEFAULTS, RANGES, KINDS, SETTING_KEYS, CACHE_MS});

/** 環境変数の上限(正の整数でなければ既定) */
const limitFromEnv = (value, fallback) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};
module.exports.limitFromEnv = limitFromEnv;

/**
 * 上限の設定(管理画面で保存した値 → 環境変数 → 既定)。30 秒だけ覚える
 * @param {{appSettings: object, env?: object, now?: () => number}} deps appSettings は app-settings.js
 */
module.exports.createLimitSettings = ({appSettings, env = process.env, now = Date.now}) => {
	const envDefaults = {
		authenticated: limitFromEnv(env.RATE_LIMIT_AUTHENTICATED, DEFAULTS.authenticated),
		anonymous: limitFromEnv(env.RATE_LIMIT_ANONYMOUS, DEFAULTS.anonymous)
	};
	// 環境変数で決めたか(正しくない値は既定にする)
	const envSource = {
		authenticated: limitFromEnv(env.RATE_LIMIT_AUTHENTICATED, null) != null ? "env" : "default",
		anonymous: limitFromEnv(env.RATE_LIMIT_ANONYMOUS, null) != null ? "env" : "default"
	};
	let cached = null;
	let cachedAt = -Infinity;
	let loading = null;
	const load = async () => {
		const result = {};
		for (const kind of KINDS) {
			const row = await appSettings.getValue(SETTING_KEYS[kind]);
			const saved = row == null ? null : limitFromEnv(row.value, null);
			result[kind] = {
				limit: saved ?? envDefaults[kind],
				source: saved != null ? "setting" : envSource[kind],
				envDefault: envDefaults[kind],
				updatedBy: saved != null ? row.updatedBy : null,
				updatedAt: saved != null ? row.updatedAt : null
			};
		}
		cached = result;
		cachedAt = now();
		return result;
	};
	/** いまの上限(30 秒以内に読んだものがあればそれ。読めなければ前の値か環境変数の既定) */
	const current = async () => {
		if (cached != null && now() - cachedAt < CACHE_MS) return cached;
		loading ??= load().catch(() => cached ?? Object.fromEntries(KINDS.map((k) => [k, {limit: envDefaults[k], source: envSource[k], envDefault: envDefaults[k]}])))
			.finally(() => { loading = null; });
		return loading;
	};
	return {
		envDefaults,
		current,
		limitOf: async (kind) => (await current())[kind].limit,
		/** 保存する(この台にはすぐ効く)。範囲外は Error(status 400) */
		set: async (kind, value, user) => {
			const n = Number(value);
			const range = RANGES[kind];
			if (range == null) throw Object.assign(new Error(`種類は ${KINDS.join(" / ")} のどれかです`), {status: 400});
			if (!Number.isInteger(n) || n < range.min || n > range.max) {
				throw Object.assign(new Error(`上限は ${range.min} 〜 ${range.max} の整数です(5 分あたりの回数)`), {status: 400});
			}
			await appSettings.setValue(SETTING_KEYS[kind], String(n), user);
			return load();
		},
		/** 保存した値を消して、環境変数(無ければ既定)に戻す */
		clear: async (kind, user) => {
			if (RANGES[kind] == null) throw Object.assign(new Error(`種類は ${KINDS.join(" / ")} のどれかです`), {status: 400});
			await appSettings.clear(SETTING_KEYS[kind], user);
			return load();
		}
	};
};

/**
 * api/* に掛ける 2 つのミドルウェア(未認証・認証済み)。認証の解決(req.authData)のあとに置く
 * @param {{limitOf: (kind: string) => (number|Promise<number>), logger: object, disabled?: boolean, exempt?: (req) => boolean}} options
 *   exempt が真を返す呼び出しは数えない(管理者が上限を変える API。上限を下げすぎても戻せるように)
 * @returns {{anonymous: Function, authenticated: Function}}
 */
module.exports.createApiLimiters = ({limitOf, logger, disabled = false, exempt = () => false}) => {
	if (disabled) {
		// 無効化時は素通しのミドルウェアに差し替える(上限ヘッダーも付かなくなる)
		const pass = (req, res, next) => next();
		return {anonymous: pass, authenticated: pass};
	}
	// 同じ相手のログは 1 分に 1 回だけ(上限を超えて呼び続けるクライアントでログがあふれないように)
	const logged = new Map();
	const handler = (kind) => (req, res, next, options) => {
		const who = kind === "authenticated" ? req.authData?.user_identifier ?? null : null;
		const key = `${kind}:${who ?? req.ip}`;
		const now = Date.now();
		const entry = logged.get(key) ?? {at: 0, suppressed: 0};
		if (now - entry.at >= LOG_EVERY_MS) {
			logger.warn({audit: "rate_limited", kind, user: who, ip: req.ip, method: req.method, path: String(req.originalUrl || req.url).split("?")[0],
				windowMinutes: WINDOW_MS / 60000, suppressedSinceLastLog: entry.suppressed}, "レート制限の上限に達しました");
			logged.set(key, {at: now, suppressed: 0});
		} else {
			entry.suppressed++;
			logged.set(key, entry);
		}
		if (logged.size > 10000) logged.clear();
		const retryAfter = Number(res.getHeader("Retry-After")) || Math.ceil(WINDOW_MS / 1000);
		res.status(options.statusCode).json({error: MESSAGE, code: "rate_limited", retryAfterSeconds: retryAfter});
	};
	const common = {windowMs: WINDOW_MS, standardHeaders: "draft-7", legacyHeaders: false};
	return {
		anonymous: rateLimit({...common, limit: () => limitOf("anonymous"), handler: handler("anonymous"), skip: (req) => req.authData != null || exempt(req)}),
		authenticated: rateLimit({
			...common, limit: () => limitOf("authenticated"), handler: handler("authenticated"), skip: (req) => req.authData == null || exempt(req),
			// IP フォールバック時は ipKeyGenerator で包み、IPv6 を /64 サブネット単位に正しく集約する
			// (素の req.ip だと IPv6 の完全アドレス単位になり、上限を回避され得る)
			keyGenerator: (req) => req.authData?.user_identifier || ipKeyGenerator(req.ip)
		})
	};
};
