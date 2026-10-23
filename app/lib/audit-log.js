/*!
 * audit-log.js : 操作の記録(監査ログ)。本人の操作履歴と、管理画面の監査ログ(全員ぶん)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 標準出力の監査ログ("msg":"audit")とは別に、ユーザーが画面から
 * 「自分が何をしたか」を後から確認できるようDBにも残す。
 * 対象(文書・プロジェクト)が後から削除・アーカイブされても履歴自体は読めるよう、
 * entry_file/project_nameは記録時点の値をスナップショットとして保存する。
 *
 * 管理画面の監査ログ(共通アーキテクチャ 構成 6.4 の GET webapi/admin/audit)も、同じ表から読む。
 * そのために、結果(success / denied / failed)・経路(screen / apikey)・APIキーの権限・接続元の IP も残す
 * (この列を足す前の行は、結果を success、経路と IP を不明として返す)。
 */

const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const HISTORY_RETENTION_DAYS = 30;
const HISTORY_MAX_ROWS = 500;

const INSERT_AUDIT_LOG = `
	INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at, target_user, detail, target, result, via, key_role, ip)
	VALUES (@id, @user_identifier, @action, @document_id, @entry_file, @project_id, @project_name, @created_at, @target_user, @detail, @target, @result, @via, @key_role, @ip)
`;

/** 結果の種類(管理画面の監査ログ) */
const RESULTS = Object.freeze({SUCCESS: "success", DENIED: "denied", FAILED: "failed"});

/**
 * 操作の名前と、管理画面に出す名前。ここに無い操作も記録はできる(画面には名前のまま出る)
 * 並びは、管理画面の「操作」の選択肢の順
 */
const ACTION_LABELS = Object.freeze({
	login: "ログイン",
	upload: "登録",
	supersede: "新しい版で置換",
	delete: "アーカイブ",
	restore: "復元",
	project_assign: "プロジェクトへ登録",
	project_unassign: "プロジェクトから解除",
	link_documents: "関連づけ",
	unlink_documents: "関連づけの解除",
	link_version: "版のつなぎ",
	unlink_version: "版のつなぎの解除",
	alias_move: "別名の付け替え",
	mockup_upload: "モックアップの登録",
	mockup_archive: "モックアップのアーカイブ",
	mockup_restore: "モックアップの復元",
	reconcile_restore: "照合で見つけたファイルの登録",
	user_add: "利用者の追加",
	user_role: "権限の変更",
	user_remove: "利用者の削除",
	session_revoke: "利用者の切断",
	feature_toggle: "機能の切り替え",
	rate_limit: "回数の上限の変更",
	db_integrity: "DB の整合性の確認",
	vector_settings: "意味検索の設定",
	miro_settings: "Miro 連携の設定",
	access_denied: "権限のない操作"
});

// 本人の操作履歴(api/history)に並べる操作。管理の操作や、あとから記録し始めた操作は混ぜない
// (本人向けの画面は文書・プロジェクトの操作を並べる前提で作ってある)
const MY_HISTORY_ACTIONS = Object.freeze(["upload", "delete", "restore", "project_assign", "project_unassign", "supersede"]);

// 管理画面の監査ログ: 1 回に返す件数と、選べる期間
const AUDIT_PAGE_SIZE = 100;
const AUDIT_RANGES = Object.freeze({"1d": 1, "7d": 7, "30d": 30});
const AUDIT_FILTER_MAX_LENGTH = 200;

// 「人」が対象の操作(セッションの切断)。本人向けの履歴には混ぜず、管理画面で別に見せる
// (本人向けの画面は文書・プロジェクトの操作を並べる前提で作ってある)
const ACTION_SESSION_REVOKE = "session_revoke";

