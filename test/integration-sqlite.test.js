/*!
 * integration-sqlite.test.js : 各リポジトリモジュールのSQLite結合テスト(層2)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 * 一時ディレクトリを DATA_DIR にして実SQLiteに対して各モジュールを動かす(外部サービス不要)。
 * Postgres特有の挙動(方言・接続)はここでは検証しない(必要なら別途PGを立てて確認する)。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-itg-"));

const test = require("node:test");
const assert = require("node:assert/strict");

const ds = require("../app/lib/datastore.js");
const Projects = require("../app/lib/projects.js");
const AllowedUsers = require("../app/lib/allowed-users.js");
const ApiKeys = require("../app/lib/api-keys.js");
const TagOrder = require("../app/lib/tag-order.js");
const AuditLog = require("../app/lib/audit-log.js");

test("projects: 作成→フォルダ(root/child)→配置(root/folder)→ツリー→並替→削除", async () => {
	const proj = await Projects.createProject("  テスト  ", "tester");
	assert.ok(proj.id, "idが採番される");
	assert.equal(proj.name, "テスト", "名前は前後空白がtrimされる");
	assert.equal(proj.locked, false, "初期状態は解錠(0→false)");

	const root = await Projects.createFolder(proj.id, "root", null, "tester");
	const child = await Projects.createFolder(proj.id, "child", root.id, "tester");
	assert.equal(child.parentFolderId, root.id, "子フォルダの親が正しい");

	await Projects.placeDocument(proj.id, "docA", root.id, "tester"); // フォルダ内
	await Projects.placeDocument(proj.id, "docB", null, "tester");    // プロジェクト直下
	await Projects.placeDocument(proj.id, "docA", root.id, "tester"); // upsert(重複しない)

	const tree = await Projects.getProjectTree(proj.id);
	assert.equal(tree.folders.length, 2);
	assert.equal(tree.documents.length, 2, "upsertで重複登録されない");

	await Projects.reorderDocuments(proj.id, root.id, ["docA"]);
	assert.equal(await Projects.deleteProject(proj.id), true);
	assert.equal(await Projects.getProject(proj.id), null, "削除後は取得できない");
});

test("projects: アーカイブ/復元/施錠/改名", async () => {
	const proj = await Projects.createProject("p2", "tester");
	assert.equal(await Projects.archiveProject(proj.id, "tester"), true);
	assert.equal((await Projects.getProject(proj.id)).archivedAt != null, true);
	assert.equal(await Projects.restoreProject(proj.id), true);
	assert.equal(await Projects.setProjectLocked(proj.id, true), true);
	assert.equal((await Projects.getProject(proj.id)).locked, true);
	assert.equal(await Projects.renameProject(proj.id, "renamed"), true);
	assert.equal((await Projects.getProject(proj.id)).name, "renamed");
	await Projects.deleteProject(proj.id);
});

test("allowed-users: 追加→ロール判定→変更→削除", async () => {
	const email = "user@example.com";
	await AllowedUsers.addAllowedUser(email, "readonly", "tester");
	assert.equal(await AllowedUsers.getRole(email), "readonly");
	assert.equal(await AllowedUsers.isAllowed(email), true);
	assert.equal(await AllowedUsers.isAdmin(email), false);

	assert.equal(await AllowedUsers.updateAllowedUserRole(email, "admin"), true);
	assert.equal(await AllowedUsers.isAdmin(email), true);

	assert.equal(await AllowedUsers.removeAllowedUser(email), true);
	assert.equal(await AllowedUsers.getRole(email), null, "削除後は未許可");
	assert.equal(await AllowedUsers.isAllowed(email), false);
});

test("api-keys: 発行→検証→失効→失効後は無効", async () => {
	const owner = "owner@example.com";
	const created = await ApiKeys.createApiKey("label", "readonly", "30d", owner);
	assert.ok(created.apiKey.startsWith("dm_"), "平文キーが返る");

	const verified = await ApiKeys.verifyApiKey(created.apiKey);
	assert.equal(verified.status, "ok");
	assert.equal(verified.row.role, "readonly");

	const list = await ApiKeys.listApiKeys(owner);
	assert.equal(list.length, 1);

	assert.equal(await ApiKeys.revokeApiKeyById(created.id, owner), true);
	assert.equal((await ApiKeys.verifyApiKey(created.apiKey)).status, "invalid", "失効後は無効");
	assert.equal((await ApiKeys.verifyApiKey("dm_nonexistent")).status, "invalid", "存在しないキーは無効");
});

test("tag-order: 全件置換で空白・重複を除去し順序を保持", async () => {
	const saved = await TagOrder.replaceTagOrder(["設計", "  ", "要件", "設計"], "tester");
	assert.deepEqual(saved, ["設計", "要件"], "空白と重複が除去される");
	const listed = await TagOrder.listTagOrder();
	assert.deepEqual(listed.map((r) => r.tag), ["設計", "要件"]);
	assert.deepEqual(listed.map((r) => r.sortOrder), [0, 1], "配列順がsortOrderになる");
});

test("audit-log: 記録して本人分を新しい順で取得", async () => {
	const uid = "audit-user@example.com";
	await AuditLog.record({userIdentifier: uid, action: "upload", documentId: "d1", entryFile: "a.txt"});
	await AuditLog.record({userIdentifier: uid, action: "delete", documentId: "d1", entryFile: "a.txt"});
	const list = await AuditLog.listMine(uid);
	assert.equal(list.length, 2);
	assert.equal(list[0].action, "delete", "新しい順(created_at DESC)");
});

test.after(() => {
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true});
	} catch {}
});
