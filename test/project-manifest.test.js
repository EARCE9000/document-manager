/*!
 * project-manifest.test.js : お品書きの組み立て(app/lib/project-manifest.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 画面とMarkdownで並びが食い違わないよう、並べる処理はここ1か所に寄せてある。
 * 並び順・入れ子・説明書きの有無・壊れたデータの扱いを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Manifest = require("../app/lib/project-manifest.js");

const project = {name: "受注管理の再構築"};

const doc = (id, entryFile, extra = {}) => ({
	documentId: id, entryFile, folderId: null, sortOrder: 0, note: null, archived: false, ...extra
});
const folder = (id, name, extra = {}) => ({
	id, name, parentFolderId: null, sortOrder: 0, note: null, ...extra
});

test("プロジェクト直下の資料が先に来て、そのあとフォルダが並び順どおりに続く", () => {
	const tree = {
		folders: [
			folder("f2", "参考資料", {sortOrder: 1}),
			folder("f1", "要件", {sortOrder: 0})
		],
		documents: [
			doc("d3", "参考.pdf", {folderId: "f2"}),
			doc("d2", "要件定義.docx", {folderId: "f1"}),
			doc("d1", "表紙.md")
		]
	};
	const manifest = Manifest.build(project, tree);

	assert.deepEqual(manifest.rootDocuments.map((d) => d.entryFile), ["表紙.md"]);
	assert.deepEqual(manifest.folders.map((f) => f.name), ["要件", "参考資料"]);
	assert.equal(manifest.documentCount, 3);
});

test("フォルダの中の資料は並び順どおり", () => {
	const tree = {
		folders: [folder("f1", "要件")],
		documents: [
			doc("b", "2番目.md", {folderId: "f1", sortOrder: 1}),
			doc("a", "1番目.md", {folderId: "f1", sortOrder: 0}),
			doc("c", "3番目.md", {folderId: "f1", sortOrder: 2})
		]
	};
	const {folders} = Manifest.build(project, tree);
	assert.deepEqual(folders[0].documents.map((d) => d.entryFile), ["1番目.md", "2番目.md", "3番目.md"]);
});

test("入れ子のフォルダは深さを持って中に入る", () => {
	const tree = {
		folders: [
			folder("f1", "要件"),
			folder("f1a", "画面", {parentFolderId: "f1"}),
			folder("f1a1", "一覧画面", {parentFolderId: "f1a"})
		],
		documents: [doc("d", "画面一覧.xlsx", {folderId: "f1a1"})]
	};
	const {folders} = Manifest.build(project, tree);
	assert.equal(folders.length, 1);
	assert.equal(folders[0].depth, 1);
	assert.equal(folders[0].folders[0].name, "画面");
	assert.equal(folders[0].folders[0].depth, 2);
	assert.equal(folders[0].folders[0].folders[0].depth, 3);
	assert.equal(folders[0].folders[0].folders[0].documents[0].entryFile, "画面一覧.xlsx");
});

test("Markdownが章立てになり、説明書きが資料の後ろに付く", () => {
	const tree = {
		folders: [folder("f1", "要件", {note: "この案件で合意した範囲です。"})],
		documents: [
			doc("d1", "表紙.md", {note: "最初に読んでください。"}),
			doc("d2", "要件定義.docx", {folderId: "f1", note: "3章が今回の変更点。"}),
			doc("d3", "旧要件.docx", {folderId: "f1", sortOrder: 1, archived: true})
		]
	};
	const markdown = Manifest.toMarkdown(Manifest.build(project, tree));

	assert.equal(markdown, [
		"# 受注管理の再構築 お品書き",
		"",
		"- **表紙.md** — 最初に読んでください。",
		"",
		"## 要件",
		"",
		"この案件で合意した範囲です。",
		"",
		"- **要件定義.docx** — 3章が今回の変更点。",
		"- **旧要件.docx**(アーカイブ済み)",
		""
	].join("\n").replace(/\n+$/, "\n"));
});

test("説明書きが無い資料は名前だけになる(空の区切りを出さない)", () => {
	const markdown = Manifest.toMarkdown(Manifest.build(project, {
		folders: [], documents: [doc("d", "説明なし.md")]
	}));
	assert.ok(markdown.includes("- **説明なし.md**\n"), markdown);
	assert.ok(!markdown.includes("—"), "区切りの — を出してはいけない");
});

test("入れ子が深くてもMarkdownの見出しは###### で止まる", () => {
	const folders = [];
	let parent = null;
	for (let i = 0; i < 8; i += 1) {
		folders.push(folder(`f${i}`, `第${i}層`, {parentFolderId: parent}));
		parent = `f${i}`;
	}
	const markdown = Manifest.toMarkdown(Manifest.build(project, {folders, documents: []}));
	assert.ok(!markdown.includes("####### "), "Markdownに無い深さの見出しを出してはいけない");
	assert.ok(markdown.includes("###### 第7層"));
});

test("資料が1件も無ければ、その旨を書く", () => {
	const markdown = Manifest.toMarkdown(Manifest.build(project, {folders: [], documents: []}));
	assert.ok(markdown.includes("(資料はまだありません)"));
});

test("文書が見つからない配置でも行は消さない", () => {
	const markdown = Manifest.toMarkdown(Manifest.build(project, {
		folders: [], documents: [doc("missing", null)]
	}));
	assert.ok(markdown.includes("(この資料は見つかりません)"), "黙って消えると、抜けに気づけない");
});

// データが壊れていても、お品書きから資料が消えないこと。
// 消えると「渡した一覧に載っていない資料がある」ことになり、いちばん困る
test("親が見つからないフォルダも、直下として出る", () => {
	const {folders} = Manifest.build(project, {
		folders: [folder("orphan", "親が消えたフォルダ", {parentFolderId: "いない"})],
		documents: [doc("d", "中身.md", {folderId: "orphan"})]
	});
	assert.deepEqual(folders.map((f) => f.name), ["親が消えたフォルダ"]);
	assert.equal(folders[0].documents[0].entryFile, "中身.md");
});

test("フォルダの親子が循環していても止まる", () => {
	const {folders} = Manifest.build(project, {
		folders: [
			folder("a", "A", {parentFolderId: "b"}),
			folder("b", "B", {parentFolderId: "a"})
		],
		documents: []
	});
	// どちらも親が相手で直下が無い。無限に潜らず、単に空で返ればよい
	assert.ok(Array.isArray(folders));
});

test("空のツリー・欠けた入力でも落ちない", () => {
	for (const input of [undefined, null, {}, {folders: null, documents: null}]) {
		const manifest = Manifest.build(undefined, input);
		assert.equal(manifest.documentCount, 0);
		assert.ok(typeof Manifest.toMarkdown(manifest) === "string");
	}
});
