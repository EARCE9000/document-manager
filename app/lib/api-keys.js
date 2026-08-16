/*!
 * api-keys.js : マシン間認証用 APIキー管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ブラウザの対話的ログイン(OAuth2)とは別に、Claude Desktop 等のクライアントが
 * api を直接叩けるようにするための Bearer トークン認証。
 * 平文キーはDBに保存せず、sha256ハッシュのみを保存する(発行時に一度だけ平文を返す)。
 *
 * キーは「貼った先に平文で残る」運用を前提に、必ず有効期限を持ち(無期限キーは発行不可)、
 * 権限もキー発行時に選んだロール(readonly/readwrite。adminキーは発行不可)に固定される。
 * 発行者本人のロールが後から変わっても、既存キーのロードには影響しない
 * (権限判定は常に「キーに記録されたrole」を見る。発行者自身がホワイトリストから
 * 外れた場合のみ、別途requireAuth側でログイン不可=キーも無効として扱う)。
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const db = require("./db.js");
const AllowedUsers = require("./allowed-users.js");

const API_KEY_PREFIX = "dm_";
const API_KEY_ROLES = Object.freeze([AllowedUsers.ROLES.READONLY, AllowedUsers.ROLES.READWRITE]);
const isValidApiKeyRole = (role) => API_KEY_ROLES.includes(role);

const EXPIRY_OPTIONS = Object.freeze({
	TODAY: "today",
	DAYS_30: "30d",
	DAYS_90: "90d"
});
const isValidExpiryOption = (option) => Object.values(EXPIRY_OPTIONS).includes(option);

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
		default:
			throw new Error(`invalid expiry option: ${option}`);
	}
};

const hashKey = (apiKey) => crypto.createHash("sha256").update(apiKey).digest("hex");

const insertApiKey = db.prepare(`
	INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at)
	VALUES (@id, @label, @key_hash, @role, @created_by, @created_at, @expires_at)
`);

const selectActiveApiKeysByOwner = db.prepare(`
	SELECT id, label, role, created_by, created_at, expires_at, last_used_at
	FROM api_keys
	WHERE revoked_at IS NULL AND created_by = ?
	ORDER BY created_at DESC
`);

const selectActiveApiKeyByHash = db.prepare(`
	SELECT id, label, role, created_by, expires_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL
`);

const touchLastUsed = db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`);

// 発行者本人以外は失効できないよう created_by も条件に含める
const revokeApiKey = db.prepare(`
	UPDATE api_keys SET revoked_at = @revoked_at
	WHERE id = @id AND created_by = @created_by AND revoked_at IS NULL
`);

module.exports.EXPIRY_OPTIONS = EXPIRY_OPTIONS;
module.exports.API_KEY_ROLES = API_KEY_ROLES;
module.exports.isValidApiKeyRole = isValidApiKeyRole;
module.exports.isValidExpiryOption = isValidExpiryOption;
module.exports.calculateExpiresAt = calculateExpiresAt;

/**
 * 新しいAPIキーを発行する。平文キーはこの戻り値でのみ取得可能。
 * role(readonly/readwrite)とexpiryOption(today/30d/90d)は呼び出し元(server.js)で
 * 発行者の現在のロールと突き合わせた上で渡すこと。ここでは値の形式だけを検証する。
 */
module.exports.createApiKey = (label, role, expiryOption, createdBy) => {
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
	insertApiKey.run({
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
module.exports.listApiKeys = (ownerUserIdentifier) => selectActiveApiKeysByOwner.all(ownerUserIdentifier);

/**
 * 発行者本人のAPIキーのみ失効できる
 */
module.exports.revokeApiKeyById = (id, ownerUserIdentifier) => {
	const result = revokeApiKey.run({id, created_by: ownerUserIdentifier, revoked_at: new Date().toISOString()});
	return result.changes > 0;
};

/**
 * Authorization: Bearer <apiKey> を検証する。
 * 戻り値は {status: "ok", row} / {status: "expired"} / {status: "invalid"} のいずれか。
 * "expired"と"invalid"を区別できるようにしているのは、利用者側のデバッグを助けるため
 * (キー自体が間違っているのか、期限切れなのかで対応が変わる)。
 * 失効チェックはlast_used_atの更新より前に行う(失効キーの最終使用時刻は更新しない)。
 */
module.exports.verifyApiKey = (apiKey) => {
	try {
		if (!apiKey || !apiKey.startsWith(API_KEY_PREFIX)) {
			return {status: "invalid"};
		}
		const row = selectActiveApiKeyByHash.get(hashKey(apiKey));
		if (row == null) {
			return {status: "invalid"};
		}
		if (row.expires_at <= new Date().toISOString()) {
			return {status: "expired"};
		}
		touchLastUsed.run(new Date().toISOString(), row.id);
		return {status: "ok", row};
	} catch (err) {
		logger.error(err, "::verifyApiKey");
		return {status: "invalid"};
	}
};
