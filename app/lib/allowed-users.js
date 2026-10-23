/*!
 * allowed-users.js : ログイン許可ユーザー(メールアドレス)とロールの管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * EntraID/Cognitoどちらの認証プロバイダでも共通で使えるよう、
 * プロバイダのグループ機能等には依存せずアプリ側で管理する。
 *
 * ホワイトリストに登録されているメールアドレスのみログインを許可する
 * (0件の間も含めて常に閉じている)。ロールは admin(ホワイトリスト管理が可能) /
 * readwrite(文書の追加・削除・タグ編集が可能) / readonly(閲覧のみ) の3種類。
 *
 * ADMIN_EMAIL環境変数は「adminロールのユーザーが1人もいない場合」だけ働く
 * 自己修復型のブートストラップ用の踏み台で、常設の特別枠ではない。該当メール
 * アドレスでログインが試みられた時点でadminロールが1人もいなければ、自動的に
 * そのメールアドレスをadminとしてホワイトリストへ登録(または昇格)する。
 * 一度adminが存在するようになれば、以降ADMIN_EMAILによる特別扱いは発生しない
 * (ロールを外された場合等、再びadminが0人になれば再度働く)。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || "");

const ROLES = Object.freeze({
	ADMIN: "admin",
	READWRITE: "readwrite",
	READONLY: "readonly"
});
const VALID_ROLES = Object.freeze(Object.values(ROLES));

const isValidRole = (role) => VALID_ROLES.includes(role);

const SQL_INSERT_ALLOWED_USER = `
	INSERT INTO allowed_users (email, role, added_by, added_at) VALUES (@email, @role, @added_by, @added_at)
	ON CONFLICT(email) DO UPDATE SET role = excluded.role, added_by = excluded.added_by
`;
const SQL_DELETE_ALLOWED_USER = `DELETE FROM allowed_users WHERE email = ?`;
const SQL_UPDATE_ROLE = `UPDATE allowed_users SET role = ? WHERE email = ?`;
const SQL_SELECT_ALLOWED_USERS = `SELECT email, role, added_by, added_at, last_login_at FROM allowed_users ORDER BY added_at DESC`;
// 新しく足す(もう居れば何もしない。管理画面の「追加」は、居る人の権限を黙って書き換えない)
const SQL_INSERT_NEW_ALLOWED_USER = `
	INSERT INTO allowed_users (email, role, added_by, added_at) VALUES (@email, @role, @added_by, @added_at)
	ON CONFLICT(email) DO NOTHING
`;
// 最後の管理者を下げない・外さない。数えるのと変えるのを 1 つの文にする(間に別の変更が入らないように)
const SQL_UPDATE_ROLE_KEEP_ADMIN = `
	UPDATE allowed_users SET role = ? WHERE email = ?
	AND (role <> '${ROLES.ADMIN}' OR ? = '${ROLES.ADMIN}' OR (SELECT COUNT(*) FROM allowed_users WHERE role = '${ROLES.ADMIN}') > 1)
`;
const SQL_DELETE_KEEP_ADMIN = `
	DELETE FROM allowed_users WHERE email = ?
	AND (role <> '${ROLES.ADMIN}' OR (SELECT COUNT(*) FROM allowed_users WHERE role = '${ROLES.ADMIN}') > 1)
`;
const SQL_UPDATE_LAST_LOGIN = `UPDATE allowed_users SET last_login_at = ? WHERE email = ?`;
const SQL_SELECT_ALLOWED_USER_BY_EMAIL = `SELECT email, role FROM allowed_users WHERE email = ?`;
const SQL_COUNT_ADMINS = `SELECT COUNT(*) AS count FROM allowed_users WHERE role = '${ROLES.ADMIN}'`;

const SQL_UPSERT_BOOTSTRAP_ADMIN = `
	INSERT INTO allowed_users (email, role, added_by, added_at)
	VALUES (@email, '${ROLES.ADMIN}', 'system:bootstrap', @added_at)
	ON CONFLICT(email) DO UPDATE SET role = '${ROLES.ADMIN}', added_by = 'system:bootstrap'
`;

// adminロールが1人もいない場合に限り、ADMIN_EMAILをadminとして(再)登録する
const maybeBootstrapAdmin = async (normalizedEmail) => {
	if (ADMIN_EMAIL === "" || normalizedEmail !== ADMIN_EMAIL) {
		return;
	}
	if ((await ds.get(SQL_COUNT_ADMINS)).count > 0) {
		return;
	}
	await ds.run(SQL_UPSERT_BOOTSTRAP_ADMIN, {email: normalizedEmail, added_at: new Date().toISOString()});
	logger.warn({email: normalizedEmail}, "::maybeBootstrapAdmin: adminロールが不在だったためADMIN_EMAILをadminとして登録しました");
};

// 指定ユーザーの現在のロールを返す(ホワイトリスト未登録なら null)
const resolveRole = async (email) => {
	try {
		const normalized = normalizeEmail(email);
		await maybeBootstrapAdmin(normalized);
		const row = await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalized]);
		return row ? row.role : null;
	} catch (err) {
		logger.error(err, "::resolveRole");
		return null;
	}
};

module.exports.ROLES = ROLES;
module.exports.isValidRole = isValidRole;

/**
 * ログイン時の認証判定の内訳を返す(ログ出力用の診断情報)。
 * 「入力されたメールアドレス」対「ADMIN_EMAIL」「ホワイトリスト」の比較が
 * どう評価されたかを、ログインを許可/拒否するたびに確認できるようにする。
 */
