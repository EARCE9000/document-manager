/*!
 * audit-log.js : ユーザー自身の操作履歴の記録・参照
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 標準出力の監査ログ("msg":"audit")とは別に、ユーザーが画面から
 * 「自分が何をしたか」を後から確認できるようDBにも残す。
 * 対象(文書・プロジェクト)が後から削除・アーカイブされても履歴自体は読めるよう、
 * entry_file/project_nameは記録時点の値をスナップショットとして保存する。
 */

const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const HISTORY_RETENTION_DAYS = 30;
const HISTORY_MAX_ROWS = 500;

const INSERT_AUDIT_LOG = `
	INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at, target_user, detail)
	VALUES (@id, @user_identifier, @action, @document_id, @entry_file, @project_id, @project_name, @created_at, @target_user, @detail)
`;

// 「人」が対象の操作(セッションの切断)。本人向けの履歴には混ぜず、管理画面で別に見せる
// (本人向けの画面は文書・プロジェクトの操作を並べる前提で作ってある)
const ACTION_SESSION_REVOKE = "session_revoke";

const SELECT_MY_AUDIT_LOG = `
	SELECT id, action, document_id, entry_file, project_id, project_name, created_at
	FROM audit_log
	WHERE user_identifier = ? AND created_at >= ? AND action <> '${ACTION_SESSION_REVOKE}'
	ORDER BY created_at DESC
	LIMIT ?
`;

const SELECT_SESSION_REVOKES = `
	SELECT id, user_identifier, target_user, detail, created_at
	FROM audit_log
	WHERE action = '${ACTION_SESSION_REVOKE}'
	ORDER BY created_at DESC
	LIMIT ?
`;
const SESSION_REVOKE_MAX_ROWS = 200;

/**
 * 操作履歴を1件記録する。呼び出し元(server.js)は標準出力への監査ログ出力と
 * このrecordを両方呼ぶこと(役割が異なるため一本化はしない。標準出力側は
 * サーバー運用者向け、こちらは利用者本人向けの画面表示用)。
 * 記録失敗で本処理を失敗させたくないため内部でエラーを握りつぶす(=呼び出し側は
 * await 不要のfire-and-forgetでよい。rejectしないためunhandled rejectionにもならない)
 */
module.exports.record = async ({userIdentifier, action, documentId = null, entryFile = null, projectId = null, projectName = null, targetUser = null, detail = null}) => {
	try {
		await ds.run(INSERT_AUDIT_LOG, {
			id: crypto.randomUUID(),
			user_identifier: userIdentifier,
			action,
			document_id: documentId,
			entry_file: entryFile,
			project_id: projectId,
			project_name: projectName,
			created_at: new Date().toISOString(),
			target_user: targetUser,
			detail: detail == null ? null : JSON.stringify(detail)
		});
	} catch (err) {
		logger.error(err, "::record");
	}
};

module.exports.ACTION_SESSION_REVOKE = ACTION_SESSION_REVOKE;

/**
 * セッションの切断の履歴(管理者向け。新しい順)。
 * 行は消していないので、古いものも残っている。画面に出すのは直近の分だけ
 */
module.exports.listSessionRevokes = async () => {
	const rows = await ds.all(SELECT_SESSION_REVOKES, [SESSION_REVOKE_MAX_ROWS]);
	return rows.map((row) => {
		let detail = {};
		try {
			detail = JSON.parse(row.detail || "{}");
		} catch (err) {
			// 読めなくても、誰がいつ誰を切ったかは出せる
		}
		return {
			id: row.id,
			at: row.created_at,
			by: row.user_identifier,
			targetUser: row.target_user,
			sessions: detail.sessions ?? null,
			apiKeys: detail.apiKeys ?? null,
			sessionDetails: Array.isArray(detail.sessionDetails) ? detail.sessionDetails : []
		};
	});
};

/**
 * 呼び出したユーザー自身の直近の操作履歴を返す(既定で直近30日・最大500件)
 */
module.exports.listMine = async (userIdentifier) => {
	const since = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const rows = await ds.all(SELECT_MY_AUDIT_LOG, [userIdentifier, since, HISTORY_MAX_ROWS]);
	return rows.map((row) => ({
		id: row.id,
		action: row.action,
		documentId: row.document_id,
		entryFile: row.entry_file,
		projectId: row.project_id,
		projectName: row.project_name,
		createdAt: row.created_at
	}));
};
