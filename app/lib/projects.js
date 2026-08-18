/*!
 * projects.js : プロジェクト(資料をフォルダ階層で整理する単位)の管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 1文書は複数のプロジェクトに登録できるが、1プロジェクト内では1箇所
 * (あるフォルダ、またはNULL=プロジェクト直下)にしか置けない。
 * フォルダ内の並び順はproject_documents.sort_orderで制御する。
 */

const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js")(path.basename(__filename));
const db = require("./db.js");

const PROJECT_COLUMNS = "id, name, created_by, created_at, sort_order, archived_by, archived_at, locked";
const selectProjects = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE archived_at IS NULL ORDER BY sort_order ASC, created_at ASC`);
const selectArchivedProjects = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`);
const selectProjectById = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`);
const insertProject = db.prepare(`
	INSERT INTO projects (id, name, created_by, created_at, sort_order)
	VALUES (@id, @name, @created_by, @created_at, @sort_order)
`);
const updateProjectName = db.prepare(`UPDATE projects SET name = ? WHERE id = ?`);
const archiveProjectRow = db.prepare(`UPDATE projects SET archived_by = ?, archived_at = ? WHERE id = ? AND archived_at IS NULL`);
const restoreProjectRow = db.prepare(`UPDATE projects SET archived_by = NULL, archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL`);
const updateProjectLocked = db.prepare(`UPDATE projects SET locked = ? WHERE id = ?`);
const deleteProjectRow = db.prepare(`DELETE FROM projects WHERE id = ?`);
const deleteFoldersByProject = db.prepare(`DELETE FROM project_folders WHERE project_id = ?`);
const deleteDocumentsByProject = db.prepare(`DELETE FROM project_documents WHERE project_id = ?`);
const selectMaxProjectSortOrder = db.prepare(`SELECT MAX(sort_order) AS maxOrder FROM projects`);

const selectFoldersByProject = db.prepare(`
	SELECT id, project_id, parent_folder_id, name, sort_order, created_by, created_at
	FROM project_folders WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC
`);
const selectFolderById = db.prepare(`SELECT id, project_id, parent_folder_id, name FROM project_folders WHERE id = ? AND project_id = ?`);
const insertFolder = db.prepare(`
	INSERT INTO project_folders (id, project_id, parent_folder_id, name, sort_order, created_by, created_at)
	VALUES (@id, @project_id, @parent_folder_id, @name, @sort_order, @created_by, @created_at)
`);
const updateFolderName = db.prepare(`UPDATE project_folders SET name = ? WHERE id = ? AND project_id = ?`);
const deleteFolderRow = db.prepare(`DELETE FROM project_folders WHERE id = ? AND project_id = ?`);
const countSubfolders = db.prepare(`SELECT COUNT(*) AS c FROM project_folders WHERE parent_folder_id = ?`);
const countDocumentsInFolder = db.prepare(`SELECT COUNT(*) AS c FROM project_documents WHERE project_id = ? AND folder_id = ?`);
const selectMaxFolderSortOrder = db.prepare(`
	SELECT MAX(sort_order) AS maxOrder FROM project_folders WHERE project_id = ? AND parent_folder_id IS ?
`);

// documentsとLEFT JOINしてプレビューに必要な情報も一緒に返す。文書がアーカイブ(論理削除)されて
// いても、ツリー側でファイル名の表示だけでなくプレビュー表示までできるようにするため
// (document_idしか持たないと、通常の文書一覧APIにはアーカイブ済み文書が含まれないため解決できない)
const selectDocumentsByProject = db.prepare(`
	SELECT pd.project_id AS project_id, pd.document_id AS document_id, pd.folder_id AS folder_id,
		pd.sort_order AS sort_order, pd.added_by AS added_by, pd.added_at AS added_at,
		d.entry_file AS entry_file, d.preview_file AS preview_file, d.memo AS memo,
		d.uploaded_by AS uploaded_by, d.uploaded_at AS uploaded_at, d.deleted_at AS deleted_at
	FROM project_documents pd
	LEFT JOIN documents d ON d.id = pd.document_id
	WHERE pd.project_id = ? ORDER BY pd.folder_id ASC, pd.sort_order ASC
