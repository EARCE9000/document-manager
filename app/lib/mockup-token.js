/*!
 * mockup-token.js : モックアップ配信用の、短時間だけ有効な引換券
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- なぜ必要か ----
 * モックアップは `Content-Security-Policy: sandbox allow-scripts` を付けて配信し、
 * オリジンを落とすことで、このアプリのAPI・cookieに手が届かないようにしている。
 * ところがオリジンを失うと、そのページからの副リソース要求(CSS・JS・画像)は
 * **クロスサイト扱い**になり、SameSite=Lax のセッションcookieが送られなくなる。
 * 結果、HTMLは開けるのに中身が動かない(実測: app.js が ERR_BLOCKED_BY_ORB で遮断された)。
 *
 * そこで、入口を開くとき(ここは通常のページ遷移なのでcookieが届く)に引換券を発行し、
 * URLのパスに埋める。モックアップ内の相対パスは引換券の下で解決されるため、
 * モックアップ側は何も変更しなくてよい。
 *
 *   /api/mockups/<ID>/view                      ← 認証が必要。ここで発行する
 *   /api/mockups/<ID>/view/<引換券>/index.html  ← 引換券で検証する
 *
 * ---- 認証を外しているわけではない ----
 * 引換券は認証できた利用者にしか渡らない。加えて、
 *   - 対象のモックアップ1件だけに使える(他のIDには使えない)
 *   - 有効期限が短い(既定60分)
 *   - 署名はサーバーの秘密鍵(SESSION_SECRET)で、偽造できない
 * URLが漏れた場合の露出を、その1件・その時間に限定する。
 *
 * ---- 誰に・いつ渡したかも券に入れている ----
 * 券はログインとは別に効くので、**セッションを切っても券は生き残る**。不正アクセスが
 * 疑われて利用者を切断したのに、最長で有効期限いっぱい見られ続けることになる。
 * そこで発行先(u)と発行時刻(i)を券に入れ、配信側で「その利用者が切断された時刻より
 * 前の券」を拒否できるようにしている(判定は server.js。lib/sessions.js 参照)。
 *
 * 署名方式にしているのは、複数インスタンス構成(Postgres)でも共有の保管場所が要らないため。
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const TTL_MINUTES = Number(process.env.MOCKUP_VIEW_TOKEN_MINUTES || 60);

// 署名鍵。SESSION_SECRETと同じものを使い回すが、用途が混ざらないよう別の値を派生させる
// (SESSION_SECRETが未設定の開発時は、プロセスごとのランダム値になる=再起動で無効になる)
const SIGNING_KEY = crypto.createHash("sha256")
	.update(`mockup-view:${process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")}`)
	.digest();

const encode = (buffer) => Buffer.from(buffer).toString("base64url");
const sign = (payload) => crypto.createHmac("sha256", SIGNING_KEY).update(payload).digest();

/**
 * 引換券を発行する。
 * @param {string} mockupId 対象のモックアップ(この1件にしか使えない)
 * @param {string} user 発行を受けた利用者(切断されたときに、この人の券をまとめて無効にする)
 */
module.exports.issue = (mockupId, user) => {
	const now = Date.now();
	const payload = encode(JSON.stringify({m: mockupId, e: now + TTL_MINUTES * 60 * 1000, u: user, i: now}));
	const token = `${payload}.${encode(sign(payload))}`;
	logger.info({mockupId, user, expiresInMinutes: TTL_MINUTES}, "モックアップ表示用の引換券を発行しました");
	return token;
};

/**
 * 引換券を読む。対象のモックアップと一致し、期限内で、署名が正しいときだけ中身を返す。
 * 発行先・発行時刻を持たない券(この仕組みを入れる前のもの)は読めない扱いにする
 * (切断されたかどうかを判定できないため。開き直せば新しい券が出る)。
 * @returns {{user: string, issuedAt: number}|null}
 */
module.exports.read = (token, mockupId) => {
	const claims = readClaims(token, mockupId);
	if (claims == null) return null;
	if (typeof claims.u !== "string" || claims.u === "" || typeof claims.i !== "number") return null;
	return {user: claims.u, issuedAt: claims.i};
};

/**
 * 引換券を確かめる。対象のモックアップと一致し、期限内で、署名が正しいときだけ true。
 * @returns {boolean}
 */
module.exports.verify = (token, mockupId) => module.exports.read(token, mockupId) != null;

const readClaims = (token, mockupId) => {
	if (typeof token !== "string" || typeof mockupId !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [payload, signature] = parts;

	let expected;
	let actual;
	try {
		expected = sign(payload);
		actual = Buffer.from(signature, "base64url");
	} catch {
		return null;
	}
	// 長さが違うと timingSafeEqual が例外を投げるため先に確かめる
	if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

	let claims;
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
	} catch {
		return null;
	}
	if (claims == null || claims.m !== mockupId) return null;
	if (typeof claims.e !== "number" || claims.e < Date.now()) return null;
	return claims;
};

module.exports.TTL_MINUTES = TTL_MINUTES;
