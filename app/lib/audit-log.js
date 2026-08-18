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
const db = require("./db.js");

const HISTORY_RETENTION_DAYS = 30;
const HISTORY_MAX_ROWS = 500;

const insertAuditLog = db.prepare(`
	INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at)
	VALUES (@id, @user_identifier, @action, @document_id, @entry_file, @project_id, @project_name, @created_at)
`);

const selectMyAuditLog = db.prepare(`
	SELECT id, action, document_id, entry_file, project_id, project_name, created_at
	FROM audit_log
	WHERE user_identifier = ? AND created_at >= ?
	ORDER BY created_at DESC
	LIMIT ?
`);

/**
 * 操作履歴を1件記録する。呼び出し元(server.js)は標準出力への監査ログ出力と
 * このrecordを両方呼ぶこと(役割が異なるため一本化はしない。標準出力側は
 * サーバー運用者向け、こちらは利用者本人向けの画面表示用)
 */
module.exports.record = ({userIdentifier, action, documentId = null, entryFile = null, projectId = null, projectName = null}) => {
	try {
		insertAuditLog.run({
			id: crypto.randomUUID(),
			user_identifier: userIdentifier,
			action,
			document_id: documentId,
			entry_file: entryFile,
			project_id: projectId,
			project_name: projectName,
			created_at: new Date().toISOString()
		});
	} catch (err) {
		// 履歴記録の失敗で本処理(アップロード等)を失敗させたくないため、ここで握りつぶす
		logger.error(err, "::record");
	}
};

/**
 * 呼び出したユーザー自身の直近の操作履歴を返す(既定で直近30日・最大500件)
 */
module.exports.listMine = (userIdentifier) => {
	const since = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	return selectMyAuditLog.all(userIdentifier, since, HISTORY_MAX_ROWS).map((row) => ({
		id: row.id,
		action: row.action,
		documentId: row.document_id,
		entryFile: row.entry_file,
		projectId: row.project_id,
		projectName: row.project_name,
		createdAt: row.created_at
	}));
};
