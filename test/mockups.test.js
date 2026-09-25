/*!
 * mockups.test.js : モックアップのメタデータ管理(版の鎖・検索・アーカイブ)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 一時SQLiteに対して、実際に登録・検索・版の紐付けを行う。
 * 版の鎖は「どの版から引いても同じ履歴が返る」ことが肝で、そこを重点的に確かめる。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mockups-"));
process.env.LOG_LEVEL = "error";

const Mockups = require("../app/lib/mockups.js");

let counter = 0;
const newId = () => `202609_${String(++counter).padStart(8, "0")}-0000-4000-8000-000000000000`;

const create = (overrides = {}) => Mockups.createMockup({
	id: newId(),
	name: "サンプル",
	zipFile: "sample.zip",
	entryFile: "index.html",
	fileCount: 3,
	totalBytes: 1234,
	zipBytes: 567,
	uploadedBy: "someone@example.com",
	...overrides
});

test("登録して取り出せる", async () => {
	const {mockup} = await create({name: "商品一覧のモックアップ"});
	assert.equal(mockup.name, "商品一覧のモックアップ");
	assert.equal(mockup.entryFile, "index.html");
	assert.equal(mockup.fileCount, 3);
	assert.equal(mockup.archived, false);
	assert.equal(mockup.previousId, null);

	const fetched = await Mockups.getMockup(mockup.id);
	assert.equal(fetched.id, mockup.id);
	assert.equal(fetched.uploadedBy, "someone@example.com");
});

test("新しい版を登録すると、旧版はアーカイブされ、鎖で繋がる", async () => {
	const {mockup: v1} = await create({name: "v1"});
	const {mockup: v2, archivedPrevious} = await create({name: "v2", previousId: v1.id});

	assert.equal(archivedPrevious, true, "旧版がアーカイブされた");
	assert.equal(v2.previousId, v1.id);
	assert.equal((await Mockups.getMockup(v1.id)).archived, true, "旧版はアーカイブ済み");
	assert.equal((await Mockups.getMockup(v2.id)).archived, false, "新版は現役");
	assert.equal(await Mockups.getNextVersionId(v1.id), v2.id, "旧版から新版を引ける");

	// 現役の一覧には新版だけが出る
	const active = await Mockups.listMockups();
	assert.ok(active.some((item) => item.id === v2.id));
	assert.ok(!active.some((item) => item.id === v1.id));
	// アーカイブ一覧には旧版が出る
	assert.ok((await Mockups.listMockups({archived: true})).some((item) => item.id === v1.id));
});

test("版の履歴は、どの版から引いても古い順で同じ並びになる", async () => {
	const {mockup: v1} = await create({name: "履歴v1"});
	const {mockup: v2} = await create({name: "履歴v2", previousId: v1.id});
	const {mockup: v3} = await create({name: "履歴v3", previousId: v2.id});

	const expected = [v1.id, v2.id, v3.id];
	for (const [label, id] of [["最新から", v3.id], ["途中から", v2.id], ["最初から", v1.id]]) {
		const chain = await Mockups.listVersions(id);
		assert.deepEqual(chain.map((item) => item.id), expected, `${label}引いても同じ`);
	}
});

test("鎖が循環していても、版の履歴は返ってくる(無限に辿らない)", async () => {
	// 通常は起きないが、データが壊れたときに画面ごと止まらないようにする
	const a = newId();
	const b = newId();
	await Mockups.createMockup({id: a, name: "循環A", zipFile: "a.zip", fileCount: 1, previousId: b});
	await Mockups.createMockup({id: b, name: "循環B", zipFile: "b.zip", fileCount: 1, previousId: a});

	const chain = await Mockups.listVersions(a);
	assert.ok(Array.isArray(chain) && chain.length > 0 && chain.length < 10, `打ち切られている (${chain.length}件)`);
});

test("存在しないIDの履歴は null", async () => {
	assert.equal(await Mockups.listVersions("202609_99999999-0000-4000-8000-000000000000"), null);
});

test("名前・メモ・本文で検索できる", async () => {
	const {mockup} = await create({name: "検索対象のモックアップ", contentText: "会員登録フォームの画面です"});
	await Mockups.updateMemo(mockup.id, "レビュー待ちのメモ");

	for (const [label, q] of [["名前", "検索対象"], ["メモ", "レビュー待ち"], ["本文", "会員登録フォーム"]]) {
		const found = await Mockups.listMockups({q});
		assert.ok(found.some((item) => item.id === mockup.id), `${label}で見つかる`);
	}
	assert.equal((await Mockups.listMockups({q: "存在しない語句xyzzy"})).length, 0);
});

test("検索語のワイルドカードは文字として扱う", async () => {
	const {mockup} = await create({name: "100%完成"});
	// "%" が全件一致にならないこと(打ち消されていること)
	const all = await Mockups.listMockups({q: "%"});
	assert.ok(!all.some((item) => item.name === "サンプル"), "% が全件一致になっていない");
	assert.ok((await Mockups.listMockups({q: "100%完成"})).some((item) => item.id === mockup.id), "文字として探せる");
});

test("アーカイブと復元ができる", async () => {
	const {mockup} = await create({name: "出し入れ"});
	assert.equal(await Mockups.archiveMockup(mockup.id, "someone@example.com"), true);
	assert.equal((await Mockups.getMockup(mockup.id)).archived, true);
	// 二重のアーカイブは何も起きない
	assert.equal(await Mockups.archiveMockup(mockup.id, "someone@example.com"), false);

	assert.equal(await Mockups.restoreMockup(mockup.id), true);
	assert.equal((await Mockups.getMockup(mockup.id)).archived, false);
});

test("メモと名前には上限がある", async () => {
	const {mockup} = await create();
	const saved = await Mockups.updateMemo(mockup.id, "あ".repeat(Mockups.MEMO_MAX_CHARS + 500));
	assert.equal(saved.length, Mockups.MEMO_MAX_CHARS);

	const renamed = await Mockups.rename(mockup.id, "い".repeat(Mockups.NAME_MAX_CHARS + 50));
	assert.equal(renamed.length, Mockups.NAME_MAX_CHARS);
	// 空の名前は受け付けない(一覧で何も表示されなくなるため)
	assert.equal(await Mockups.rename(mockup.id, "   "), null);
});

test("本文は一覧の応答に載せない(AIの文脈を埋めないため)", async () => {
	const {mockup} = await create({name: "本文の扱い", contentText: "ここに大量のテキストが入る"});
	const found = (await Mockups.listMockups()).find((item) => item.id === mockup.id);
	assert.equal(found.contentText, undefined, "本文は返さない");
    assert.equal((await Mockups.getMockup(mockup.id)).contentText, undefined);
});

test.after(() => {
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});
