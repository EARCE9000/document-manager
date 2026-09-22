/*!
 * document-links.js : 関連文書(文書同士の対等な紐付け)の管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 種類も方向も持たない「関連」だけを扱う(AとBを紐づけると、どちらから見ても相手が出る)。
 * 1つの関係を1行で持ち、(document_id_a < document_id_b)に正規化して重複・方向違いの
 * 二重登録を防ぐ。版の紐付け(documents.previous_id)は新旧の直列関係で、こちらとは別物。
 *
 * アーカイブ(論理削除)された文書との関連はそのまま残す(復元したら元どおり見える)。
 */

const ds = require("./datastore.js");

// 常に (小さいID, 大きいID) の順に正規化する
const normalize = (documentId, relatedId) => (documentId < relatedId ? [documentId, relatedId] : [relatedId, documentId]);

const SQL_INSERT_LINK = `
	INSERT INTO document_links (document_id_a, document_id_b, created_by, created_at)
	VALUES (?, ?, ?, ?)
	ON CONFLICT DO NOTHING
`;
const SQL_DELETE_LINK = `DELETE FROM document_links WHERE document_id_a = ? AND document_id_b = ?`;
// 相手側の文書だけを取り出す(自分がa側・b側のどちらでも引けるようにORで書く)
const SQL_LIST_LINKED = `
	SELECT d.id AS id, d.entry_file AS entry_file, d.uploaded_by AS uploaded_by, d.uploaded_at AS uploaded_at,
		d.deleted_at AS deleted_at, l.created_by AS linked_by, l.created_at AS linked_at
	FROM document_links l
	JOIN documents d ON d.id = CASE WHEN l.document_id_a = ? THEN l.document_id_b ELSE l.document_id_a END
	WHERE l.document_id_a = ? OR l.document_id_b = ?
	ORDER BY d.uploaded_at DESC
`;

const toResponse = (row) => ({
	id: row.id,
	entryFile: row.entry_file,
	uploadedBy: row.uploaded_by,
	modified: row.uploaded_at,
	archived: row.deleted_at != null,
	linkedBy: row.linked_by,
	linkedAt: row.linked_at
});

/**
 * 指定文書に紐づく関連文書の一覧(新しい順)
 */
module.exports.listLinks = async (documentId) =>
	(await ds.all(SQL_LIST_LINKED, [documentId, documentId, documentId])).map(toResponse);

/**
 * 2つの文書を関連として紐づける。既に紐づいていれば何もしない(冪等)
 */
module.exports.link = async (documentId, relatedId, createdBy) => {
	const [a, b] = normalize(documentId, relatedId);
	await ds.run(SQL_INSERT_LINK, [a, b, createdBy, new Date().toISOString()]);
};

/**
 * 関連の紐付けを解除する。解除したらtrue、元々紐づいていなければfalse
 */
module.exports.unlink = async (documentId, relatedId) => {
	const [a, b] = normalize(documentId, relatedId);
	const result = await ds.run(SQL_DELETE_LINK, [a, b]);
	return result.changes > 0;
};
