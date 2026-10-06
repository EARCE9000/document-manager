/*!
 * db-migration.test.js : スキーマ最新化(マイグレーション)でデータが失われないことの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 背景: SQLiteはバージョンごとにファイルを分け、最新化時に旧ファイルの各テーブルを
 * 新ファイルへコピーして移す方式。コピー対象の列挙から表が漏れると、その表のデータは
 * 最新化のたびに消える。特に app_settings(機能のOn/Off。例: モックアップ機能)は
 * 「最新化したら設定が既定へ戻る」という形で表面化していたため、ここで回帰を防ぐ。
 *
 * db.js はrequire時にDATA_DIRを見て初期化・移行まで済ませるシングルトンのため、
 * DATA_DIRを変えた検証は同一プロセスでは行えない。子プロセスでrequireして動かす。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");

const APP_DIR = path.join(__dirname, "..", "app");
const DB_JS = path.join(APP_DIR, "lib", "db.js");
const Database = require("../app/node_modules/better-sqlite3");

// 指定したDATA_DIRで db.js をrequireして初期化/移行を走らせ、WALを畳んでから閉じる。
// (WALを畳んでおくと、.sqlite 単体のコピーで全データが入った状態になる)
const initDbInDir = (dataDir) => {
	const code = `const db=require(${JSON.stringify(DB_JS)});try{db.pragma("wal_checkpoint(TRUNCATE)")}catch(e){};db.close();`;
	execFileSync(process.execPath, ["-e", code], {
		env: {...process.env, DATA_DIR: dataDir, DATABASE_BACKEND: "sqlite", LOG_LEVEL: "error"},
		stdio: "pipe"
	});
};

const versionFiles = (dbDir) => fs.readdirSync(dbDir)
	.map((f) => /^document_manager_v(\d+)\.sqlite$/.exec(f))
	.filter(Boolean)
	.map((m) => Number(m[1]));

test("最新化でapp_settings(機能On/Off)が引き継がれる", () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mig-"));
	const dbDir = path.join(dataDir, "db");
	try {
		// 1) まず最新スキーマのDBを作る
		initDbInDir(dataDir);
		const current = Math.max(...versionFiles(dbDir));
		assert.ok(current >= 18, "app_settingsが存在するv18以降で検証する");
		const previous = current - 1;
		const currentPath = path.join(dbDir, `document_manager_v${current}.sqlite`);
		const previousPath = path.join(dbDir, `document_manager_v${previous}.sqlite`);

		// 2) 最新DBを「1つ前のバージョン」ファイルとして複製し、機能ONを書き込む
		//    (スキーマは最新と同形。移行はコピー対象の列挙だけが問題なので、これで十分検証できる)
		fs.copyFileSync(currentPath, previousPath);
		const old = new Database(previousPath);
		old.prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)")
			.run("mockups.enabled", "true", "tester", new Date().toISOString());
		old.pragma("wal_checkpoint(TRUNCATE)");
		old.close();

		// 3) 最新DBと付随WALを消して、previous→current の移行を強制する
		for (const suffix of ["", "-wal", "-shm"]) {
			try { fs.rmSync(currentPath + suffix); } catch {}
		}

		// 4) 再初期化 → 最新化(移行)が走る
		initDbInDir(dataDir);

		// 5) 最新DBに設定が引き継がれていること(これが欠けていると最新化のたびにOffへ戻る)
		const neu = new Database(currentPath, {readonly: true});
		const row = neu.prepare("SELECT value FROM app_settings WHERE key = ?").get("mockups.enabled");
		neu.close();
		assert.ok(row, "移行後も app_settings の行が残っている");
		assert.equal(row.value, "true", "モックアップ機能のOnが最新化後も保持される");
	} finally {
		try { fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 3}); } catch {}
	}
});
