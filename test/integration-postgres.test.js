/*!
 * integration-postgres.test.js : Postgresバックエンド固有の結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実 Postgres を要するテスト。実行にはPostgresへのURLが必要:
 *   DATABASE_BACKEND=postgres DATABASE_URL=postgres://user:pass@host:5432/db npm run test:pg
 * 未設定(sqlite等)の場合は全テストをスキップする(通常の `npm test` からは分離)。
 *
 * 主目的は LISTEN/NOTIFY(横断SSEのバックプレーン)の実機確認。datastore.notify が
 * datastore.subscribe のハンドラへ実際に届くこと(pg_notify → 専用LISTEN接続 → 通知イベント)を
 * 検証する。単一プロセスでも LISTEN 接続は notify を出すプール接続とは別セッションのため、
 * 「別インスタンスの購読へ届く」のと同じ経路を通る。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const pgAvailable = process.env.DATABASE_BACKEND === "postgres" && !!process.env.DATABASE_URL;
const skip = pgAvailable ? false : "DATABASE_BACKEND=postgres と DATABASE_URL が必要(未設定のためスキップ)";

let ds;

test("postgres datastore が初期化できる(schema_migrations適用)", {skip}, async () => {
	ds = require("../app/lib/datastore.js");
	assert.equal(ds.backend, "postgres");
	await ds.init();
	const row = await ds.get("SELECT COALESCE(MAX(version),0)::int AS v FROM schema_migrations");
	assert.ok(row.v >= 1, "マイグレーションが1件以上適用されている");
});

test("LISTEN/NOTIFY: notify が subscribe ハンドラへ届く", {skip}, async () => {
	ds = ds || require("../app/lib/datastore.js");
	await ds.init();

	const received = [];
	const payloads = [];
	// server.js と同じく、使うチャンネルは1回の subscribe でまとめて購読する
	// (LISTEN接続は最初の subscribe で確立されるため)
	ds.subscribe(["documents_changed", "projects_changed", "document_activity"], (channel, payload) => {
		received.push(channel);
		payloads.push({channel, payload});
	});

	// 専用LISTEN接続が確立されるのを少し待つ(subscribeは非同期に接続を張る)
	await new Promise((r) => setTimeout(r, 1200));

	await ds.notify("projects_changed");

	// 通知が届くまでポーリング(最大5秒)
	const deadline = Date.now() + 5000;
	while (!received.includes("projects_changed") && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(received.includes("projects_changed"), "projects_changed の通知がLISTENハンドラへ届く");

	// 別チャンネルも同様に届く
	await ds.notify("documents_changed");
	const deadline2 = Date.now() + 5000;
	while (!received.includes("documents_changed") && Date.now() < deadline2) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(received.includes("documents_changed"), "documents_changed の通知がLISTENハンドラへ届く");

	// 操作のポップアップ通知用: ペイロード(JSON文字列)がそのままハンドラへ届く
	const activity = JSON.stringify({action: "upload", documentId: "d1", entryFile: "報告書.md", user: "a@example.com", viaApiKey: false});
	await ds.notify("document_activity", activity);
	const deadline3 = Date.now() + 5000;
	while (!received.includes("document_activity") && Date.now() < deadline3) {
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal(payloads.find((p) => p.channel === "document_activity")?.payload, activity, "document_activity のペイロードが届く");
});

test("管理の監査ログ: 部分一致(% と _ はそのままの文字)・続き・結果と経路(PostgreSQL の LIKE と ESCAPE)", {skip}, async () => {
	ds = ds || require("../app/lib/datastore.js");
	await ds.init();
	const AuditLog = require("../app/lib/audit-log.js");
	await ds.run("DELETE FROM audit_log");
	await AuditLog.record({userIdentifier: "PgAdmin@Example.com", action: "user_add", targetUser: "new@example.com", via: "screen", ip: "192.0.2.5"});
	await AuditLog.record({userIdentifier: "pgadmin@example.com", action: "access_denied", target: "100%_done", result: AuditLog.RESULTS.DENIED, via: "apikey", keyRole: "readonly"});
	await AuditLog.record({userIdentifier: "other@example.com", action: "upload", entryFile: "100 done.md"});

	assert.deepEqual((await AuditLog.listAll({user: "PGADMIN"})).entries.map((e) => e.action).sort(), ["access_denied", "user_add"], "大文字小文字を区別しない");
	assert.deepEqual((await AuditLog.listAll({target: "%_"})).entries.map((e) => e.target), ["100%_done"], "% と _ はそのままの文字");
	const denied = (await AuditLog.listAll({action: "access_denied"})).entries[0];
	assert.deepEqual({result: denied.result, via: denied.via, keyRole: denied.keyRole}, {result: "denied", via: "apikey", keyRole: "readonly"});
	const added = (await AuditLog.listAll({action: "user_add"})).entries[0];
	assert.deepEqual({target: added.target, ip: added.ip}, {target: "new@example.com", ip: "192.0.2.5"});

	for (let i = 0; i < 105; i += 1) await AuditLog.record({userIdentifier: "bulk@example.com", action: "upload", entryFile: `bulk-${i}.md`});
	const first = await AuditLog.listAll({user: "bulk"});
	const second = await AuditLog.listAll({user: "bulk", before: first.nextBefore});
	assert.equal(first.entries.length + second.entries.length, 105);
	assert.equal(second.nextBefore, null);
	await ds.run("DELETE FROM audit_log");
});

test("利用者: 最後の管理者は下げも外しもできない・最終ログイン(PostgreSQL の 1 文での確かめ)", {skip}, async () => {
	ds = ds || require("../app/lib/datastore.js");
	await ds.init();
	const AllowedUsers = require("../app/lib/allowed-users.js");
	await ds.run("DELETE FROM allowed_users WHERE email LIKE ?", ["%@pg-admin.test"]);
	const before = await ds.get("SELECT COUNT(*)::int AS n FROM allowed_users WHERE role = ?", ["admin"]);
	if (before.n > 0) return; // 共有の DB に管理者が居るときは、最後の 1 人を作れない
	assert.equal(await AllowedUsers.addNew("only@pg-admin.test", "admin", "test"), "added");
	assert.equal(await AllowedUsers.addNew("ONLY@pg-admin.test", "readonly", "test"), "exists");
	assert.deepEqual(await AllowedUsers.changeRole("only@pg-admin.test", "readonly"), {status: "last_admin"});
	assert.deepEqual(await AllowedUsers.remove("only@pg-admin.test"), {status: "last_admin"});
	await AllowedUsers.addNew("second@pg-admin.test", "admin", "test");
	assert.deepEqual(await AllowedUsers.changeRole("only@pg-admin.test", "readonly"), {status: "changed", previousRole: "admin"});
	assert.deepEqual(await AllowedUsers.remove("only@pg-admin.test"), {status: "removed", previousRole: "readonly"});
	await AllowedUsers.recordLogin("second@pg-admin.test", "2026-10-24T00:00:00.000Z");
	assert.equal((await AllowedUsers.find("second@pg-admin.test")).role, "admin");
	const row = await ds.get("SELECT last_login_at FROM allowed_users WHERE email = ?", ["second@pg-admin.test"]);
	assert.equal(row.last_login_at, "2026-10-24T00:00:00.000Z");
	await ds.run("DELETE FROM allowed_users WHERE email LIKE ?", ["%@pg-admin.test"]);
});

test.after(async () => {
	if (ds && ds.backend === "postgres") {
		await ds.close(); // pool/LISTEN接続を閉じてプロセスを終了可能にする
	}
});
