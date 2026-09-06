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
	ds.subscribe(["documents_changed", "projects_changed"], (channel) => received.push(channel));

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
});

test.after(async () => {
	if (ds && ds.backend === "postgres") {
		await ds.close(); // pool/LISTEN接続を閉じてプロセスを終了可能にする
	}
});
