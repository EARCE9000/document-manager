/*!
 * api-keys.js : マシン間認証用 APIキー管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ブラウザの対話的ログイン(OAuth2)とは別に、Claude Desktop 等のクライアントが
 * api を直接叩けるようにするための Bearer トークン認証。
 * 平文キーはDBに保存せず、sha256ハッシュのみを保存する(発行時に一度だけ平文を返す)。
 *
 * キーは「貼った先に平文で残る」運用を前提に、既定では有効期限を持たせる(当日限り/30日/90日)。
 * 最長でも1年で失効する(無期限キーは発行できない。漏えいしたキットが際限なく使われるのを防ぐため)。
 * スクリプト・常駐ツール等から継続利用する場合は、期限切れ前に発行し直す。権限はキー発行時に選んだロール
 * (readonly/readwrite。adminキーは発行不可)に固定される。
 * 発行者本人のロールが後から変わっても、既存キーのロードには影響しない
 * (権限判定は常に「キーに記録されたrole」を見る。発行者自身がホワイトリストから
 * 外れた場合のみ、別途requireAuth側でログイン不可=キーも無効として扱う)。
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");
const AllowedUsers = require("./allowed-users.js");

const API_KEY_PREFIX = "dm_";
const API_KEY_ROLES = Object.freeze([AllowedUsers.ROLES.READONLY, AllowedUsers.ROLES.READWRITE]);
const isValidApiKeyRole = (role) => API_KEY_ROLES.includes(role);

const EXPIRY_OPTIONS = Object.freeze({
	TODAY: "today",
	DAYS_30: "30d",
	DAYS_90: "90d",
	DAYS_365: "365d"
});
const isValidExpiryOption = (option) => Object.values(EXPIRY_OPTIONS).includes(option);

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 発行できる有効期限の上限(1年)。以前は「無期限」を選べたため、その頃に発行されたキーは
// expires_atに番兵値(9999-12-31...)を持つ。起動時にこの上限まで切り詰める(capUnlimitedKeys)
const MAX_EXPIRY_DAYS = 365;
const LEGACY_UNLIMITED_EXPIRES_AT = "9999-12-31T23:59:59.999Z";

// UTCのDateから「JSTの壁時計としての年月日」を取り出す(process.env.TZに依存させない)
const toJstWallClockParts = (date) => {
	const jst = new Date(date.getTime() + JST_OFFSET_MS);
	return {year: jst.getUTCFullYear(), month: jst.getUTCMonth(), date: jst.getUTCDate()};
};

// 「翌日02:00(JST)」に相当するUTC Dateを返す
const nextDay2amJstAsUtcDate = (now) => {
	const {year, month, date} = toJstWallClockParts(now);
	// JST 02:00 = UTC 17:00(前日) なので、UTC時刻として組んでから9時間引く
	return new Date(Date.UTC(year, month, date + 1, 2, 0, 0) - JST_OFFSET_MS);
};

/**
 * 有効期限の選択肢から実際のexpires_at(Date)を計算する。
 * TODAY(当日限り) = LEAST(now + 12時間, 翌日02:00(JST))
 */
