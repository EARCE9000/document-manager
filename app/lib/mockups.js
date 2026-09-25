/*!
 * mockups.js : モックアップ(ビルド済みの静的サイト一式)のメタデータ管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 方針は docs/mockup.md を参照。文書とは別のコレクションとして扱い、
 * タグ・プロジェクトは持たず、版の鎖だけを持つ。
 *
 * 版の扱いは文書側と同じ考え方にしてある(新しい版を登録すると旧版はアーカイブされ、
 * 旧版から新版を逆引きできる)。モックアップは作り直して見比べる使い方が中心になるため、
 * 最初から入れている。
 *
 * 全文検索は content_text への LIKE/ILIKE で行う。件数が少なく、抜けるのもHTMLの
 * テキストだけなので、文書側のような索引(FTS5 / GIN)を別に持つ手間に見合わない。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const COLUMNS = `id, name, zip_file, entry_file, preview_file, file_count, total_bytes, zip_bytes,
	memo, uploaded_by, uploaded_at, deleted_by, deleted_at, previous_id`;

const SQL_INSERT = `
	INSERT INTO mockups (id, name, zip_file, entry_file, preview_file, file_count, total_bytes, zip_bytes, content_text, memo, uploaded_by, uploaded_at, previous_id)
	VALUES (@id, @name, @zip_file, @entry_file, @preview_file, @file_count, @total_bytes, @zip_bytes, @content_text, @memo, @uploaded_by, @uploaded_at, @previous_id)
`;
const SQL_SELECT_BY_ID = `SELECT ${COLUMNS} FROM mockups WHERE id = ?`;
const SQL_SELECT_ACTIVE = `SELECT ${COLUMNS} FROM mockups WHERE deleted_at IS NULL ORDER BY uploaded_at DESC`;
const SQL_SELECT_ARCHIVED = `SELECT ${COLUMNS} FROM mockups WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`;
const SQL_SELECT_NEXT = `SELECT id FROM mockups WHERE previous_id = ?`;
const SQL_ARCHIVE = `UPDATE mockups SET deleted_at = @deleted_at, deleted_by = @deleted_by WHERE id = @id AND deleted_at IS NULL`;
const SQL_RESTORE = `UPDATE mockups SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`;
const SQL_UPDATE_MEMO = `UPDATE mockups SET memo = ? WHERE id = ?`;
const SQL_UPDATE_NAME = `UPDATE mockups SET name = ? WHERE id = ?`;

// メモは一覧の応答すべてに載るため上限を設ける(文書側と同じ理由・同じ既定値)
const MEMO_MAX_CHARS = Number(process.env.MEMO_MAX_CHARS || 4000);
const NAME_MAX_CHARS = 200;

const toResponse = (row) => row == null ? null : {
	id: row.id,
	name: row.name,
	zipFile: row.zip_file,
	entryFile: row.entry_file,
	previewFile: row.preview_file,
	fileCount: row.file_count,
	totalBytes: row.total_bytes,
	zipBytes: row.zip_bytes,
	memo: row.memo,
	uploadedBy: row.uploaded_by,
	uploadedAt: row.uploaded_at,
	archived: row.deleted_at != null,
	deletedBy: row.deleted_by,
	deletedAt: row.deleted_at,
	previousId: row.previous_id
};
module.exports.toResponse = toResponse;

/**
 * 登録する。previousId を渡すと、その版を置き換えた新しい版として登録し、
 * 旧版をアーカイブする(登録とアーカイブは1トランザクションで行い、
 * 途中で失敗して「新版だけ登録されて旧版が残る」状態にしない)。
 *
 * @returns {Promise<{mockup: object, archivedPrevious: boolean}>}
 */
module.exports.createMockup = async (input) => {
	const now = new Date().toISOString();
	const row = {
		id: input.id,
		name: String(input.name || "").slice(0, NAME_MAX_CHARS) || input.id,
		zip_file: input.zipFile,
		entry_file: input.entryFile ?? null,
		preview_file: input.previewFile ?? null,
		file_count: input.fileCount ?? 0,
		total_bytes: input.totalBytes ?? 0,
		zip_bytes: input.zipBytes ?? 0,
		content_text: input.contentText ?? null,
		memo: null,
		uploaded_by: input.uploadedBy ?? null,
		uploaded_at: now,
		previous_id: input.previousId ?? null
	};

	let archivedPrevious = false;
	await ds.transaction(async (tx) => {
		await tx.run(SQL_INSERT, row);
		if (row.previous_id != null) {
			const result = await tx.run(SQL_ARCHIVE, {
				id: row.previous_id,
				deleted_at: now,
				deleted_by: row.uploaded_by
			});
			// 既にアーカイブ済みの版を指定した場合は、紐付けだけを行う
			archivedPrevious = result.changes > 0;
		}
	});

	logger.info({mockupId: row.id, files: row.file_count, previousId: row.previous_id}, "モックアップを登録しました");
	return {mockup: toResponse(await ds.get(SQL_SELECT_BY_ID, [row.id])), archivedPrevious};
};

