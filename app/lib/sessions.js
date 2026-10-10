/*!
 * sessions.js : ログイン中のセッションの一覧と、利用者単位の切断
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 不正アクセスが疑われるとき、管理者が対象の利用者を**まとめて切る**ための土台。
 * 切るのは次の一式(呼び出し側の server.js が束ねる)。
 *
 *   - ログイン中のセッション(このファイル)
 *   - その利用者が発行したAPIキー(api-keys.js)
 *   - 発行済みのモックアップ引換券(mockup-token.js。切断時刻より前のものを拒否する)
 *
 * ---- 切断は「消す」と「覚える」の二段構え ----
 * sessions テーブルから行を消すだけでは足りない。express-session は応答の最後に
 * セッションを書き戻すことがあり、**消した直後に処理中だった要求が行を復活させる**。
 * そこで切断した時刻を session_revocations に残し、それより前にログインしたセッションは
 * 行が残っていても通さない(isAlive)。引換券も同じ時刻で判定する。
 *
 * ---- セッションIDは外へ出さない ----
 * sid はそれ自体がログインの鍵なので、一覧にも履歴にも通知にも載せない。
 * 画面で行を見分けるための目印には、sid から作った一方向の値(handleOf)を使う。
 *
 * ログイン時刻・IP・User-Agent・最終アクセスは、列を足さずにセッションの中身(JSON)へ入れている。
 * sessions は揮発データとしてスキーマ移行の対象外にしてあるため(session-store.js 冒頭参照)。
 */

const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

// 最終アクセスを書き直す間隔。毎回書くと、読むだけだった要求がすべて書き込みになる。
// 知りたいのは「いまも使われているか」なので、5分の粗さで足りる
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
// User-Agent は利用者が送ってくる値。際限なく長いものを抱え込まない
const USER_AGENT_MAX_LENGTH = 300;

const SQL_SELECT_LIVE_SESSIONS = "SELECT sid, data, expires_at FROM sessions WHERE expires_at > ?";
const SQL_DELETE_SESSION = "DELETE FROM sessions WHERE sid = ?";
const SQL_SELECT_REVOCATION = "SELECT revoked_at FROM session_revocations WHERE user_identifier = ?";
const SQL_SELECT_ALL_REVOCATIONS = "SELECT user_identifier, revoked_at FROM session_revocations";
const SQL_UPSERT_REVOCATION = `
	INSERT INTO session_revocations (user_identifier, revoked_at, revoked_by)
	VALUES (@user_identifier, @revoked_at, @revoked_by)
	ON CONFLICT (user_identifier) DO UPDATE SET revoked_at = excluded.revoked_at, revoked_by = excluded.revoked_by
`;

/** sid から、画面や通知に出してよい目印を作る(元の sid には戻せない) */
const handleOf = (sid) => crypto.createHash("sha256").update(`session-handle:${sid}`).digest("hex").slice(0, 16);

const toMs = (value) => {
	const ms = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
};

/** ログインした時点の手がかり(セッションへそのまま入れる) */
const describeLogin = (req) => {
	const now = new Date().toISOString();
	return {
		loginAt: now,
		// ログインした瞬間から一覧に出るよう、最初の値はここで入れる
		lastSeenAt: now,
		ip: req.ip || null,
		userAgent: String(req.get("user-agent") || "").slice(0, USER_AGENT_MAX_LENGTH) || null
	};
};

/**
 * 最終アクセスを更新する(前回から間隔があいたときだけ)。
 * セッションを書き換えると express-session が応答の最後に保存する。
 * @returns {boolean} 書き換えたか
 */
const touchLastSeen = (session, now = Date.now()) => {
	if (session == null) return false;
	if (now - toMs(session.lastSeenAt) < LAST_SEEN_INTERVAL_MS) return false;
	session.lastSeenAt = new Date(now).toISOString();
	return true;
};

/** その利用者が最後に切断された時刻(ISO文字列)。切断されたことが無ければ null */
const getRevokedAt = async (userIdentifier) => {
	const row = await ds.get(SQL_SELECT_REVOCATION, [userIdentifier]);
	return row?.revoked_at ?? null;
};

/**
 * 切断をくぐり抜けていないか。
 *
 * 切断より後にログインしたセッションだけを通す。ログイン時刻を持たないもの
 * (この機能を入れる前からのセッション)は、切断があった利用者については通さない。
 * 例外は、管理者が自分自身を切断したときに操作していたセッション
 * (survivedRevocationAt に、その切断の時刻を書いてある)。
 */
