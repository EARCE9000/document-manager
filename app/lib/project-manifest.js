/*!
 * project-manifest.js : プロジェクトの「お品書き」の組み立て
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ツリー(フォルダ＋文書の配置)を、人が読む順番に並べ直したものを「お品書き」と呼んでいる。
 * フォルダが章の見出しになり、その下に資料が並び、それぞれに説明書きが付く。
 *
 * 画面とMarkdownの持ち出しで**同じ並び**になっている必要があるため、並べる処理はここ1か所に
 * 置き、画面もMarkdownもこの結果を描くだけにする(片方だけ直して食い違う、を防ぐ)。
 *
 * なお資料の説明書きは文書そのものではなく「プロジェクトへの紐づけ」に付く。1つの文書は
 * 複数のプロジェクトに登録できるので、案件ごとに位置づけが違ってよい(docs/project-manifest.md)。
 */

/**
 * ツリーを、読む順に並べたお品書きに組み直す。
 *
 * 並びの規則:
 *   1. プロジェクト直下の資料(フォルダに入っていないもの)
 *   2. フォルダ(並び順どおり)。入れ子のフォルダはその中に続く
 *
 * @param {{name: string}} project
 * @param {{folders: object[], documents: object[]}} tree
 * @returns {{projectName: string, rootDocuments: object[], folders: object[], documentCount: number}}
 */
module.exports.build = (project, tree) => {
	const folders = tree?.folders ?? [];
	const documents = tree?.documents ?? [];

	// フォルダIDごとに資料を仕分ける。並び順はツリー取得時点で付いている
	const byFolder = new Map();
	for (const doc of documents) {
		const key = doc.folderId ?? null;
		if (!byFolder.has(key)) byFolder.set(key, []);
		byFolder.get(key).push(doc);
	}
	for (const list of byFolder.values()) list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

	// 親子をたどって入れ子に組む。親が見つからないフォルダ(データの壊れ)は捨てずに
	// 直下として扱う ― 中の資料がお品書きから消えるより、位置がずれる方がまだよい
	const childrenOf = new Map();
	const known = new Set(folders.map((f) => f.id));
	for (const folder of folders) {
		const parent = folder.parentFolderId != null && known.has(folder.parentFolderId) ? folder.parentFolderId : null;
		if (!childrenOf.has(parent)) childrenOf.set(parent, []);
		childrenOf.get(parent).push(folder);
	}
	// 並び順はここで確定させる。呼び出し元(SQL)の順に頼ると、取得経路が増えたときに崩れる
	for (const list of childrenOf.values()) list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

	const seen = new Set();
	const buildFolders = (parentId, depth) => (childrenOf.get(parentId) ?? []).flatMap((folder) => {
		// 万一の循環で無限に潜らないようにする
		if (seen.has(folder.id)) return [];
		seen.add(folder.id);
		return [{
			id: folder.id,
			name: folder.name,
			note: folder.note ?? null,
			depth,
			documents: byFolder.get(folder.id) ?? [],
			folders: buildFolders(folder.id, depth + 1)
		}];
	});

	return {
		projectName: project?.name ?? "",
		rootDocuments: byFolder.get(null) ?? [],
		folders: buildFolders(null, 1),
		documentCount: documents.length
	};
};

/** 資料1件の表示名。文書が見つからない場合でも行は消さず、そうと分かるようにする */
const displayName = (doc) => doc.entryFile ?? "(この資料は見つかりません)";

const documentLine = (doc) => {
	const name = displayName(doc);
	const marks = [];
	if (doc.archived) marks.push("アーカイブ済み");
	const suffix = marks.length > 0 ? `(${marks.join("・")})` : "";
	const note = doc.note != null ? ` — ${doc.note}` : "";
	return `- **${name}**${suffix}${note}`;
};

/**
 * お品書きをMarkdownにする。議事録やメールにそのまま貼れることを狙った形。
 * @param {object} manifest build() の結果
 */
module.exports.toMarkdown = (manifest) => {
	const lines = [`# ${manifest.projectName} お品書き`, ""];

	for (const doc of manifest.rootDocuments) lines.push(documentLine(doc));
	if (manifest.rootDocuments.length > 0) lines.push("");

	const walk = (folders) => {
		for (const folder of folders) {
			// 見出しの深さは入れ子に合わせる。深すぎる場合はMarkdownの最下位(######)で止める
			lines.push(`${"#".repeat(Math.min(folder.depth + 1, 6))} ${folder.name}`, "");
			if (folder.note != null) lines.push(folder.note, "");
			for (const doc of folder.documents) lines.push(documentLine(doc));
			if (folder.documents.length > 0) lines.push("");
			walk(folder.folders);
		}
	};
	walk(manifest.folders);

	if (manifest.documentCount === 0) lines.push("(資料はまだありません)", "");

	// 末尾の空行が続かないようにしてから改行で閉じる
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return `${lines.join("\n")}\n`;
};