module.exports.getMockup = async (id) => toResponse(await ds.get(SQL_SELECT_BY_ID, [id]));

/** 新しい版の有無(旧版から逆引きする) */
module.exports.getNextVersionId = async (id) => (await ds.get(SQL_SELECT_NEXT, [id]))?.id ?? null;

/**
 * 一覧。q を渡すと名前・メモ・本文(HTMLから抜いたテキスト)の部分一致で絞る。
 * 件数が少ない前提のため索引は持たず、LIKE/ILIKE で走査する。
 */
module.exports.listMockups = async ({archived = false, q = ""} = {}) => {
	const base = archived ? SQL_SELECT_ARCHIVED : SQL_SELECT_ACTIVE;
	const keyword = String(q || "").trim();
	if (keyword === "") return (await ds.all(base)).map(toResponse);

	// 文書側と同じく、バックエンドごとに大文字小文字の扱いが違うため演算子を分ける
	const like = ds.backend === "postgres" ? "ILIKE" : "LIKE";
	const where = archived ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
	const order = archived ? "deleted_at DESC" : "uploaded_at DESC";
	// LIKEのワイルドカードを打ち消してから前後に付ける(検索語に % や _ が入っても素直に探す)
	const escaped = keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
	const pattern = `%${escaped}%`;
	const rows = await ds.all(
		`SELECT ${COLUMNS} FROM mockups
		 WHERE ${where} AND (name ${like} ? ESCAPE '\\' OR memo ${like} ? ESCAPE '\\' OR content_text ${like} ? ESCAPE '\\')
		 ORDER BY ${order}`,
		[pattern, pattern, pattern]
	);
	return rows.map(toResponse);
};

/**
 * 版の履歴(古い順)。どの版から引いても同じ並びを返す。
 * 鎖が壊れている(循環している)場合に備えて、たどった数に上限を置く。
 */
const MAX_CHAIN = 200;
module.exports.listVersions = async (id) => {
	const start = await ds.get(SQL_SELECT_BY_ID, [id]);
	if (start == null) return null;

	const chain = [start];
	const seen = new Set([start.id]);

	let cursor = start;
	while (cursor.previous_id != null && chain.length < MAX_CHAIN && !seen.has(cursor.previous_id)) {
		const previous = await ds.get(SQL_SELECT_BY_ID, [cursor.previous_id]);
		if (previous == null) break;
		seen.add(previous.id);
		chain.unshift(previous);
		cursor = previous;
	}

	cursor = start;
	while (chain.length < MAX_CHAIN) {
		const nextId = await module.exports.getNextVersionId(cursor.id);
		if (nextId == null || seen.has(nextId)) break;
		const next = await ds.get(SQL_SELECT_BY_ID, [nextId]);
		if (next == null) break;
		seen.add(next.id);
		chain.push(next);
		cursor = next;
	}

	return chain.map(toResponse);
};

module.exports.archiveMockup = async (id, by) => {
	const result = await ds.run(SQL_ARCHIVE, {id, deleted_at: new Date().toISOString(), deleted_by: by ?? null});
	return result.changes > 0;
};

module.exports.restoreMockup = async (id) => (await ds.run(SQL_RESTORE, [id])).changes > 0;

module.exports.updateMemo = async (id, memo) => {
	const value = String(memo ?? "").slice(0, MEMO_MAX_CHARS);
	const result = await ds.run(SQL_UPDATE_MEMO, [value === "" ? null : value, id]);
	return result.changes > 0 ? value : null;
};

module.exports.rename = async (id, name) => {
	const value = String(name ?? "").trim().slice(0, NAME_MAX_CHARS);
	if (value === "") return null;
	const result = await ds.run(SQL_UPDATE_NAME, [value, id]);
	return result.changes > 0 ? value : null;
};

module.exports.MEMO_MAX_CHARS = MEMO_MAX_CHARS;
module.exports.NAME_MAX_CHARS = NAME_MAX_CHARS;
