/*!
 * tag-order.js : タグ体系(タグツリー表示)の並び順管理
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * document_tags(文書に自由入力で付けるタグ)とは別に、「体系化したいタグだけ」を
 * ここに登録し表示順序を持たせる。並び順の変更は常に全件置き換え(admin限定)。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const MAX_TAG_LENGTH = 100;

const SELECT_TAG_ORDER = `SELECT tag, sort_order, updated_by, updated_at FROM tag_order ORDER BY sort_order ASC`;
const DELETE_ALL_TAG_ORDER = `DELETE FROM tag_order`;
const INSERT_TAG_ORDER = `
	INSERT INTO tag_order (tag, sort_order, updated_by, updated_at) VALUES (@tag, @sort_order, @updated_by, @updated_at)
`;

module.exports.listTagOrder = async () => {
	const rows = await ds.all(SELECT_TAG_ORDER);
	return rows.map((row) => ({
		tag: row.tag,
		sortOrder: row.sort_order,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at
	}));
};

/**
 * タグの並び順を全件置き換える。tagsは表示させたい順のタグ名配列
 * (空文字・前後空白・重複は取り除いてから保存する)。削除と再挿入は
 * datastoreのトランザクション内でまとめて行い、途中失敗時は全体がロールバックされる
 */
module.exports.replaceTagOrder = async (tags, updatedBy) => {
	if (!Array.isArray(tags)) {
		throw new Error("tags must be an array");
	}
	const cleaned = [];
	const seen = new Set();
	for (const raw of tags) {
		const tag = String(raw || "").trim();
		if (tag === "" || tag.length > MAX_TAG_LENGTH || seen.has(tag)) {
			continue;
		}
		seen.add(tag);
		cleaned.push(tag);
	}
	try {
		await ds.transaction(async (tx) => {
			await tx.run(DELETE_ALL_TAG_ORDER);
			const now = new Date().toISOString();
			for (let index = 0; index < cleaned.length; index++) {
				await tx.run(INSERT_TAG_ORDER, {tag: cleaned[index], sort_order: index, updated_by: updatedBy, updated_at: now});
			}
		});
	} catch (err) {
		logger.error(err, "::replaceTagOrder");
		throw err;
	}
	return cleaned;
};
