/*!
 * work-guides.js : 作業の手引き(AI が作業を始める前に読む、資料の目次)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 「サービスフローを作るなら、決まりはこの資料」「開発するなら、標準化のルールはこの資料」のように、
 * 作業ごとに資料の場所を示す Markdown。AI はセッションの始めにこれだけを受け取り、
 * これからやる作業に当てはまる資料だけを、その場で読みに行く(本文を丸ごと渡さない)。
 *
 * - 置き場所は 2 段: 全体共通(scope = "global")と、プロジェクトごと(scope = プロジェクトのID)
 * - 本文はふつうの文書ではなく、この表に持つ。AI はこれを従うべき指示として読むため、
 *   直せるのは管理者だけにする(ふつうの文書だと、編集可の人が新しい版を上げて書き換えられる)
 * - 資料へのリンクは、文書の共有の URL(Alias)を使う。版をまたいで変わらず、いつも最新の版を指す
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const GLOBAL_SCOPE = "global";
// 目次なので長くならない。AI のセッションの始めに毎回読み込むため、上限を決めておく
const MAX_LENGTH = 20000;

const SQL_SELECT = `SELECT scope, markdown, updated_by, updated_at FROM work_guides WHERE scope = ?`;
const SQL_SELECT_ALL = `SELECT scope, markdown, updated_by, updated_at FROM work_guides ORDER BY updated_at DESC`;
const SQL_UPSERT = `
	INSERT INTO work_guides (scope, markdown, updated_by, updated_at) VALUES (?, ?, ?, ?)
	ON CONFLICT(scope) DO UPDATE SET markdown = excluded.markdown, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`;
const SQL_DELETE = `DELETE FROM work_guides WHERE scope = ?`;
const SQL_SELECT_DOCUMENT = `SELECT id, entry_file, deleted_at FROM documents WHERE id = ?`;
const SQL_SELECT_ALIAS = `SELECT document_id FROM document_aliases WHERE alias = ?`;

// 共有の URL(…/api/documents/alias/<12桁>/…)と、版を固定した URL(…/api/documents/<文書ID>/…)
const ALIAS_IN_URL = /api\/documents\/alias\/([0-9a-f]{12})(?![0-9a-f])/i;
const DOCUMENT_IN_URL = /api\/documents\/([0-9]{6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/i;

const toResponse = (row) => row == null ? null : {
	scope: row.scope,
	markdown: row.markdown,
	updatedBy: row.updated_by ?? null,
	updatedAt: row.updated_at ?? null
};

module.exports.GLOBAL_SCOPE = GLOBAL_SCOPE;
module.exports.MAX_LENGTH = MAX_LENGTH;

/** 1 つの手引き(無ければ null) */
module.exports.get = async (scope) => toResponse(await ds.get(SQL_SELECT, [scope]));

/** すべての手引き(管理の画面で、どのプロジェクトに書いてあるかを見せる) */
module.exports.listAll = async () => (await ds.all(SQL_SELECT_ALL)).map(toResponse);

/**
 * 手引きを保存する。空なら消す(書いていない状態に戻す)。
 * 戻り値: {status: "saved" | "deleted" | "too_long", previous}
 */
module.exports.save = async (scope, markdown, updatedBy) => {
	const text = String(markdown ?? "").replace(/\r\n/g, "\n");
	if (text.length > MAX_LENGTH) return {status: "too_long"};
	const previous = await module.exports.get(scope);
	if (text.trim() === "") {
		await ds.run(SQL_DELETE, [scope]);
		return {status: "deleted", previous};
	}
	await ds.run(SQL_UPSERT, [scope, text, updatedBy ?? null, new Date().toISOString()]);
	return {status: "saved", previous};
};

/** プロジェクトを消したときに、その手引きも消す */
module.exports.remove = async (scope) => {
	await ds.run(SQL_DELETE, [scope]);
};

/**
 * 本文の中の、Document Manager の文書へのリンクを拾う(Markdown のリンクも、地の文の URL も)。
 * 同じ先を指すものは 1 つにまとめる
 */
module.exports.extractLinks = (markdown) => {
	const text = String(markdown ?? "");
	const found = new Map();
	const add = (url, label) => {
		const alias = ALIAS_IN_URL.exec(url)?.[1]?.toLowerCase() ?? null;
		const documentId = alias == null ? (DOCUMENT_IN_URL.exec(url)?.[1] ?? null) : null;
		if (alias == null && documentId == null) return;
		const key = alias != null ? `alias:${alias}` : `document:${documentId}`;
		if (!found.has(key)) found.set(key, {url, label: label || null, alias, documentId});
	};
	// [見出し](URL)
	for (const match of text.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) add(match[2], match[1].trim());
	// 地の文の URL・相対パス(リンクにしていないもの)
	for (const match of text.matchAll(/(?:https?:\/\/[^\s)<>\]"']+|(?:\.{0,2}\/)?api\/documents\/[^\s)<>\]"']+)/g)) add(match[0], null);
	return [...found.values()];
};

/**
 * リンクがいまどの文書を指しているかを調べる。
 * kind: alias(共有の URL。新しい版を追いかける)/ document(版を固定した URL)
 * problem: null(問題なし)/ not_found / archived / fixed_version(版を固定している。新しい版を追いかけない)
 */
module.exports.resolveLinks = async (markdown) => {
	const links = module.exports.extractLinks(markdown);
	const results = [];
	for (const link of links) {
		try {
			const documentId = link.alias != null
				? (await ds.get(SQL_SELECT_ALIAS, [link.alias]))?.document_id ?? null
				: link.documentId;
			const document = documentId == null ? null : await ds.get(SQL_SELECT_DOCUMENT, [documentId]);
			let problem = null;
			if (document == null) problem = "not_found";
			else if (document.deleted_at != null) problem = "archived";
			else if (link.alias == null) problem = "fixed_version";
			results.push({
				url: link.url,
				label: link.label,
				kind: link.alias != null ? "alias" : "document",
				alias: link.alias,
				documentId: document?.id ?? null,
				entryFile: document?.entry_file ?? null,
				problem
			});
		} catch (err) {
			logger.error({err, url: link.url}, "::resolveLinks");
			results.push({url: link.url, label: link.label, kind: link.alias != null ? "alias" : "document", alias: link.alias,
				documentId: null, entryFile: null, problem: "not_found"});
		}
	}
	return results;
};
