/*!
 * skill-download-token.js : Skill のZIPを、AIエージェントに取ってきてもらうための短時間だけ有効な引換券
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- なぜ必要か ----
 * 以前は、利用者が画面でZIPを保存し、AIエージェントのチャットに添付していた。依頼文だけを貼って
 * AIに取ってきてもらえれば手間が1つ減るが、ZIPの取得にはログインかAPIキーが要る。ところが
 * AIはまだAPIキーを持っていない(キーの登録は、ZIPの中のクライアントで行うため)。
 *
 * そこで「登録依頼文をコピー」を押したときに引換券を発行し、取得用のURLに埋めて依頼文へ入れる。
 *
 *   POST /api/skills/<名前>/download-link             ← 認証が必要。ここで発行する
 *   GET  /api/skill-downloads/<引換券>/<名前>-skill.zip ← 引換券で検証する(認証なし)
 *
 * ---- 認証を外しているわけではない ----
 * 引換券は認証できた利用者にしか渡らない。加えて、
 *   - その Skill のZIPを取ることにしか使えない(文書にもAPIにも触れられない)
 *   - 有効期限が短い(既定30分)
 *   - 署名はサーバーの秘密鍵(SESSION_SECRET から派生)で、偽造できない
 * チャットの記録に残っても、期限が過ぎれば使えない。期限内に誰かに見られても、取れるのは
 * ログインした人なら誰でも取れるZIP(クライアントと説明書。秘密の情報は入っていない)だけである。
 *
 * 1回限りにはしていない。AIがダウンロードに失敗してやり直したときに使えなくなるため。
 *
 * 発行先(u)と発行時刻(i)も券に入れ、配信側で「その利用者が切断された時刻より前の券」を
 * 拒否できるようにしている(mockup-token.js と同じ考え方。判定は server.js)。
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const TTL_MINUTES = Number(process.env.SKILL_DOWNLOAD_TOKEN_MINUTES || 30);

// 署名鍵。SESSION_SECRETから、この用途だけの値を派生させる(モックアップの引換券とは混ざらない)
const SIGNING_KEY = crypto.createHash("sha256")
	.update(`skill-download:${process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")}`)
	.digest();

const encode = (buffer) => Buffer.from(buffer).toString("base64url");
const sign = (payload) => crypto.createHmac("sha256", SIGNING_KEY).update(payload).digest();

/**
 * 引換券を発行する。
 * @param {string} skill 対象のSkill(このZIPにしか使えない)
 * @param {string} user 発行を受けた利用者
 * @returns {{token: string, expiresAt: string}}
 */
module.exports.issue = (skill, user) => {
	const now = Date.now();
	const expiresAt = now + TTL_MINUTES * 60 * 1000;
	const payload = encode(JSON.stringify({s: skill, e: expiresAt, u: user, i: now}));
	logger.info({audit: "skill-download-link", skill, user, expiresInMinutes: TTL_MINUTES}, "Skillの取得用URLを発行しました");
	return {token: `${payload}.${encode(sign(payload))}`, expiresAt: new Date(expiresAt).toISOString()};
};

/**
 * 引換券を読む。署名が正しく、期限内のときだけ中身を返す。
 * @returns {{skill: string, user: string, issuedAt: number}|null}
 */
module.exports.read = (token) => {
	if (typeof token !== "string") return null;
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
	if (claims == null || typeof claims.s !== "string" || claims.s === "") return null;
	if (typeof claims.e !== "number" || claims.e < Date.now()) return null;
	if (typeof claims.u !== "string" || claims.u === "" || typeof claims.i !== "number") return null;
	return {skill: claims.s, user: claims.u, issuedAt: claims.i};
};

module.exports.TTL_MINUTES = TTL_MINUTES;
