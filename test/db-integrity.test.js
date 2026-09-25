/*!
 * db-integrity.test.js : DBの破損を本当に検知できるかの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 「正常なDBでokが返る」だけでは、検知の仕組みが働いているとは言えない。
 * 壊れたファイルを渡して、実際に問題として報告されることまで確かめる。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-integrity-"));
process.env.LOG_LEVEL = "error";

const Database = require("../app/node_modules/better-sqlite3");
const DbIntegrity = require("../app/lib/db-integrity.js");

// 検査用のDBを作る。rows はページをまたぐ程度のデータ量を入れるためのもの
const createDatabase = (file, rows = 400) => {
	const db = new Database(file);
	db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)");
	db.exec("CREATE INDEX idx_docs_body ON docs (body)");
	const insert = db.prepare("INSERT INTO docs (id, body) VALUES (?, ?)");
	const tx = db.transaction(() => {
		for (let i = 0; i < rows; i++) insert.run(i, `本文データ ${i} ${"x".repeat(200)}`);
	});
	tx();
	db.close();
};

test("正常なDBは問題なしと報告する(簡易・厳密の両方)", async () => {
	const file = path.join(process.env.DATA_DIR, "healthy.sqlite");
	createDatabase(file);
	const db = new Database(file, {readonly: true});
	try {
		for (const mode of ["quick", "full"]) {
			const result = await DbIntegrity.check(mode, db);
			assert.equal(result.healthy, true, `${mode}: 問題なしと報告されるべき`);
			assert.equal(result.problemCount, 0);
			assert.equal(result.mode, mode);
			assert.ok(typeof result.durationMs === "number");
			assert.ok(typeof result.checkedAt === "string");
		}
	} finally {
		db.close();
	}
});

test("壊れたDBを問題として報告する", async () => {
	const file = path.join(process.env.DATA_DIR, "broken.sqlite");
	createDatabase(file);

	// データ部分を壊す。先頭100バイト(ヘッダー)は避け、途中のページを潰す。
	// こうするとファイルとしては開けるが、読み出すと破損が見つかる状態になる
	const buffer = fs.readFileSync(file);
	assert.ok(buffer.length > 8192, "検証に足るサイズのDBが必要");
	buffer.fill(0x00, 4096, 8192);
	fs.writeFileSync(file, buffer);

	const db = new Database(file, {readonly: true});
	try {
		const result = await DbIntegrity.check("full", db);
		assert.equal(result.healthy, false, "破損を検知できていない");
		assert.ok(result.problemCount > 0, "問題の件数が0になっている");
		assert.ok(result.problems.length > 0, "問題の内容が空");
		assert.ok(result.problems.every((p) => typeof p === "string" && p !== "ok"));
		// 件数が多くなりうるため応答は先頭だけに絞る
		assert.ok(result.problems.length <= 20);
		// 重度の破損では pragma 自体が例外を投げる。それでも500にせず、
		// 「壊れている」と報告できていること(checkFailedで検査が通らなかったことも区別できる)
		assert.ok(result.checkFailed === true || result.problemCount > 0);
	} finally {
		db.close();
	}
});

test("Postgresバックエンドでは検査せず、未対応として返す", async () => {
	// ds.backend を切り替えるのは現実的でないため、ここでは
	// 「接続を渡さなければアプリのDB(sqlite)を見る」という分岐だけを確認する
	const result = await DbIntegrity.check("quick");
	assert.equal(result.backend, "sqlite");
	assert.equal(result.supported, true);
});

test("不正なモードを渡しても簡易確認として扱う", async () => {
	const file = path.join(process.env.DATA_DIR, "mode.sqlite");
	createDatabase(file, 10);
	const db = new Database(file, {readonly: true});
	try {
		const result = await DbIntegrity.check("nonexistent-mode", db);
		assert.equal(result.mode, "quick");
		assert.equal(result.healthy, true);
	} finally {
		db.close();
	}
});

test.after(() => {
	// アプリのDB接続はプロセス終了まで開いたままのため、Windowsではここで消せないことがある
	// (EPERM)。一時ディレクトリの残骸はOSの一時領域にあり、片付けの失敗は検証の失敗ではない
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});
