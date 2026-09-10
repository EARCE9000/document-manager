/*!
 * unit.test.js : 外部I/Oを伴わない純関数のユニットテスト(層1)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 * datastore/vector-search/api-keys は require時にdatastore(既定sqlite)を初期化するため、
 * 副作用のDBファイルが既定の /data に作られないよう、先頭で DATA_DIR を一時ディレクトリに向ける。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-unit-"));

const test = require("node:test");
const assert = require("node:assert/strict");

const zlib = require("node:zlib");

const {computeByteRange} = require("../app/lib/storage.js");
const {translatePlaceholders} = require("../app/lib/datastore.js");
const VectorSearch = require("../app/lib/vector-search.js");
const ApiKeys = require("../app/lib/api-keys.js");
const AllowedUsers = require("../app/lib/allowed-users.js");
const {extractDrawioText} = require("../app/lib/drawio.js");

test("computeByteRange", () => {
	assert.deepEqual(computeByteRange(undefined, 16), {satisfiable: true, start: 0, end: 15, partial: false});
	assert.deepEqual(computeByteRange("bytes=0-3", 16), {satisfiable: true, start: 0, end: 3, partial: true});
	assert.deepEqual(computeByteRange("bytes=2-5", 16), {satisfiable: true, start: 2, end: 5, partial: true});
	assert.deepEqual(computeByteRange("bytes=10-", 16), {satisfiable: true, start: 10, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=-4", 16), {satisfiable: true, start: 12, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=0-999", 16), {satisfiable: true, start: 0, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=16-20", 16), {satisfiable: false});
	assert.deepEqual(computeByteRange("bytes=-0", 16), {satisfiable: false});
	// 解釈できないRangeは全体を返す(寛容)
	assert.deepEqual(computeByteRange("garbage", 16), {satisfiable: true, start: 0, end: 15, partial: false});
});

test("translatePlaceholders: 位置パラメータ ?", () => {
	const {text, values} = translatePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", ["x", "y"]);
	assert.equal(text, "SELECT * FROM t WHERE a = $1 AND b = $2");
	assert.deepEqual(values, ["x", "y"]);
});

test("translatePlaceholders: 名前付き @name(同名は同じ$nを再利用)", () => {
	const {text, values} = translatePlaceholders("WHERE x LIKE @q OR y LIKE @q OR id = @id", {q: "a", id: "b"});
	assert.equal(text, "WHERE x LIKE $1 OR y LIKE $1 OR id = $2");
	assert.deepEqual(values, ["a", "b"]);
});

test("translatePlaceholders: params無しはそのまま", () => {
	assert.deepEqual(translatePlaceholders("SELECT 1", null), {text: "SELECT 1", values: []});
});

test("chunkText: 空文字は空配列", async () => {
	assert.deepEqual(await VectorSearch.chunkText("", 100, 10), []);
});

test("chunkText: chunkSize以内は1チャンク", async () => {
	assert.deepEqual(await VectorSearch.chunkText("short text", 100, 10), ["short text"]);
});

test("chunkText: CRLFの段落境界を正規化して\\n\\nで連結する", async () => {
	// \r\n\r\n が段落境界として認識され、出力に\rが残らないこと(実機で確認したバグの回帰防止)
	const chunks = await VectorSearch.chunkText("AAAA\r\n\r\nBBBB", 100, 10);
	assert.deepEqual(chunks, ["AAAA\n\nBBBB"]);
});

test("chunkText: chunkSize超の段落はオーバーラップ付きで分割", async () => {
	const text = "x".repeat(250);
	const chunks = await VectorSearch.chunkText(text, 100, 20);
	assert.ok(chunks.length > 1, "複数チャンクに分割される");
	assert.equal(chunks[0].length, 100, "先頭チャンクはchunkSize長");
});

test("calculateExpiresAt: 30d/90d は日数分先", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("30d", now).toISOString(), "2026-01-31T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("90d", now).toISOString(), "2026-04-01T00:00:00.000Z");
});

test("calculateExpiresAt: today は min(now+12h, 翌日02:00 JST)", () => {
	// now=00:00Z → +12h=12:00Z、翌日02:00 JST=前日17:00Z。min は 12:00Z
	const now = new Date("2026-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("today", now).toISOString(), "2026-01-01T12:00:00.000Z");
});

test("calculateExpiresAt: 不正な選択肢は例外", () => {
	assert.throws(() => ApiKeys.calculateExpiresAt("forever", new Date()));
});

test("APIキーのロール/有効期限バリデーション", () => {
	assert.equal(ApiKeys.isValidApiKeyRole("readonly"), true);
	assert.equal(ApiKeys.isValidApiKeyRole("readwrite"), true);
	assert.equal(ApiKeys.isValidApiKeyRole("admin"), false); // adminキーは発行不可
	assert.equal(ApiKeys.isValidExpiryOption("30d"), true);
	assert.equal(ApiKeys.isValidExpiryOption("1y"), false);
});

test("allowed-users のロール定義とバリデーション", () => {
	assert.equal(AllowedUsers.isValidRole("admin"), true);
	assert.equal(AllowedUsers.isValidRole("readwrite"), true);
	assert.equal(AllowedUsers.isValidRole("readonly"), true);
	assert.equal(AllowedUsers.isValidRole("root"), false);
	assert.equal(AllowedUsers.ROLES.ADMIN, "admin");
});

test("extractDrawioText: 非圧縮(mxGraphModel生XML)からページ名・ラベルを抽出", () => {
	const xml = `<mxfile><diagram name="設計フロー" id="p1"><mxGraphModel>`
		+ `<root><mxCell id="0"/><mxCell id="2" value="開始" vertex="1"/>`
		+ `<mxCell id="3" value="&lt;b&gt;注文処理&lt;/b&gt;" vertex="1"/>`
		+ `<mxCell id="4" value="" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
	const text = extractDrawioText(xml);
	assert.match(text, /設計フロー/);
	assert.match(text, /開始/);
	assert.match(text, /注文処理/, "HTMLラベルはタグ除去・エンティティ復元して抽出される");
	assert.doesNotMatch(text, /<b>/, "HTMLタグは残らない");
});

test("extractDrawioText: 圧縮(base64 deflate)されたdiagramを展開して抽出", () => {
	const model = `<mxGraphModel><root><mxCell id="2" value="圧縮ラベル" vertex="1"/></root></mxGraphModel>`;
	const compressed = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model), "utf8")).toString("base64");
	const xml = `<mxfile><diagram name="圧縮ページ" id="p1">${compressed}</diagram></mxfile>`;
	const text = extractDrawioText(xml);
	assert.match(text, /圧縮ページ/);
	assert.match(text, /圧縮ラベル/);
});

test("extractDrawioText: 壊れた入力でも例外を投げず空文字を返す", () => {
	assert.equal(extractDrawioText(""), "");
	assert.equal(extractDrawioText(null), "");
	assert.equal(typeof extractDrawioText("<mxfile><diagram>@@not-base64@@</diagram></mxfile>"), "string");
});

test.after(() => {
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true});
	} catch {}
});
