/*!
 * vacuum.test.js : SQLite のファイルを詰める(VACUUM)と、メンテナンス中の検証
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 何を確かめるか: 表を消してもファイルは小さくならず、VACUUM で小さくなる(-wal も 0 に戻る)・詰めている間は本体の接続の書き込みが
 *   待たずに失敗する・メンテナンス中は API が 503 maintenance、画面の要求はメンテナンス中のページ(10 秒ごとに読み直す)、
 *   _ping・api/maintenance・画面の殻は通す・走っている間は始められない・始めたことが監査ログに残る。
 * なぜあるか: 詰めている間に本体の接続から書くと、長く待たされて _ping も返らなくなるので、止め方がずれていないことを確かめるため。
 * サーバーは同じプロセスで動かす(開発モード。管理者として通る。データは一時のフォルダ)。
 * APIキーでは始められないこと(画面でログインした管理者だけ)は、test/api/database-vacuum.spec.js で確かめる。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-vacuum-"));
Object.assign(process.env, {DATABASE_BACKEND: "sqlite", DATA_DIR: dataDir, AUTH_DISABLED: "true", RATE_LIMIT_DISABLED: "true", LOG_LEVEL: "error"});
delete process.env.SQLITE_TMPDIR;

const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");

const {app} = require("../app/server.js");
const db = require("../app/lib/db.js");
const Vacuum = require("../app/lib/vacuum.js");
const AuditLog = require("../app/lib/audit-log.js");

let server = null;
let base = null;

before(async () => {
	server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}/`;

	// 大きめの表を作ってから消す(空いたページが残る)
	db.exec("CREATE TABLE vacuum_scratch (id INTEGER PRIMARY KEY, body TEXT)");
	const insert = db.prepare("INSERT INTO vacuum_scratch (body) VALUES (?)");
	const padding = "x".repeat(1000);
	db.transaction(() => {
		for (let i = 0; i < 3000; i += 1) insert.run(padding);
	})();
	db.exec("DROP TABLE vacuum_scratch");
});

after(async () => {
	await Vacuum.wait();
	if (server) await new Promise((resolve) => server.close(resolve));
	db.close();
	fs.rmSync(dataDir, {recursive: true, force: true});
});

const call = async (method, urlPath, {body, headers = {}} = {}) => {
	const h = {Accept: "application/json", ...headers};
	if (body !== undefined) h["Content-Type"] = "application/json";
	const res = await fetch(base + urlPath, {method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual"});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch (err) { /* JSON でない応答 */ }
	return {status: res.status, json, text, headers: res.headers};
};

test("SQLITE_TMPDIR はデータのフォルダ(最初にファイルを開く前に入れる)", () => {
	assert.equal(path.resolve(process.env.SQLITE_TMPDIR), path.resolve(dataDir, "db"));
});

test("消した後は空いている所があり、VACUUM で小さくなる(-wal も 0 に戻る)", async () => {
	const before = (await call("GET", "api/database/vacuum")).json;
	assert.equal(before.available, true);
	assert.equal(before.running, false);
	assert.equal(before.fileName, path.basename(db.DB_PATH));
	assert.ok(before.freeBytes > 1000000, `空いている所 ${before.freeBytes}`);
	assert.equal(before.enoughSpace, true);
	// ファイルの場所(パス)は返さない
	assert.equal(JSON.stringify(before).includes(dataDir.replace(/\\/g, "\\\\")), false);

	const started = await call("POST", "api/database/vacuum", {body: {}});
	assert.equal(started.status, 202, started.text);
	assert.equal(started.json.running, true);

	await Vacuum.wait();
	// 詰めた後に wal_checkpoint(TRUNCATE) で -wal を 0 にしている(次の書き込みより前に見る)
	assert.equal(fs.statSync(`${db.DB_PATH}-wal`).size, 0);
	const done = (await call("GET", "api/database/vacuum")).json;
	assert.equal(done.running, false);
	assert.equal(done.error, null);
	assert.equal(done.startedBy, "dev-user");
	assert.ok(done.afterBytes < done.beforeBytes, `${done.beforeBytes} → ${done.afterBytes}`);
	assert.ok(done.freeBytes < before.freeBytes);
	// 終わった後は、また読み書きでき、busy_timeout も元に戻る
	assert.equal(db.pragma("busy_timeout", {simple: true}), 5000);
	assert.equal((await call("GET", "api/documents")).status, 200);
});

