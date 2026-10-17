/*!
 * miro-periodic.test.js : Miro の定期の見回りの順番取り(app/lib/miro-sync.js の claimPeriodicCheck)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 複数台(ECS など)で動かしても、同じ間隔のうちに同じプロジェクトを 2 回見回らないこと。
 * 間隔が過ぎれば、また見回れること。連動していないプロジェクトは見回らないこと。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-miro-periodic-"));
process.env.DATABASE_BACKEND = "sqlite";
process.env.LOG_LEVEL = "error";
process.env.SESSION_SECRET = "miro-periodic-test";
delete process.env.MIRO_SYNC_INTERVAL_MINUTES;

const ds = require("../app/lib/datastore.js");
const MiroSync = require("../app/lib/miro-sync.js");

const link = async (projectId, state = "active") => ds.run(
	`INSERT INTO miro_projects (project_id, board_id, state) VALUES (?, ?, ?)`, [projectId, "board", state]);

test.before(async () => {
	await ds.init?.();
});

test("同じ間隔のうちは 1 台だけが見回れる(2 台目は飛ばす)", async () => {
	await link("p1");
	const now = Date.parse("2026-10-17T10:00:00Z");
	assert.equal(await MiroSync.claimPeriodicCheck("p1", now), true, "1 台目");
	assert.equal(await MiroSync.claimPeriodicCheck("p1", now + 1000), false, "2 台目(同じ頃)");
	assert.equal(await MiroSync.claimPeriodicCheck("p1", now + 30 * 60 * 1000), false, "30 分後(まだ間隔のうち)");
});

test("間隔(の 9 割)が過ぎれば、また見回れる", async () => {
	await link("p2");
	const now = Date.parse("2026-10-17T10:00:00Z");
	assert.equal(await MiroSync.claimPeriodicCheck("p2", now), true);
	assert.equal(await MiroSync.claimPeriodicCheck("p2", now + 55 * 60 * 1000), true);
});

test("連動していない(止めた)プロジェクトは見回らない", async () => {
	await link("p3", "stopped");
	assert.equal(await MiroSync.claimPeriodicCheck("p3", Date.now()), false);
});

test("既定の間隔は 60 分", () => {
	assert.equal(MiroSync.INTERVAL_MS, 60 * 60 * 1000);
});