`);
const selectPlacement = db.prepare(`SELECT project_id, document_id, folder_id, sort_order FROM project_documents WHERE project_id = ? AND document_id = ?`);
const upsertPlacement = db.prepare(`
	INSERT INTO project_documents (project_id, document_id, folder_id, sort_order, added_by, added_at)
	VALUES (@project_id, @document_id, @folder_id, @sort_order, @added_by, @added_at)
	ON CONFLICT(project_id, document_id) DO UPDATE SET folder_id = excluded.folder_id, sort_order = excluded.sort_order
`);
const deletePlacement = db.prepare(`DELETE FROM project_documents WHERE project_id = ? AND document_id = ?`);
const selectMaxDocumentSortOrder = db.prepare(`
	SELECT MAX(sort_order) AS maxOrder FROM project_documents WHERE project_id = ? AND folder_id IS ?
`);
const updateDocumentSortOrder = db.prepare(`UPDATE project_documents SET sort_order = ? WHERE project_id = ? AND document_id = ?`);

const toProjectResponse = (row) => ({
	id: row.id,
	name: row.name,
	createdBy: row.created_by,
	createdAt: row.created_at,
	sortOrder: row.sort_order,
	archivedBy: row.archived_by,
	archivedAt: row.archived_at,
	locked: row.locked === 1
});

const toFolderResponse = (row) => ({
	id: row.id,
	projectId: row.project_id,
	parentFolderId: row.parent_folder_id,
	name: row.name,
	sortOrder: row.sort_order,
	createdBy: row.created_by,
	createdAt: row.created_at
});

const toDocumentPlacementResponse = (row) => ({
	documentId: row.document_id,
	folderId: row.folder_id,
	sortOrder: row.sort_order,
	addedBy: row.added_by,
	addedAt: row.added_at,
	entryFile: row.entry_file ?? null,
	previewFile: row.preview_file ?? null,
	memo: row.memo ?? null,
	uploadedBy: row.uploaded_by ?? null,
	modified: row.uploaded_at ?? null,
	archived: row.deleted_at != null
});

module.exports.listProjects = () => selectProjects.all().map(toProjectResponse);
module.exports.listArchivedProjects = () => selectArchivedProjects.all().map(toProjectResponse);

module.exports.getProject = (id) => {
	const row = selectProjectById.get(id);
	return row ? toProjectResponse(row) : null;
};

// プロジェクトをアーカイブする(論理的な非表示化。フォルダ構成・登録情報はそのまま保持され、
// 「元に戻す」で復元できる。完全削除はdeleteProjectで行う別操作)
module.exports.archiveProject = (id, archivedBy) => {
	const result = archiveProjectRow.run(archivedBy, new Date().toISOString(), id);
	return result.changes > 0;
};

module.exports.restoreProject = (id) => {
	const result = restoreProjectRow.run(id);
	return result.changes > 0;
};

/**
 * プロジェクトの施錠/解錠を切り替える。全利用者で共有される状態で、排他制御ではない
 * (解錠中は書き込み権限を持つ誰でも編集できる)。タイムアウトによる自動施錠はせず、
 * 明示的にlockされるまで解錠状態を維持する
 */
module.exports.setProjectLocked = (id, locked) => {
	const result = updateProjectLocked.run(locked ? 1 : 0, id);
	return result.changes > 0;
};

module.exports.createProject = (name, createdBy) => {
	const trimmed = String(name || "").trim();
	if (trimmed === "") {
		throw new Error("project name is required");
	}
	const id = crypto.randomUUID();
	const nextOrder = (selectMaxProjectSortOrder.get().maxOrder ?? -1) + 1;
	insertProject.run({
		id,
		name: trimmed,
		created_by: createdBy,
		created_at: new Date().toISOString(),
		sort_order: nextOrder
	});
	return module.exports.getProject(id);
};

module.exports.renameProject = (id, name) => {
	const trimmed = String(name || "").trim();
	if (trimmed === "") {
		throw new Error("project name is required");
	}
	const result = updateProjectName.run(trimmed, id);
	return result.changes > 0;
};

// プロジェクトを削除する(フォルダ・登録もまとめて削除するが、文書自体は消えない)
const deleteProjectTx = db.transaction((id) => {
	deleteDocumentsByProject.run(id);
	deleteFoldersByProject.run(id);
	const result = deleteProjectRow.run(id);
	return result.changes > 0;
});
module.exports.deleteProject = (id) => {
	try {
		return deleteProjectTx(id);
	} catch (err) {
		logger.error(err, "::deleteProject");
		throw err;
	}
};

/**
 * プロジェクトのツリー(フォルダ一覧 + 文書の配置一覧)を返す。
 * 文書自体のメタ情報(ファイル名等)は含まない(呼び出し側で /api/documents の結果と
 * documentIdを突き合わせる想定)
 */
module.exports.getProjectTree = (projectId) => ({
	folders: selectFoldersByProject.all(projectId).map(toFolderResponse),
	documents: selectDocumentsByProject.all(projectId).map(toDocumentPlacementResponse)
});

module.exports.createFolder = (projectId, name, parentFolderId, createdBy) => {
	const trimmed = String(name || "").trim();
	if (trimmed === "") {
		throw new Error("folder name is required");
	}
	if (parentFolderId != null && selectFolderById.get(parentFolderId, projectId) == null) {
		throw new Error("parent folder not found");
	}
	const id = crypto.randomUUID();
	const nextOrder = (selectMaxFolderSortOrder.get(projectId, parentFolderId).maxOrder ?? -1) + 1;
	insertFolder.run({
		id,
		project_id: projectId,
		parent_folder_id: parentFolderId ?? null,
		name: trimmed,
		sort_order: nextOrder,
		created_by: createdBy,
		created_at: new Date().toISOString()
	});
	return toFolderResponse(selectFolderById.get(id, projectId));
};

module.exports.renameFolder = (projectId, folderId, name) => {
	const trimmed = String(name || "").trim();
	if (trimmed === "") {
		throw new Error("folder name is required");
	}
	const result = updateFolderName.run(trimmed, folderId, projectId);
	return result.changes > 0;
};

/**
 * フォルダを削除する。サブフォルダまたは文書が入っている場合は削除できない
 * (誤操作防止。まず中身を空にしてもらう)
 * 戻り値: "deleted" | "not_found" | "not_empty"
 */
module.exports.deleteFolder = (projectId, folderId) => {
	if (selectFolderById.get(folderId, projectId) == null) {
		return "not_found";
	}
	if (countSubfolders.get(folderId).c > 0 || countDocumentsInFolder.get(projectId, folderId).c > 0) {
		return "not_empty";
	}
	deleteFolderRow.run(folderId, projectId);
	return "deleted";
};

/**
 * 文書をプロジェクトの指定フォルダ(またはプロジェクト直下 = folderId未指定)へ登録/移動する。
 * 既に別の場所にあった場合は移動として扱う(project_id+document_idがPRIMARY KEYのため)。
 * 並び順は移動先の末尾に追加する
 */
module.exports.placeDocument = (projectId, documentId, folderId, addedBy) => {
	if (folderId != null && selectFolderById.get(folderId, projectId) == null) {
		throw new Error("folder not found");
	}
	const nextOrder = (selectMaxDocumentSortOrder.get(projectId, folderId ?? null).maxOrder ?? -1) + 1;
	upsertPlacement.run({
		project_id: projectId,
		document_id: documentId,
		folder_id: folderId ?? null,
		sort_order: nextOrder,
		added_by: addedBy,
		added_at: new Date().toISOString()
	});
	return toDocumentPlacementResponse(selectPlacement.get(projectId, documentId));
};

module.exports.removeDocument = (projectId, documentId) => {
	const result = deletePlacement.run(projectId, documentId);
	return result.changes > 0;
};

/**
 * 1つのフォルダ(またはプロジェクト直下)内の文書の並び順を、渡された順番の通りに
 * 一括で書き換える(ドラッグによる並び替え用)。安全のため、指定されたdocumentIdが
 * 実際にそのproject+folderに属していないものはすべて無視する
 */
const reorderDocumentsTx = db.transaction((projectId, folderId, documentIds) => {
	const current = selectDocumentsByProject.all(projectId).filter((row) => row.folder_id === (folderId ?? null));
	const currentIds = new Set(current.map((row) => row.document_id));
	let index = 0;
	for (const documentId of documentIds) {
		if (!currentIds.has(documentId)) continue;
		updateDocumentSortOrder.run(index, projectId, documentId);
		index++;
	}
});
module.exports.reorderDocuments = (projectId, folderId, documentIds) => {
	reorderDocumentsTx(projectId, folderId ?? null, documentIds);
};
