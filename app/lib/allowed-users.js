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
const db = require("./db.js");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || "");

const ROLES = Object.freeze({
	ADMIN: "admin",
	READWRITE: "readwrite",
	READONLY: "readonly"
});
const VALID_ROLES = Object.freeze(Object.values(ROLES));

const isValidRole = (role) => VALID_ROLES.includes(role);

const insertAllowedUser = db.prepare(`
	INSERT INTO allowed_users (email, role, added_by, added_at) VALUES (@email, @role, @added_by, @added_at)
	ON CONFLICT(email) DO UPDATE SET role = excluded.role, added_by = excluded.added_by
`);
const deleteAllowedUser = db.prepare(`DELETE FROM allowed_users WHERE email = ?`);
const updateRole = db.prepare(`UPDATE allowed_users SET role = ? WHERE email = ?`);
const selectAllowedUsers = db.prepare(`SELECT email, role, added_by, added_at FROM allowed_users ORDER BY added_at DESC`);
const selectAllowedUserByEmail = db.prepare(`SELECT email, role FROM allowed_users WHERE email = ?`);
const countAdmins = db.prepare(`SELECT COUNT(*) AS count FROM allowed_users WHERE role = '${ROLES.ADMIN}'`);

const upsertBootstrapAdmin = db.prepare(`
	INSERT INTO allowed_users (email, role, added_by, added_at)
	VALUES (@email, '${ROLES.ADMIN}', 'system:bootstrap', @added_at)
	ON CONFLICT(email) DO UPDATE SET role = '${ROLES.ADMIN}', added_by = 'system:bootstrap'
`);

// adminロールが1人もいない場合に限り、ADMIN_EMAILをadminとして(再)登録する
const maybeBootstrapAdmin = (normalizedEmail) => {
	if (ADMIN_EMAIL === "" || normalizedEmail !== ADMIN_EMAIL) {
		return;
	}
	if (countAdmins.get().count > 0) {
		return;
	}
	upsertBootstrapAdmin.run({email: normalizedEmail, added_at: new Date().toISOString()});
	logger.warn({email: normalizedEmail}, "::maybeBootstrapAdmin: adminロールが不在だったためADMIN_EMAILをadminとして登録しました");
};

// 指定ユーザーの現在のロールを返す(ホワイトリスト未登録なら null)
const resolveRole = (email) => {
	try {
		const normalized = normalizeEmail(email);
		maybeBootstrapAdmin(normalized);
		const row = selectAllowedUserByEmail.get(normalized);
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
module.exports.describeAccess = (email) => {
	const normalizedEmail = normalizeEmail(email);
	const adminCountBeforeBootstrap = countAdmins.get().count;
	const matchesAdminEmail = ADMIN_EMAIL !== "" && normalizedEmail === ADMIN_EMAIL;
	maybeBootstrapAdmin(normalizedEmail);
	const row = selectAllowedUserByEmail.get(normalizedEmail);
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
module.exports.isAllowed = (email) => resolveRole(email) != null;

/**
 * 指定ユーザーの現在のロールを返す(未登録なら null)
 */
module.exports.getRole = (email) => resolveRole(email);

/**
 * 指定ユーザーがadminロールかどうか判定する
 */
module.exports.isAdmin = (email) => resolveRole(email) === ROLES.ADMIN;

module.exports.addAllowedUser = (email, role, addedBy) => {
	if (!isValidRole(role)) {
		throw new Error(`invalid role: ${role}`);
	}
	insertAllowedUser.run({
		email: normalizeEmail(email),
		role,
		added_by: addedBy,
		added_at: new Date().toISOString()
	});
};

module.exports.updateAllowedUserRole = (email, role) => {
	if (!isValidRole(role)) {
		throw new Error(`invalid role: ${role}`);
	}
	const result = updateRole.run(role, normalizeEmail(email));
	return result.changes > 0;
};

module.exports.removeAllowedUser = (email) => {
	const result = deleteAllowedUser.run(normalizeEmail(email));
	return result.changes > 0;
};

module.exports.listAllowedUsers = () => selectAllowedUsers.all();
