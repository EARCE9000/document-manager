/*!
 * document-aliases.js : 版をまたいで変わらない共有用のID(Alias)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 文書は更新のたびに新しいIDになる(その仕様は変えない)。そのままだと人に配ったリンクが
 * 古い版を指したままになり、受け取った側は「どれが最新か」を判断できない。
 *
 * Aliasは**いまの版を指す、差し替え可能な矢印**である。
 *
 *   新しい版を上げる  → 矢印を新しい版へ向け直す(引き継ぎ)
 *   古い版に戻したい  → 矢印を古い版へ向け直す(つけなおし)
 *
 * 文書側に列を足さず別表にしているのは、これが「文書の属性」ではなく「指す先の操作」だから。
 * 版の紐付けを後から変えたときの挙動も、この表を動かすかどうかで明示的に決められる。
 *
 * ---- 約束 ----
 * - Alias 1つ = 文書1つ(表のPRIMARY KEYとUNIQUEで担保)
 * - 文書1つ = Alias 1つまで。既にAliasのある文書へ別のAliasを向けようとしたら断る
 *   (黙って2つ目を作ると、共有リンクをコピーするときにどちらを出すか決められない)
 * - 古い版はAliasを失う。版ごとのリンク(文書IDのURL)は従来どおり生きているので、
 *   「その版を指したい」ときはそちらを使う
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

// URLに入るので、読み書きで取り違えない文字だけを使う。
// 自動採番なので人が打つ前提ではないが、口頭やチャットで伝わることはある
const ALIAS_BYTES = 6; // 12文字の16進数。2^48通りあり、衝突は実質起きない
const ALIAS_PATTERN = /^[0-9a-f]{12}$/;

const SQL_SELECT_BY_ALIAS = `SELECT alias, document_id, created_at FROM document_aliases WHERE alias = ?`;
const SQL_SELECT_BY_DOCUMENT = `SELECT alias, document_id, created_at FROM document_aliases WHERE document_id = ?`;
const SQL_INSERT = `INSERT INTO document_aliases (alias, document_id, created_at) VALUES (?, ?, ?)`;
const SQL_MOVE = `UPDATE document_aliases SET document_id = ? WHERE alias = ?`;
const SQL_DELETE_BY_DOCUMENT = `DELETE FROM document_aliases WHERE document_id = ?`;

/** 利用者から渡された値がAliasの形をしているか(パスの区切り等を持ち込ませない) */
module.exports.isValidAlias = (value) => typeof value === "string" && ALIAS_PATTERN.test(value);
module.exports.ALIAS_PATTERN = ALIAS_PATTERN;

const toResponse = (row) => row == null ? null : {
	alias: row.alias,
	documentId: row.document_id,
	createdAt: row.created_at
};

/** Aliasから、いま指している文書のIDを引く。無ければ null */
module.exports.resolve = async (alias) => {
	if (!module.exports.isValidAlias(alias)) return null;
	return (await ds.get(SQL_SELECT_BY_ALIAS, [alias]))?.document_id ?? null;
};

/** 文書に付いているAliasを引く。無ければ null */
module.exports.aliasOf = async (documentId) =>
	(await ds.get(SQL_SELECT_BY_DOCUMENT, [documentId]))?.alias ?? null;

module.exports.get = async (alias) =>
	module.exports.isValidAlias(alias) ? toResponse(await ds.get(SQL_SELECT_BY_ALIAS, [alias])) : null;

/**
 * 文書に新しいAliasを発行する。既に付いていればそれを返す(二重に作らない)。
 *
 * 採番が万一ぶつかっても黙って上書きしないよう、挿入が通るまで作り直す。
 */
module.exports.assign = async (documentId) => {
	const existing = await module.exports.aliasOf(documentId);
	if (existing != null) return existing;

	for (let attempt = 0; attempt < 5; attempt++) {
		const alias = crypto.randomBytes(ALIAS_BYTES).toString("hex");
		try {
			await ds.run(SQL_INSERT, [alias, documentId, new Date().toISOString()]);
			return alias;
		} catch (err) {
			// 採番がぶつかったか、その間に別の経路が同じ文書へ付けたか。
			// 後者なら付いたものを使う(先に付いた方を正とする)
			const now = await module.exports.aliasOf(documentId);
			if (now != null) return now;
			logger.warn({err, documentId, attempt}, "::assign: 採番をやり直します");
		}
	}
	throw new Error(`Aliasを採番できませんでした: ${documentId}`);
};

/**
 * Aliasの指す先を変える。新しい版への引き継ぎにも、古い版へのつけなおしにも使う。
 *
 * @returns {"moved"|"not_found"|"already_has_alias"}
 *   already_has_alias … 移動先の文書に既に別のAliasがある。取り違えを避けるため断る
 */
module.exports.moveTo = async (alias, documentId) => {
	if (!module.exports.isValidAlias(alias)) return "not_found";
	const current = await ds.get(SQL_SELECT_BY_ALIAS, [alias]);
	if (current == null) return "not_found";
	if (current.document_id === documentId) return "moved";

	const occupied = await ds.get(SQL_SELECT_BY_DOCUMENT, [documentId]);
	if (occupied != null) return "already_has_alias";

	await ds.run(SQL_MOVE, [documentId, alias]);
	logger.info({alias, from: current.document_id, to: documentId}, "Aliasの指す先を変えました");
	return "moved";
};

/**
 * 新しい版へ引き継ぐ。旧版にAliasが無ければ何もしない。
 *
 * 新版に既にAliasがある場合(別々に登録したものを後から版として紐づけた場合など)は、
 * 新版のものを残して旧版のAliasは**消す**。矢印が2本になると、どちらを配ればよいか
 * 分からなくなるため。
 */
module.exports.inherit = async (previousDocumentId, newDocumentId) => {
	const alias = await module.exports.aliasOf(previousDocumentId);
	if (alias == null) return null;

	const occupied = await ds.get(SQL_SELECT_BY_DOCUMENT, [newDocumentId]);
	if (occupied != null) {
		await ds.run(SQL_DELETE_BY_DOCUMENT, [previousDocumentId]);
		logger.info({alias, previousDocumentId, keeping: occupied.alias},
			"新版に既にAliasがあったため、旧版のAliasは畳みました");
		return occupied.alias;
	}
	await ds.run(SQL_MOVE, [newDocumentId, alias]);
	return alias;
};

/**
 * Aliasを持っていない文書へまとめて発行する(起動時のバックフィル)。
 *
 * この仕組みより前に登録された文書にはAliasが無い。画面に共有リンクのボタンを出す以上、
 * 「古い文書だけ押せない」を作らないために起動時に埋める。
 * アーカイブ済みも対象にする(元に戻したときに付いていないと、同じ話になるため)。
 */
module.exports.backfill = async () => {
	const rows = await ds.all(`
		SELECT d.id FROM documents d
		WHERE NOT EXISTS (SELECT 1 FROM document_aliases a WHERE a.document_id = d.id)
	`);
	if (rows.length === 0) return 0;
	for (const row of rows) await module.exports.assign(row.id);
	logger.info({count: rows.length}, "Aliasの無い文書へ発行しました");
	return rows.length;
};