const SELECT_MY_AUDIT_LOG = `
	SELECT id, action, document_id, entry_file, project_id, project_name, created_at
	FROM audit_log
	WHERE user_identifier = ? AND created_at >= ? AND action IN (${MY_HISTORY_ACTIONS.map((action) => `'${action}'`).join(", ")})
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
module.exports.record = async ({userIdentifier, action, documentId = null, entryFile = null, projectId = null, projectName = null, targetUser = null, detail = null,
	target = null, result = RESULTS.SUCCESS, via = null, keyRole = null, ip = null}) => {
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
			detail: detail == null ? null : JSON.stringify(detail),
			target: target == null ? null : String(target).slice(0, 1000),
			result,
			via,
			key_role: keyRole,
			ip
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

module.exports.RESULTS = RESULTS;
module.exports.ACTION_LABELS = ACTION_LABELS;
module.exports.AUDIT_PAGE_SIZE = AUDIT_PAGE_SIZE;
module.exports.AUDIT_RANGES = AUDIT_RANGES;

/** LIKE の部分一致に使う値(\ と % と _ を、そのままの文字として扱う) */
const likeValue = (text) => `%${String(text).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** 行に出す「対象」。対象の名前 → 人 → 文書(とプロジェクト)→ プロジェクト → 文書 ID の順に、ある物を使う */
const targetOf = (row) => {
	if (row.target != null && row.target !== "") return row.target;
	if (row.target_user != null) return row.target_user;
	if (row.entry_file != null) return row.project_name != null ? `${row.entry_file} → ${row.project_name}` : row.entry_file;
	if (row.project_name != null) return row.project_name;
	return row.document_id ?? row.project_id ?? null;
};

/**
 * 管理画面の監査ログ(全員ぶん。新しい順)。
 * @param {{range?: string, user?: string, action?: string, target?: string, before?: string, now?: number}} query
 *   range は 1d / 7d / 30d(既定 7d。1d は直前の 24 時間)。user・target は部分一致(大文字と小文字は区別しない)、action は一致。
 *   before は前の応答の nextBefore(その行より古い物を返す)
 * @returns {Promise<{entries: object[], nextBefore: string|null, range: string}>}
 *   形が正しくない絞り込みは Error(status 400)
 */
module.exports.listAll = async ({range = "7d", user = "", action = "", target = "", before = "", now = Date.now()} = {}) => {
	const days = AUDIT_RANGES[range];
	if (days == null) throw Object.assign(new Error(`range は ${Object.keys(AUDIT_RANGES).join(" / ")} のどれかです`), {status: 400});
	for (const [name, value] of Object.entries({user, action, target, before})) {
		if (typeof value !== "string" || value.length > AUDIT_FILTER_MAX_LENGTH) {
			throw Object.assign(new Error(`${name} は ${AUDIT_FILTER_MAX_LENGTH} 文字までの 1 つの値で指定してください`), {status: 400});
		}
	}
	const where = ["created_at >= ?"];
	const params = [new Date(now - days * 24 * 60 * 60 * 1000).toISOString()];
	if (user.trim() !== "") {
		where.push("LOWER(user_identifier) LIKE ? ESCAPE '\\'");
		params.push(likeValue(user.trim()));
	}
	if (action.trim() !== "") {
		where.push("action = ?");
		params.push(action.trim());
	}
	if (target.trim() !== "") {
		const fields = ["target", "target_user", "entry_file", "project_name", "document_id", "project_id"];
		where.push(`(${fields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
		for (let i = 0; i < fields.length; i += 1) params.push(likeValue(target.trim()));
	}
	if (before !== "") {
		// 続きの目印は「日時|ID」。同じ日時の行があっても、取りこぼさず、重ねない
		const at = before.split("|")[0];
		const id = before.slice(at.length + 1);
		where.push("(created_at < ? OR (created_at = ? AND id < ?))");
		params.push(at, at, id);
	}
	params.push(AUDIT_PAGE_SIZE + 1);
	const rows = await ds.all(`
		SELECT id, user_identifier, action, document_id, entry_file, project_id, project_name, target_user, target, result, via, key_role, ip, created_at
		FROM audit_log
		WHERE ${where.join(" AND ")}
		ORDER BY created_at DESC, id DESC
		LIMIT ?
	`, params);
	const page = rows.slice(0, AUDIT_PAGE_SIZE);
	const last = page[page.length - 1];
	return {
		range,
		entries: page.map((row) => ({
			id: row.id,
			at: row.created_at,
			user: row.user_identifier,
			action: row.action,
			target: targetOf(row),
			// この列を足す前の行は、成功した操作だけを残していた
			result: row.result ?? RESULTS.SUCCESS,
			via: row.via ?? null,
			keyRole: row.key_role ?? null,
			ip: row.ip ?? null
		})),
		nextBefore: rows.length > AUDIT_PAGE_SIZE ? `${last.created_at}|${last.id}` : null
	};
};