const calculateExpiresAt = (option, now = new Date()) => {
	switch (option) {
		case EXPIRY_OPTIONS.TODAY: {
			const plus12h = new Date(now.getTime() + 12 * 60 * 60 * 1000);
			const next2am = nextDay2amJstAsUtcDate(now);
			return new Date(Math.min(plus12h.getTime(), next2am.getTime()));
		}
		case EXPIRY_OPTIONS.DAYS_30:
			return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
		case EXPIRY_OPTIONS.DAYS_90:
			return new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
		case EXPIRY_OPTIONS.DAYS_365:
			return new Date(now.getTime() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
		default:
			throw new Error(`invalid expiry option: ${option}`);
	}
};

const hashKey = (apiKey) => crypto.createHash("sha256").update(apiKey).digest("hex");

const SQL_INSERT_API_KEY = `
	INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at)
	VALUES (@id, @label, @key_hash, @role, @created_by, @created_at, @expires_at)
`;

const SQL_SELECT_ACTIVE_API_KEYS_BY_OWNER = `
	SELECT id, label, role, created_by, created_at, expires_at, last_used_at
	FROM api_keys
	WHERE revoked_at IS NULL AND created_by = ?
	ORDER BY created_at DESC
`;

const SQL_SELECT_ACTIVE_API_KEY_BY_HASH = `
	SELECT id, label, role, created_by, expires_at, notified_build FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL
`;

const SQL_TOUCH_LAST_USED = `UPDATE api_keys SET last_used_at = ? WHERE id = ?`;

// 「サーバーが更新された」と知らせたことを記録する。現在のビルドと違うときだけ知らせるため、
// これを書いた後は同じビルドの間は二度と知らせない。
// 条件に notified_build を含めるのは、同時に来た複数のリクエストで二重に知らせないため
// (両方が同じ古い値を読んだ場合、UPDATEが通るのは片方だけになる)
const SQL_MARK_NOTIFIED_BUILD = `
	UPDATE api_keys SET notified_build = ?
	WHERE id = ? AND (notified_build IS NULL OR notified_build <> ?)
`;

// 発行者本人以外は失効できないよう created_by も条件に含める
const SQL_REVOKE_API_KEY = `
	UPDATE api_keys SET revoked_at = @revoked_at
	WHERE id = @id AND created_by = @created_by AND revoked_at IS NULL
`;

module.exports.EXPIRY_OPTIONS = EXPIRY_OPTIONS;
module.exports.API_KEY_ROLES = API_KEY_ROLES;
module.exports.isValidApiKeyRole = isValidApiKeyRole;
module.exports.isValidExpiryOption = isValidExpiryOption;
module.exports.calculateExpiresAt = calculateExpiresAt;
module.exports.MAX_EXPIRY_DAYS = MAX_EXPIRY_DAYS;

/**
 * 「無期限」だった頃に発行されたキーを、現在の上限(1年)まで切り詰める。
 * 起動のたびに実行して安全(対象が無ければ何もしない)。失効済みのキーは対象外
 */
module.exports.capUnlimitedKeys = async () => {
	const cappedAt = new Date(Date.now() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const result = await ds.run(
		"UPDATE api_keys SET expires_at = ? WHERE expires_at = ? AND revoked_at IS NULL",
		[cappedAt, LEGACY_UNLIMITED_EXPIRES_AT]
	);
	if (result.changes > 0) {
		logger.warn({count: result.changes, expiresAt: cappedAt}, "無期限だったAPIキーの有効期限を1年に切り詰めました");
	}
	return result.changes;
};

/**
 * 新しいAPIキーを発行する。平文キーはこの戻り値でのみ取得可能。
 * role(readonly/readwrite)とexpiryOption(today/30d/90d/365d)は呼び出し元(server.js)で
 * 発行者の現在のロールと突き合わせた上で渡すこと。ここでは値の形式だけを検証する。
 */
module.exports.createApiKey = async (label, role, expiryOption, createdBy) => {
	if (!isValidApiKeyRole(role)) {
		throw new Error(`invalid api key role: ${role}`);
	}
	if (!isValidExpiryOption(expiryOption)) {
		throw new Error(`invalid expiry option: ${expiryOption}`);
	}
	const id = crypto.randomUUID();
	const apiKey = API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
	const now = new Date();
	const expiresAt = calculateExpiresAt(expiryOption, now);
	await ds.run(SQL_INSERT_API_KEY, {
		id,
		label,
		key_hash: hashKey(apiKey),
		role,
		created_by: createdBy,
		created_at: now.toISOString(),
		expires_at: expiresAt.toISOString()
	});
	return {id, label, role, apiKey, expiresAt: expiresAt.toISOString()};
};

/**
 * 発行者本人のAPIキーのみを返す
 */
module.exports.listApiKeys = async (ownerUserIdentifier) => ds.all(SQL_SELECT_ACTIVE_API_KEYS_BY_OWNER, [ownerUserIdentifier]);

/**
 * 発行者本人のAPIキーのみ失効できる
 */
module.exports.revokeApiKeyById = async (id, ownerUserIdentifier) => {
	const result = await ds.run(SQL_REVOKE_API_KEY, {id, created_by: ownerUserIdentifier, revoked_at: new Date().toISOString()});
	return result.changes > 0;
};

/**
 * このキーへ「サーバーが更新された」と知らせたことを記録する。
 * 実際に知らせるときだけ呼ぶため、通常のリクエストでクエリは増えない。
 * 戻り値は「このリクエストが記録できたか」= 知らせてよいかの判定に使う
 * (同時に来たリクエストのうち1本だけがtrueになる)。
 */
module.exports.markNotifiedBuild = async (id, build) => {
	try {
		const result = await ds.run(SQL_MARK_NOTIFIED_BUILD, [build, id, build]);
		return (result != null ? result.changes : 0) > 0;
	} catch (err) {
		// 知らせられなくても業務に影響は無いので、失敗しても通常処理は続ける
		logger.error(err, "::markNotifiedBuild");
		return false;
	}
};

/**
 * Authorization: Bearer <apiKey> を検証する。
 * 戻り値は {status: "ok", row} / {status: "expired"} / {status: "invalid"} のいずれか。
 * "expired"と"invalid"を区別できるようにしているのは、利用者側のデバッグを助けるため
 * (キー自体が間違っているのか、期限切れなのかで対応が変わる)。
 * 失効チェックはlast_used_atの更新より前に行う(失効キーの最終使用時刻は更新しない)。
 */
module.exports.verifyApiKey = async (apiKey) => {
	try {
		if (!apiKey || !apiKey.startsWith(API_KEY_PREFIX)) {
			return {status: "invalid"};
		}
		const row = await ds.get(SQL_SELECT_ACTIVE_API_KEY_BY_HASH, [hashKey(apiKey)]);
		if (row == null) {
			return {status: "invalid"};
		}
		if (row.expires_at <= new Date().toISOString()) {
			return {status: "expired"};
		}
		await ds.run(SQL_TOUCH_LAST_USED, [new Date().toISOString(), row.id]);
		return {status: "ok", row};
	} catch (err) {
		logger.error(err, "::verifyApiKey");
		return {status: "invalid"};
	}
};