const isAlive = (session, revokedAt) => {
	if (revokedAt == null) return true;
	if (session?.survivedRevocationAt === revokedAt) return true;
	return toMs(session?.loginAt) > toMs(revokedAt);
};

/** いま切断されていないか(認証のたびに呼ぶ) */
const isSessionAlive = async (session) => {
	const user = session?.user?.identifier;
	if (user == null) return false;
	return isAlive(session, await getRevokedAt(user));
};

/**
 * 引換券など、セッションの外で配ったものがまだ有効か。
 * @param {string} userIdentifier 発行先
 * @param {number} issuedAtMs 発行時刻(epoch ms)
 */
const isIssuedAfterRevocation = async (userIdentifier, issuedAtMs) => {
	const revokedAt = await getRevokedAt(userIdentifier);
	return revokedAt == null || issuedAtMs > toMs(revokedAt);
};

const readLiveSessions = async () => {
	const rows = await ds.all(SQL_SELECT_LIVE_SESSIONS, [Date.now()]);
	const revocations = new Map((await ds.all(SQL_SELECT_ALL_REVOCATIONS, [])).map((row) => [row.user_identifier, row.revoked_at]));
	const sessions = [];
	for (const row of rows) {
		let data;
		try {
			data = JSON.parse(row.data);
		} catch (err) {
			continue;   // 壊れた行は読めないだけで、害は無い(期限が来れば掃除される)
		}
		const user = data?.user?.identifier;
		// ログイン前のもの(OIDCの往復中)は対象外
		if (typeof user !== "string" || user === "") continue;
		sessions.push({sid: row.sid, user, data, expiresAt: Number(row.expires_at), alive: isAlive(data, revocations.get(user))});
	}
	return sessions;
};

const toPublic = (entry, currentSid) => ({
	// 画面で行を見分けるための目印。sid そのものではない
	id: handleOf(entry.sid),
	loginAt: entry.data.loginAt ?? null,
	lastSeenAt: entry.data.lastSeenAt ?? null,
	ip: entry.data.ip ?? null,
	userAgent: entry.data.userAgent ?? null,
	expiresAt: new Date(entry.expiresAt).toISOString(),
	current: entry.sid === currentSid
});

/**
 * ログイン中のセッションを利用者ごとにまとめて返す(sid は含めない)。
 * @param {string|null} currentSid 呼び出した本人のセッション(目印を付けるため)
 * @returns {Promise<Map<string, object[]>>}
 */
const listByUser = async (currentSid) => {
	const byUser = new Map();
	for (const entry of await readLiveSessions()) {
		// 切断後に書き戻されただけの行は、ログイン中ではない
		if (!entry.alive) continue;
		if (!byUser.has(entry.user)) byUser.set(entry.user, []);
		byUser.get(entry.user).push(toPublic(entry, currentSid));
	}
	for (const sessions of byUser.values()) {
		sessions.sort((a, b) => toMs(b.lastSeenAt || b.loginAt) - toMs(a.lastSeenAt || a.loginAt));
	}
	return byUser;
};

/**
 * 利用者のセッションをまとめて切る。
 *
 * @param {string} userIdentifier 対象
 * @param {object} options
 * @param {string} options.revokedBy 実行者
 * @param {string|null} options.exceptSid 残すセッション(管理者が自分を切るときの操作中のもの)
 * @returns {Promise<{revokedAt: string, sessions: object[]}>} 切ったセッションの手がかり(履歴に残す用。sid は含めない)
 */
const revokeUser = async (userIdentifier, {revokedBy, exceptSid = null}) => {
	const revokedAt = new Date().toISOString();
	// 先に「覚える」。消している最中に来た要求も、ここから先は通らない
	await ds.run(SQL_UPSERT_REVOCATION, {user_identifier: userIdentifier, revoked_at: revokedAt, revoked_by: revokedBy});

	const removed = [];
	for (const entry of await readLiveSessions()) {
		if (entry.user !== userIdentifier || entry.sid === exceptSid) continue;
		await ds.run(SQL_DELETE_SESSION, [entry.sid]);
		removed.push({
			loginAt: entry.data.loginAt ?? null,
			lastSeenAt: entry.data.lastSeenAt ?? null,
			ip: entry.data.ip ?? null,
			userAgent: entry.data.userAgent ?? null
		});
	}
	logger.info({userIdentifier, revokedBy, sessions: removed.length}, "::revokeUser");
	return {revokedAt, sessions: removed};
};

module.exports = {
	LAST_SEEN_INTERVAL_MS,
	handleOf,
	describeLogin,
	touchLastSeen,
	getRevokedAt,
	isAlive,
	isSessionAlive,
	isIssuedAfterRevocation,
	listByUser,
	revokeUser
};
