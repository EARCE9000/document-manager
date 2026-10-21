/*!
 * rate-limit.test.js : api/* のレート制限と、その上限の設定(app/lib/rate-limit.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 上限を超えると 429 と code: rate_limited・Retry-After を返すこと、誰が・どの API で当たったかを
 * 1 分に 1 回だけログに残すこと、上限が「管理画面で保存した値 → 環境変数 → 既定」で決まり、30 秒だけ覚えることを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("../app/node_modules/express");

const RateLimit = require("../app/lib/rate-limit.js");

/** 小さな express のアプリを立て、同じ利用者で n 回呼んだ結果を返す */
const hit = async (limiters, times, {user = "alice"} = {}) => {
	const app = express();
	app.set("trust proxy", false);
	app.use((req, res, next) => {
		req.authData = user == null ? null : {user_identifier: user};
		next();
	});
	app.use("/api/", limiters.anonymous, limiters.authenticated, (req, res) => res.json({ok: true}));
	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	try {
		const results = [];
		for (let i = 0; i < times; i++) {
			const res = await fetch(`http://127.0.0.1:${server.address().port}/api/documents?q=x`);
			results.push({status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json()});
		}
		return results;
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
};
const fakeLogger = () => {
	const lines = [];
	return {lines, warn: (data, message) => lines.push({data, message})};
};

test("上限を超えると 429 と code: rate_limited・Retry-After を返し、誰がどの API で当たったかをログに残す(同じ相手は 1 分に 1 回)", async () => {
	const logger = fakeLogger();
	const limiters = RateLimit.createApiLimiters({limitOf: (kind) => (kind === "authenticated" ? 3 : 1), logger});
	const results = await hit(limiters, 6);
	assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 429, 429, 429]);
	const limited = results[3];
	assert.equal(limited.body.code, "rate_limited");
	assert.ok(Number(limited.retryAfter) > 0);
	assert.equal(limited.body.retryAfterSeconds, Number(limited.retryAfter));
	// 3 回断ったが、ログは 1 回(path に問い合わせ文字列を含めない)
	assert.equal(logger.lines.length, 1);
	assert.deepEqual(logger.lines[0].data, {audit: "rate_limited", kind: "authenticated", user: "alice", ip: logger.lines[0].data.ip,
		method: "GET", path: "/api/documents", windowMinutes: 5, suppressedSinceLastLog: 0});
	// ログインしていない呼び出しは別枠(IP ごと)
	const anon = await hit(RateLimit.createApiLimiters({limitOf: (kind) => (kind === "authenticated" ? 100 : 1), logger: fakeLogger()}), 2, {user: null});
	assert.deepEqual(anon.map((r) => r.status), [200, 429]);
	// 無効化すると上限をかけない
	const off = await hit(RateLimit.createApiLimiters({limitOf: () => 1, logger: fakeLogger(), disabled: true}), 3);
	assert.deepEqual(off.map((r) => r.status), [200, 200, 200]);
	// exempt が真の呼び出しは数えない(管理者が上限を変える API)
	const exempt = await hit(RateLimit.createApiLimiters({limitOf: () => 1, logger: fakeLogger(), exempt: (req) => req.path === "/documents"}), 3);
	assert.deepEqual(exempt.map((r) => r.status), [200, 200, 200]);
});

test("上限の決まり方: 管理画面で保存した値 → 環境変数 → 既定(10000・300)。30 秒だけ覚え、保存した台にはすぐ効く", async () => {
	const rows = new Map();
	let reads = 0;
	const appSettings = {
		getValue: async (key) => {
			reads++;
			return rows.get(key) ?? null;
		},
		setValue: async (key, value, user) => rows.set(key, {value, updatedBy: user, updatedAt: "2026-10-21T00:00:00.000Z"}),
		clear: async (key) => rows.delete(key)
	};
	let clock = 0;
	// 既定
	const plain = RateLimit.createLimitSettings({appSettings, env: {}, now: () => clock});
	assert.deepEqual(await plain.current(), {
		authenticated: {limit: 10000, source: "default", envDefault: 10000, updatedBy: null, updatedAt: null},
		anonymous: {limit: 300, source: "default", envDefault: 300, updatedBy: null, updatedAt: null}
	});
	// 環境変数(正しくない値は既定)
	const settings = RateLimit.createLimitSettings({appSettings, env: {RATE_LIMIT_AUTHENTICATED: "5000", RATE_LIMIT_ANONYMOUS: "abc"}, now: () => clock});
	assert.equal(await settings.limitOf("authenticated"), 5000);
	assert.equal((await settings.current()).authenticated.source, "env");
	assert.equal((await settings.current()).anonymous.source, "default");
	// 保存すると、この台にはすぐ効く
	const saved = await settings.set("authenticated", 20000, "admin@example.com");
	assert.deepEqual(saved.authenticated, {limit: 20000, source: "setting", envDefault: 5000, updatedBy: "admin@example.com", updatedAt: "2026-10-21T00:00:00.000Z"});
	// ほかの台(別の設定オブジェクト)は、覚えている 30 秒のあいだは前の値
	const other = RateLimit.createLimitSettings({appSettings, env: {}, now: () => clock});
	rows.delete(RateLimit.SETTING_KEYS.authenticated);
	assert.equal(await other.limitOf("authenticated"), 10000);
	await appSettings.setValue(RateLimit.SETTING_KEYS.authenticated, "30000", "admin@example.com");
	const before = reads;
	clock += 10 * 1000;
	assert.equal(await other.limitOf("authenticated"), 10000);
	assert.equal(reads, before, "30 秒以内は DB を読まない");
	clock += 25 * 1000;
	assert.equal(await other.limitOf("authenticated"), 30000);
	// 範囲外は断る。既定に戻すと環境変数の値
	await assert.rejects(settings.set("authenticated", 50, "a"), (err) => err.status === 400);
	await assert.rejects(settings.set("anonymous", 1.5, "a"), (err) => err.status === 400);
	await assert.rejects(settings.set("other", 500, "a"), (err) => err.status === 400);
	const cleared = await settings.clear("authenticated", "admin@example.com");
	assert.deepEqual([cleared.authenticated.limit, cleared.authenticated.source], [5000, "env"]);
});