test("詰めている間は、本体の接続の書き込みが待たずに失敗する(SQLITE_BUSY)", async () => {
	// 別の接続で書き込みの鍵を持ち、詰めている間を作る(better-sqlite3 は app/node_modules にある)
	const Database = require("../app/node_modules/better-sqlite3");
	const other = new Database(db.DB_PATH);
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	other.exec("BEGIN IMMEDIATE");
	const running = db.runMaintenance(() => held);
	try {
		assert.equal(db.isMaintenance(), true);
		assert.equal(db.pragma("busy_timeout", {simple: true}), 0);
		const startedMs = Date.now();
		assert.throws(() => db.prepare("INSERT INTO app_settings (key, value) VALUES ('vacuum-test', '1')").run(),
			(err) => err.code === "SQLITE_BUSY");
		assert.ok(Date.now() - startedMs < 1000, "待たずに失敗する");
		await assert.rejects(db.runMaintenance(async () => {}), (err) => err.code === "DB_MAINTENANCE");
	} finally {
		other.exec("ROLLBACK");
		other.close();
		release();
		await running;
	}
	assert.equal(db.isMaintenance(), false);
	assert.equal(db.pragma("busy_timeout", {simple: true}), 5000);
});

test("詰めている間はメンテナンス中: API は 503 maintenance、画面の要求はメンテナンス中のページ、_ping・api/maintenance・画面の殻は通す", async () => {
	await Vacuum.wait();
	assert.deepEqual((await call("GET", "api/maintenance")).json, {maintenance: false, reason: null, startedAt: null});
	// 走っている間を作る(server.js は要求のたびに Vacuum.isRunning を見る)
	const original = Vacuum.isRunning;
	Vacuum.isRunning = () => true;
	try {
		const list = await call("GET", "api/documents");
		assert.equal(list.status, 503);
		assert.equal(list.json.code, "maintenance");
		assert.equal(typeof list.json.error, "string");
		assert.equal(list.headers.get("retry-after"), "30");
		const upload = await call("POST", "api/documents", {body: {}});
		assert.equal(upload.status, 503);
		assert.equal(upload.json.code, "maintenance");
		// 画面の要求(ログインなど)はメンテナンス中のページ。10 秒ごとに読み直す
		const login = await call("GET", "login", {headers: {Accept: "text/html"}});
		assert.equal(login.status, 503);
		assert.match(login.text, /メンテナンス中/);
		assert.match(login.text, /データベースのメンテナンス中です/);
		assert.match(login.text, /<meta http-equiv="refresh" content="10">/);
		assert.equal((await call("GET", "_ping")).status, 200);
		const state = await call("GET", "api/maintenance");
		assert.equal(state.status, 200);
		assert.equal(state.json.maintenance, true);
		assert.equal(state.json.reason, "vacuum");
		// 画面の殻(static)は出す(画面がメンテナンス中の画面を出せるように)
		assert.equal((await fetch(base)).status, 200);
		assert.equal((await fetch(base + "maintenance.js")).status, 200);
		// 走っている間は、もう 1 回は始められない(メンテナンス中として断る)
		assert.equal((await call("POST", "api/database/vacuum", {body: {}})).status, 503);
	} finally {
		Vacuum.isRunning = original;
	}
	assert.equal((await call("GET", "api/documents")).status, 200);
});

test("始めた記録が監査ログに残る(db_vacuum)", async () => {
	await Vacuum.wait();
	const {entries} = await AuditLog.listAll({action: "db_vacuum"});
	assert.ok(entries.length >= 1);
	assert.equal(entries[0].action, "db_vacuum");
	assert.equal(entries[0].target, path.basename(db.DB_PATH));
	assert.equal(AuditLog.ACTION_LABELS.db_vacuum, "DB のファイルを詰める(VACUUM)");
});
