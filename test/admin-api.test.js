/*!
 * admin-api.test.js : 管理の WebAPI の土台(監査ログの絞り込み・続き、最後の管理者を守る決まり、最終ログイン)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 * 一時ディレクトリを DATA_DIR にして実 SQLite で動かす。WebAPI の形は test/api/admin-api.spec.js で確かめる。
 * ここでは、件数が多くないと通らない道(100 件を超えたときの続き)と、
 * 管理者が 1 人だけの台帳(API の試験では作れない)を確かめる。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-admin-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const ds = require("../app/lib/datastore.js");
const AuditLog = require("../app/lib/audit-log.js");
const AllowedUsers = require("../app/lib/allowed-users.js");

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();

/** 日時を決めて 1 行入れる(record は今の時刻を使うので、ここでは直接入れる) */
const insert = async (row) => {
	await ds.run(`
		INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at, target_user, detail, target, result, via, key_role, ip)
		VALUES (@id, @user_identifier, @action, @document_id, @entry_file, @project_id, @project_name, @created_at, @target_user, NULL, @target, @result, @via, @key_role, @ip)
	`, {
		id: row.id ?? crypto.randomUUID(), user_identifier: row.user ?? "a@example.com", action: row.action ?? "upload",
		document_id: row.documentId ?? null, entry_file: row.entryFile ?? null, project_id: null, project_name: row.projectName ?? null,
		created_at: row.at, target_user: row.targetUser ?? null, target: row.target ?? null,
		result: row.result ?? null, via: row.via ?? null, key_role: row.keyRole ?? null, ip: row.ip ?? null
	});
};

test("監査ログ: 新しい順・期間・利用者と対象の部分一致(大文字小文字を区別しない)・操作の一致", async () => {
	await ds.run("DELETE FROM audit_log");
	await insert({at: minutesAgo(10), user: "Alice@Example.com", action: "upload", entryFile: "設計書.md", result: "success", via: "screen", ip: "192.0.2.1"});
	await insert({at: minutesAgo(20), user: "bob@example.com", action: "user_add", targetUser: "carol@example.com", via: "screen"});
	await insert({at: minutesAgo(30), user: "bob@example.com", action: "access_denied", target: "PUT api/admin/users/x", result: "denied", via: "apikey", keyRole: "readwrite"});
	await insert({at: minutesAgo(60 * 24 * 3), user: "alice@example.com", action: "upload", entryFile: "古い.md"});
	await insert({at: minutesAgo(60 * 24 * 20), user: "alice@example.com", action: "delete", entryFile: "もっと古い.md"});

	const week = await AuditLog.listAll({now: NOW});
	assert.deepEqual(week.entries.map((e) => e.target), ["設計書.md", "carol@example.com", "PUT api/admin/users/x", "古い.md"], "既定は 7 日。新しい順");
	assert.equal(week.nextBefore, null);

	assert.equal((await AuditLog.listAll({range: "1d", now: NOW})).entries.length, 3, "1d は直前の 24 時間");
	assert.equal((await AuditLog.listAll({range: "30d", now: NOW})).entries.length, 5);
	assert.deepEqual((await AuditLog.listAll({user: "ALICE", now: NOW})).entries.map((e) => e.target), ["設計書.md", "古い.md"]);
	assert.deepEqual((await AuditLog.listAll({action: "user_add", now: NOW})).entries.map((e) => e.user), ["bob@example.com"]);
	assert.deepEqual((await AuditLog.listAll({target: "CAROL", now: NOW})).entries.map((e) => e.action), ["user_add"], "人が対象の操作も対象で探せる");
	assert.deepEqual((await AuditLog.listAll({target: "設計", now: NOW})).entries.map((e) => e.action), ["upload"]);

	const denied = (await AuditLog.listAll({action: "access_denied", now: NOW})).entries[0];
	assert.equal(denied.result, "denied");
	assert.equal(denied.via, "apikey");
	assert.equal(denied.keyRole, "readwrite");

	// 列を足す前の行(結果・経路・IP が無い)は、成功・経路と IP は不明として返す
	const old = (await AuditLog.listAll({target: "古い.md", now: NOW})).entries[0];
	assert.equal(old.result, "success");
	assert.equal(old.via, null);
	assert.equal(old.ip, null);
});

test("監査ログ: % と _ は、そのままの文字として探す(何にでも当たる印にしない)", async () => {
	await ds.run("DELETE FROM audit_log");
	await insert({at: minutesAgo(1), target: "100%_done"});
	await insert({at: minutesAgo(2), target: "100 done"});
	assert.deepEqual((await AuditLog.listAll({target: "%_", now: NOW})).entries.map((e) => e.target), ["100%_done"]);
	assert.deepEqual((await AuditLog.listAll({user: "%", now: NOW})).entries, []);
});