module.exports.describeAccess = async (email) => {
	const normalizedEmail = normalizeEmail(email);
	const adminCountBeforeBootstrap = (await ds.get(SQL_COUNT_ADMINS)).count;
	const matchesAdminEmail = ADMIN_EMAIL !== "" && normalizedEmail === ADMIN_EMAIL;
	await maybeBootstrapAdmin(normalizedEmail);
	const row = await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalizedEmail]);
	return {
		inputEmail: email,
		normalizedEmail,
		adminEmailConfigured: ADMIN_EMAIL !== "" ? ADMIN_EMAIL : null,
		matchesAdminEmail,
		adminCountBeforeBootstrap,
		allowedUserRow: row ? {email: row.email, role: row.role} : null,
		role: row ? row.role : null
	};
};

/**
 * 指定ユーザーがログイン許可されているか判定する
 */
module.exports.isAllowed = async (email) => (await resolveRole(email)) != null;

/**
 * 指定ユーザーの現在のロールを返す(未登録なら null)
 */
module.exports.getRole = (email) => resolveRole(email);

/**
 * 指定ユーザーがadminロールかどうか判定する
 */
module.exports.isAdmin = async (email) => (await resolveRole(email)) === ROLES.ADMIN;

module.exports.addAllowedUser = async (email, role, addedBy) => {
	if (!isValidRole(role)) {
		throw new Error(`invalid role: ${role}`);
	}
	await ds.run(SQL_INSERT_ALLOWED_USER, {
		email: normalizeEmail(email),
		role,
		added_by: addedBy,
		added_at: new Date().toISOString()
	});
};

module.exports.updateAllowedUserRole = async (email, role) => {
	if (!isValidRole(role)) {
		throw new Error(`invalid role: ${role}`);
	}
	const result = await ds.run(SQL_UPDATE_ROLE, [role, normalizeEmail(email)]);
	return result.changes > 0;
};

module.exports.removeAllowedUser = async (email) => {
	const result = await ds.run(SQL_DELETE_ALLOWED_USER, [normalizeEmail(email)]);
	return result.changes > 0;
};

module.exports.listAllowedUsers = async () => ds.all(SQL_SELECT_ALLOWED_USERS);

/** 台帳の 1 行(無ければ null) */
module.exports.find = async (email) => (await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalizeEmail(email)])) ?? null;

module.exports.normalizeEmail = normalizeEmail;

/**
 * 新しく台帳に足す(管理画面の「追加」)。
 * @returns {Promise<"added"|"exists">}
 */
module.exports.addNew = async (email, role, addedBy) => {
	if (!isValidRole(role)) throw new Error(`invalid role: ${role}`);
	const result = await ds.run(SQL_INSERT_NEW_ALLOWED_USER, {email: normalizeEmail(email), role, added_by: addedBy, added_at: new Date().toISOString()});
	return result.changes > 0 ? "added" : "exists";
};

/**
 * 権限を変える。最後の管理者は下げない。
 * @returns {Promise<{status: "changed"|"not_found"|"last_admin", previousRole?: string}>}
 */
module.exports.changeRole = async (email, role) => {
	if (!isValidRole(role)) throw new Error(`invalid role: ${role}`);
	const normalized = normalizeEmail(email);
	const before = await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalized]);
	if (before == null) return {status: "not_found"};
	const result = await ds.run(SQL_UPDATE_ROLE_KEEP_ADMIN, [role, normalized, role]);
	if (result.changes > 0) return {status: "changed", previousRole: before.role};
	return (await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalized])) == null ? {status: "not_found"} : {status: "last_admin"};
};

/**
 * 台帳から外す。最後の管理者は外さない。
 * @returns {Promise<{status: "removed"|"not_found"|"last_admin", previousRole?: string}>}
 */
module.exports.remove = async (email) => {
	const normalized = normalizeEmail(email);
	const before = await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalized]);
	if (before == null) return {status: "not_found"};
	const result = await ds.run(SQL_DELETE_KEEP_ADMIN, [normalized]);
	if (result.changes > 0) return {status: "removed", previousRole: before.role};
	return (await ds.get(SQL_SELECT_ALLOWED_USER_BY_EMAIL, [normalized])) == null ? {status: "not_found"} : {status: "last_admin"};
};

/** ログインした時刻を残す(管理画面の利用者の一覧に出す)。失敗してもログインは止めない */
module.exports.recordLogin = async (email, at = new Date().toISOString()) => {
	try {
		await ds.run(SQL_UPDATE_LAST_LOGIN, [at, normalizeEmail(email)]);
	} catch (err) {
		logger.error(err, "::recordLogin");
	}
};
