/*!
 * storage-discard.test.js : 実ファイルを捨てる唯一の経路の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * このアプリで実ファイルが消えるのは、アップロードが途中で失敗したときの後始末だけ。
 * 文書の削除(アーカイブ)は論理削除で、実ファイルは残す。つまりここを誤ると、
 * 通常の運用では決して起きないはずのデータ消失が起きる。
 *
 * 守りたい性質:
 *   1. 渡した名前のファイルだけが消える(他の文書・他のファイルに波及しない)
 *   2. 置き場所の外は絶対に触れない(.. や区切り文字を含む値を拒む)
 *   3. 再帰削除をしない(入れ物は空のときだけ片付ける)
 *   4. 何度呼んでも同じ結果になる
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const Storage = require("../app/lib/storage.js");

const ID_A = "202609_aaaaaaaa-1111-2222-3333-444444444444";
const ID_B = "202609_bbbbbbbb-1111-2222-3333-555555555555";

// 毎回まっさらな置き場所を用意し、文書を2件ぶん作る
const setup = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-discard-"));
	const documentsDir = path.join(root, "documents");
	for (const id of [ID_A, ID_B]) {
		fs.mkdirSync(path.join(documentsDir, id), {recursive: true});
		fs.writeFileSync(path.join(documentsDir, id, "報告書.html"), "<html>本文</html>");
		fs.writeFileSync(path.join(documentsDir, id, "preview.html"), "<html>preview</html>");
	}
	// 置き場所の外にも1つ置き、巻き込まれないことを確かめる
	fs.writeFileSync(path.join(root, "巻き込まれてはいけない.txt"), "残るべき");
	return {root, documentsDir, storage: Storage.createStorage(documentsDir)};
};

const exists = (...segments) => fs.existsSync(path.join(...segments));

test("渡した名前のファイルだけを捨て、入れ物も片付ける", async () => {
	const {root, documentsDir, storage} = setup();
	await storage.discardUpload(ID_A, ["報告書.html", "preview.html"]);

	assert.equal(exists(documentsDir, ID_A), false, "空になった入れ物は片付く");
	// 他の文書には波及しない
	assert.equal(exists(documentsDir, ID_B, "報告書.html"), true);
	assert.equal(exists(documentsDir, ID_B, "preview.html"), true);
	assert.equal(exists(root, "巻き込まれてはいけない.txt"), true, "置き場所の外は無事");
});

test("渡さなかったファイルは残り、入れ物も消えない", async () => {
	const {documentsDir, storage} = setup();
	await storage.discardUpload(ID_A, ["preview.html"]);

	assert.equal(exists(documentsDir, ID_A, "preview.html"), false, "渡したものは消える");
	assert.equal(exists(documentsDir, ID_A, "報告書.html"), true, "渡していないものは残る");
	// 再帰削除をしないため、中身が残っている入れ物は消えない
	assert.equal(exists(documentsDir, ID_A), true, "空でない入れ物は残る");
});

test("存在しないファイルを渡しても失敗せず、何度呼んでも同じ結果になる", async () => {
	const {documentsDir, storage} = setup();
	await storage.discardUpload(ID_A, ["報告書.html", "preview.html", "もともと無い.html"]);
	await storage.discardUpload(ID_A, ["報告書.html"]); // 2回目
	assert.equal(exists(documentsDir, ID_A), false);
	assert.equal(exists(documentsDir, ID_B, "報告書.html"), true);
});

test("空の配列を渡しても何も壊さない", async () => {
	const {documentsDir, storage} = setup();
	await storage.discardUpload(ID_A, []);
	assert.equal(exists(documentsDir, ID_A, "報告書.html"), true);
	assert.equal(exists(documentsDir, ID_A), true);
});

test("文書IDがサーバーの採番した形でなければ拒む", async () => {
	const {root, documentsDir, storage} = setup();
	const hostile = [
		"..", "../..", "..\\..",
		`../${path.basename(root)}`,
		"/etc", "C:\\Windows",
		"202609_not-a-uuid", "", " ", null, undefined, 42, {}, [ID_A]
	];
	for (const id of hostile) {
		await assert.rejects(
			() => storage.discardUpload(id, ["報告書.html"]),
			/捨てられない文書IDです/,
			`拒否されるべき: ${JSON.stringify(id)}`
		);
	}
	// 何も消えていない
	assert.equal(exists(documentsDir, ID_A, "報告書.html"), true);
	assert.equal(exists(documentsDir, ID_B, "報告書.html"), true);
	assert.equal(exists(root, "巻き込まれてはいけない.txt"), true);
});

test("ファイル名に区切り文字や上位への参照が入っていれば拒む", async () => {
	const {root, documentsDir, storage} = setup();
	const hostile = [
		"..", ".", "../報告書.html", `../${ID_B}/報告書.html`,
		"..\\..\\巻き込まれてはいけない.txt",
		"sub/報告書.html", "sub\\報告書.html",
		"/etc/passwd", "", "nul\u0000.html", "改行\n.html",
		null, 42, {}
	];
	for (const name of hostile) {
		await assert.rejects(
			() => storage.discardUpload(ID_A, [name]),
			/捨てられないファイル名です/,
			`拒否されるべき: ${JSON.stringify(name)}`
		);
	}
	// ひとつでも不正なら、同時に渡した正しい名前も消さない(全か無か)
	await assert.rejects(() => storage.discardUpload(ID_A, ["報告書.html", "../x"]), /捨てられないファイル名です/);
	assert.equal(exists(documentsDir, ID_A, "報告書.html"), true, "巻き添えで消さない");
	assert.equal(exists(documentsDir, ID_B, "報告書.html"), true);
	assert.equal(exists(root, "巻き込まれてはいけない.txt"), true);
});

test("配列以外を渡せば拒む", async () => {
	const {documentsDir, storage} = setup();
	for (const filenames of ["報告書.html", null, undefined, 42, {0: "報告書.html"}]) {
		await assert.rejects(() => storage.discardUpload(ID_A, filenames), /配列で指定/);
	}
	assert.equal(exists(documentsDir, ID_A, "報告書.html"), true);
});

test("ストレージ層に、文書ごと消す汎用の削除APIを持たせない", () => {
	// 「この文書を消す」という道具があると、将来どこからでも呼べてしまう。
	// 実ファイルを消してよい場面は失敗の後始末だけなので、その形でしか提供しない
	const {storage} = setup();
	for (const forbidden of ["deleteDocument", "deleteFile", "remove", "removeDocument", "deleteAll"]) {
		assert.equal(typeof storage[forbidden], "undefined", `${forbidden} は生やさない`);
	}
	assert.equal(typeof storage.discardUpload, "function");
});

test("ストレージ層のソースに再帰削除が無い", () => {
	// 再帰削除が1つでもあると、対象を取り違えたときの被害が青天井になる
	const source = fs.readFileSync(path.join(__dirname, "..", "app", "lib", "storage.js"), "utf-8");
	const deletions = source.split("\n")
		.map((line, index) => ({line, number: index + 1}))
		.filter(({line}) => /\brm\(|rmSync\(|deleteFiles\(/.test(line) && !line.trim().startsWith("//"));
	for (const {line, number} of deletions) {
		assert.ok(!/recursive\s*:\s*true/.test(line), `storage.js:${number} に再帰削除がある: ${line.trim()}`);
	}
});