test("監査ログ: 100 件を超えたら nextBefore で続きを読める。同じ日時の行も、取りこぼさず、重ねない", async () => {
	await ds.run("DELETE FROM audit_log");
	const sameAt = minutesAgo(5);
	for (let i = 0; i < 150; i += 1) {
		await insert({id: `row-${String(i).padStart(3, "0")}`, at: i < 120 ? sameAt : minutesAgo(10 + i), target: `t${i}`});
	}
	const first = await AuditLog.listAll({now: NOW});
	assert.equal(first.entries.length, AuditLog.AUDIT_PAGE_SIZE);
	assert.ok(first.nextBefore);
	const second = await AuditLog.listAll({before: first.nextBefore, now: NOW});
	assert.equal(second.entries.length, 50);
	assert.equal(second.nextBefore, null);
	const ids = [...first.entries, ...second.entries].map((e) => e.id);
	assert.equal(new Set(ids).size, 150, "全部の行が、1 回ずつ出る");
});

test("監査ログ: 正しくない絞り込みは 400 の元(status 400 の Error)", async () => {
	await assert.rejects(AuditLog.listAll({range: "2d"}), (err) => err.status === 400);
	await assert.rejects(AuditLog.listAll({user: ["a", "b"]}), (err) => err.status === 400, "同じ名前を 2 回渡したとき");
	await assert.rejects(AuditLog.listAll({target: "x".repeat(201)}), (err) => err.status === 400);
});

test("監査ログ: record は結果・経路・IP を残し、本人の操作履歴(api/history)には管理の操作を混ぜない", async () => {
	await ds.run("DELETE FROM audit_log");
	await AuditLog.record({userIdentifier: "me@example.com", action: "upload", documentId: "d1", entryFile: "a.md", via: "apikey", keyRole: "readwrite", ip: "198.51.100.7"});
	await AuditLog.record({userIdentifier: "me@example.com", action: "user_add", targetUser: "x@example.com", via: "screen"});
	await AuditLog.record({userIdentifier: "me@example.com", action: "access_denied", target: "GET api/admin/users", result: AuditLog.RESULTS.DENIED});
	const all = await AuditLog.listAll({});
	assert.equal(all.entries.length, 3);
	const upload = all.entries.find((e) => e.action === "upload");
	assert.deepEqual({via: upload.via, keyRole: upload.keyRole, ip: upload.ip, result: upload.result}, {via: "apikey", keyRole: "readwrite", ip: "198.51.100.7", result: "success"});
	assert.deepEqual((await AuditLog.listMine("me@example.com")).map((row) => row.action), ["upload"]);
});

test("利用者: 最後の管理者は、下げることも外すこともできない(ほかに管理者が居れば、できる)", async () => {
	await ds.run("DELETE FROM allowed_users");
	assert.equal(await AllowedUsers.addNew("Boss@Example.com", "admin", "test"), "added");
	assert.equal(await AllowedUsers.addNew("boss@example.com", "readonly", "test"), "exists", "大文字小文字だけ違うメールアドレスは、同じ人");
	assert.equal(await AllowedUsers.addNew("member@example.com", "readwrite", "test"), "added");

	assert.deepEqual(await AllowedUsers.changeRole("boss@example.com", "readwrite"), {status: "last_admin"});
	assert.deepEqual(await AllowedUsers.remove("boss@example.com"), {status: "last_admin"});
	assert.equal((await AllowedUsers.find("boss@example.com")).role, "admin", "断ったときは、何も変えない");
	assert.deepEqual(await AllowedUsers.changeRole("boss@example.com", "admin"), {status: "changed", previousRole: "admin"}, "管理者のままにするのは構わない");
	assert.deepEqual(await AllowedUsers.changeRole("nobody@example.com", "readonly"), {status: "not_found"});
	assert.deepEqual(await AllowedUsers.remove("nobody@example.com"), {status: "not_found"});

	assert.deepEqual(await AllowedUsers.changeRole("member@example.com", "admin"), {status: "changed", previousRole: "readwrite"});
	assert.deepEqual(await AllowedUsers.changeRole("boss@example.com", "readonly"), {status: "changed", previousRole: "admin"}, "ほかに管理者が居れば下げられる");
	assert.deepEqual(await AllowedUsers.remove("member@example.com"), {status: "last_admin"}, "今度は member が最後の管理者");
	assert.deepEqual(await AllowedUsers.remove("boss@example.com"), {status: "removed", previousRole: "readonly"});
	assert.equal(await AllowedUsers.find("boss@example.com"), null);
});

test("利用者: ログインした時刻を残し、一覧で返す", async () => {
	await ds.run("DELETE FROM allowed_users");
	await AllowedUsers.addNew("login@example.com", "readonly", "test");
	assert.equal((await AllowedUsers.listAllowedUsers())[0].last_login_at, null);
	await AllowedUsers.recordLogin("LOGIN@example.com", "2026-10-24T01:02:03.000Z");
	assert.equal((await AllowedUsers.listAllowedUsers())[0].last_login_at, "2026-10-24T01:02:03.000Z");
});
