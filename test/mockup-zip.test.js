/*!
 * mockup-zip.test.js : モックアップのZIP展開が、細工された書庫を受け付けないことの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * ZIPのエントリ名・サイズは、書庫を作る側が自由に書ける。素朴に展開すると
 * 「名前のとおりの場所へ、申告とは違う量を」書いてしまう。
 * 正常系だけを見ても意味がないので、細工した書庫をその場で組み立てて食わせる。
 *
 * 特に確かめたいこと:
 *   1. 展開先の外へ1バイトも書かないこと(../ 絶対パス ドライブ名 バックスラッシュ シンボリックリンク)
 *   2. 展開後サイズを小さく偽っても膨らまないこと(ヘッダーの申告値を信じない)
 *   3. 拒否したとき、書いてしまったファイルを呼び出し側が捨てられること
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

const {extract, MockupZipError} = require("../app/lib/mockup-zip.js");

/* ---- テスト用のZIPを組み立てる(細工できるように自前で作る) ---- */

// entries: [{name, data, method, declaredSize, externalAttributes}]
const buildZip = (entries) => {
	const locals = [];
	const centrals = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf-8");
		const method = entry.method ?? 8;
		const raw = entry.data ?? Buffer.alloc(0);
		const payload = method === 0 ? raw : zlib.deflateRawSync(raw, {level: 9});
		const declared = entry.declaredSize ?? raw.length;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(entry.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(declared, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, payload);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(entry.flags ?? 0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(declared, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}

	const localPart = Buffer.concat(locals);
	const centralPart = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
};

const text = (value) => Buffer.from(value, "utf-8");

// 展開先と、その外側に「壊されてはいけないもの」を用意する
const setup = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mockup-"));
	const dest = path.join(root, "mockups", "202609_target");
	fs.mkdirSync(dest, {recursive: true});
	fs.writeFileSync(path.join(root, "壊されてはいけない.txt"), "大切なデータ");
	fs.mkdirSync(path.join(root, "db"), {recursive: true});
	fs.writeFileSync(path.join(root, "db", "document_manager_v14.sqlite"), "本物のDB");
	return {root, dest};
};

const intact = (root) => fs.readFileSync(path.join(root, "db", "document_manager_v14.sqlite"), "utf-8") === "本物のDB"
	&& fs.readFileSync(path.join(root, "壊されてはいけない.txt"), "utf-8") === "大切なデータ";

/* ---- 正常系 ---- */

test("普通のモックアップを展開できる", () => {
	const {root, dest} = setup();
	const zip = buildZip([
		{name: "index.html", data: text("<html><body>トップ</body></html>")},
		{name: "assets/style.css", data: text("body { color: red; }")},
		{name: "assets/img/logo.svg", data: text("<svg/>")},
		{name: "pages/detail.html", data: text("<html><body>詳細</body></html>")}
	]);

	const result = extract(zip, dest);
	assert.equal(result.files.length, 4);
	assert.equal(result.entryFile, "index.html", "入口は index.html");
	assert.ok(result.totalBytes > 0);
	assert.equal(fs.readFileSync(path.join(dest, "assets", "img", "logo.svg"), "utf-8"), "<svg/>", "入れ子も展開される");
	assert.ok(intact(root));
});

test("ディレクトリのエントリは読み飛ばし、入口が下の階層でも見つける", () => {
	const {dest} = setup();
	const zip = buildZip([
		{name: "dist/", data: Buffer.alloc(0)},
		{name: "dist/index.html", data: text("<html>dist</html>")}
	]);
	const result = extract(zip, dest);
	assert.equal(result.files.length, 1);
	assert.equal(result.entryFile, "dist/index.html");
});

/* ---- 1. 展開先の外へ書かせない ---- */

test("展開先の外を指す名前は、1バイトも書かずに拒否する", () => {
	const hostile = [
		{label: "上位への参照", name: "../../db/document_manager_v14.sqlite"},
		{label: "深い上位への参照", name: "a/b/../../../../壊されてはいけない.txt"},
		{label: "絶対パス", name: "/etc/passwd"},
		{label: "ドライブ名", name: "C:/Windows/system32/x.dll"},
		{label: "バックスラッシュ", name: "..\\..\\db\\document_manager_v14.sqlite"},
		{label: "カレントの参照", name: "./../db/x"},
		{label: "空の名前", name: ""},
		{label: "制御文字", name: `index\u0000.html`}
	];
	for (const {label, name} of hostile) {
		const {root, dest} = setup();
		const zip = buildZip([{name, data: text("侵入")}]);
		assert.throws(() => extract(zip, dest), MockupZipError, `拒否されるべき: ${label}`);
		assert.ok(intact(root), `${label}: 外のファイルが壊れている`);
		assert.equal(fs.readdirSync(dest).length, 0, `${label}: 展開先に何か書かれている`);
	}
});

test("正しいエントリと混ぜても、外を指すものがあれば拒否する", () => {
	const {root, dest} = setup();
	const zip = buildZip([
		{name: "index.html", data: text("<html>先に書かれる</html>")},
		{name: "../../db/document_manager_v14.sqlite", data: text("乗っ取り")}
	]);
	let error = null;
	try { extract(zip, dest); } catch (err) { error = err; }

	assert.ok(error instanceof MockupZipError, "拒否される");
	assert.ok(intact(root), "外のファイルは壊れていない");
	// 先に書いてしまったぶんは、呼び出し側が捨てられるよう報告される
	assert.deepEqual(error.written, ["index.html"], "書いたファイルが分かる");
});

test("シンボリックリンクのエントリは拒否する", () => {
	const {root, dest} = setup();
	// Unixのファイル種別(上位16bit)をリンクにする
	const zip = buildZip([
		{name: "link", data: text("../../db"), externalAttributes: 0xa1ff0000}
	]);
	assert.throws(() => extract(zip, dest), /シンボリックリンク/);
	assert.ok(intact(root));
});

test("暗号化された書庫・未対応の圧縮方式は拒否する", () => {
	const {dest} = setup();
	assert.throws(() => extract(buildZip([{name: "a.html", data: text("x"), flags: 0x0001}]), dest), /暗号化/);
	assert.throws(() => extract(buildZip([{name: "a.html", data: text("x"), method: 12}]), dest), /圧縮方式/);
});

/* ---- 2. 展開後サイズを偽っても膨らませない ---- */

test("展開後サイズを小さく偽っても、実際に出た量で打ち切る", () => {
	const {dest} = setup();
	const MB = 1024 * 1024;
	// 30MB に膨らむが、ヘッダーには 1000 バイトと書く
	const zip = buildZip([{name: "bomb.bin", data: Buffer.alloc(30 * MB), declaredSize: 1000}]);
	assert.ok(zip.length < MB, `仕掛けは小さい (${zip.length}バイト)`);

	const before = process.memoryUsage().external;
	assert.throws(() => extract(zip, dest, {maxFileBytes: 2 * MB, maxTotalBytes: 4 * MB, maxRatio: 100000}),
		/上限を超え/, "上限で止まる");
	const grew = process.memoryUsage().external - before;
	assert.ok(grew < 8 * MB, `上限を超えて確保していない (増加 ${(grew / MB).toFixed(1)}MB)`);
	assert.equal(fs.existsSync(path.join(dest, "bomb.bin")), false, "中途半端なファイルを残さない");
});

test("小さいファイルを大量に並べても、合計の上限で止まる", () => {
	const {dest} = setup();
	const entries = Array.from({length: 50}, (_, i) => ({name: `page${i}.html`, data: Buffer.alloc(100 * 1024)}));
	let error = null;
	try { extract(buildZip(entries), dest, {maxTotalBytes: 1024 * 1024, maxRatio: 100000}); }
	catch (err) { error = err; }

	assert.ok(error instanceof MockupZipError, "合計の上限で止まる");
	// 途中まで書いたものは報告される(呼び出し側が捨てられる)
	assert.ok(error.written.length > 0 && error.written.length < 50, `途中で止まっている (${error.written.length}件)`);
});

test("圧縮率が高すぎる書庫は拒否する", () => {
	const {dest} = setup();
	const zip = buildZip([{name: "a.bin", data: Buffer.alloc(5 * 1024 * 1024)}]);
	assert.throws(() => extract(zip, dest, {maxRatio: 10}), /圧縮率/);
});

/* ---- 3. 数の上限 ---- */

test("ファイル数と階層の深さに上限がある", () => {
	const {dest} = setup();
	const many = Array.from({length: 10}, (_, i) => ({name: `p${i}.html`, data: text("x")}));
	assert.throws(() => extract(buildZip(many), dest, {maxFiles: 5}), /ファイル数/);

	const deep = "a/".repeat(30) + "index.html";
	assert.throws(() => extract(buildZip([{name: deep, data: text("x")}]), dest, {maxDepth: 20}), /階層/);
});

test("ZIPとして読めないものは拒否する", () => {
	const {dest} = setup();
	for (const junk of [Buffer.alloc(0), Buffer.from("これはZIPではありません"), Buffer.alloc(100)]) {
		assert.throws(() => extract(junk, dest), MockupZipError);
	}
});

test.after(() => {
	// 一時ディレクトリはOSの一時領域にあり、片付けの失敗は検証の失敗ではない
	try {
		for (const name of fs.readdirSync(os.tmpdir())) {
			if (name.startsWith("dm-mockup-")) fs.rmSync(path.join(os.tmpdir(), name), {recursive: true, force: true});
		}
	} catch {}
});
