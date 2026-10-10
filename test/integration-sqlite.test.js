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
const Sessions = require("../app/lib/sessions.js");
// sessions テーブルはセッションストアが作る(業務スキーマの移行対象外のため)
require("../app/lib/session-store.js").createSessionStore({Store: class {}});

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

// ---- セッションの切断 ----
// ここが甘いと「切ったはずの相手がまだ入れる」。画面では切断済みに見えるので、誰も気づけない

const putSession = async (sid, user, extra = {}) => {
	const data = {cookie: {}, user: {identifier: user}, ...extra};
	await ds.run(
		"INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data",
		[sid, JSON.stringify(data), Date.now() + 60 * 60 * 1000]
	);
	return data;
};
const ago = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

test("sessions: 利用者のセッションをまとめて切り、他の人は巻き込まない", async () => {
	await putSession("sid-a1", "cut@example.com", {loginAt: ago(60), ip: "203.0.113.1", userAgent: "UA-1"});
	await putSession("sid-a2", "cut@example.com", {loginAt: ago(30), ip: "203.0.113.2", userAgent: "UA-2"});
	await putSession("sid-b1", "other@example.com", {loginAt: ago(10)});

	const result = await Sessions.revokeUser("cut@example.com", {revokedBy: "admin@example.com"});
	assert.equal(result.sessions.length, 2);
	// 履歴に残す手がかり。切った後では取り直せない
	assert.deepEqual(result.sessions.map((s) => s.ip).sort(), ["203.0.113.1", "203.0.113.2"]);

	const byUser = await Sessions.listByUser(null);
	assert.equal(byUser.has("cut@example.com"), false, "切った相手が一覧に残っている");
	assert.equal(byUser.get("other@example.com").length, 1, "関係ない人を巻き込んでいる");
});

// express-session は応答の最後にセッションを書き戻す。消した直後に処理中だった要求があると、
// 行が復活する。行の有無だけで判定していると、ここで切断をすり抜けられる
test("sessions: 切断の後に行が書き戻されても、通さない", async () => {
	const stale = await putSession("sid-race", "race@example.com", {loginAt: ago(60)});
	await Sessions.revokeUser("race@example.com", {revokedBy: "admin@example.com"});
	// 処理中だった要求が、古い中身のまま書き戻した状態
	await putSession("sid-race", "race@example.com", {loginAt: stale.loginAt});

	assert.equal(await Sessions.isSessionAlive(stale), false, "書き戻されたセッションが通っている");
	assert.equal((await Sessions.listByUser(null)).has("race@example.com"), false, "ログイン中として一覧に出ている");
});

test("sessions: 切断の後にログインし直したものは通る", async () => {
	await putSession("sid-old", "relogin@example.com", {loginAt: ago(60)});
	const {revokedAt} = await Sessions.revokeUser("relogin@example.com", {revokedBy: "admin@example.com"});
	const fresh = {user: {identifier: "relogin@example.com"}, loginAt: new Date(Date.parse(revokedAt) + 1000).toISOString()};
	assert.equal(await Sessions.isSessionAlive(fresh), true, "締め出しになってしまっている(今回の範囲外)");
});

// この機能を入れる前からログインしていた人。ログイン時刻が無いので、切断の前後を判定できない
test("sessions: ログイン時刻を持たない古いセッションは、切断があれば通さない", async () => {
	const legacy = await putSession("sid-legacy", "legacy@example.com");
	assert.equal(await Sessions.isSessionAlive(legacy), true, "切断していないのに通らない");
	await Sessions.revokeUser("legacy@example.com", {revokedBy: "admin@example.com"});
	assert.equal(await Sessions.isSessionAlive(legacy), false);
});

test("sessions: 自分を切るときは、操作中のセッションだけ残せる", async () => {
	await putSession("sid-mine", "self@example.com", {loginAt: ago(60)});
	await putSession("sid-elsewhere", "self@example.com", {loginAt: ago(30)});
	const {revokedAt, sessions} = await Sessions.revokeUser("self@example.com", {revokedBy: "self@example.com", exceptSid: "sid-mine"});
	assert.equal(sessions.length, 1, "操作中のものまで切っている");

	// 残したセッションには、その切断を生き延びた印を付ける(付けないと次の要求で弾かれる)
	const mine = {user: {identifier: "self@example.com"}, loginAt: ago(60), survivedRevocationAt: revokedAt};
	assert.equal(await Sessions.isSessionAlive(mine), true);
	// 次にもう一度切られたら、その印では通らない
	await new Promise((resolve) => setTimeout(resolve, 5));
	await Sessions.revokeUser("self@example.com", {revokedBy: "admin@example.com"});
	assert.equal(await Sessions.isSessionAlive(mine), false, "古い印で次の切断をすり抜けている");
});

test("sessions: 引換券は、切断より前に発行したものだけを止める", async () => {
	const before = Date.now() - 1000;
	assert.equal(await Sessions.isIssuedAfterRevocation("ticket@example.com", before), true, "切断していないのに止めている");
	const {revokedAt} = await Sessions.revokeUser("ticket@example.com", {revokedBy: "admin@example.com"});
	assert.equal(await Sessions.isIssuedAfterRevocation("ticket@example.com", before), false, "切断前の券が通っている");
	assert.equal(await Sessions.isIssuedAfterRevocation("ticket@example.com", Date.parse(revokedAt) + 1000), true, "開き直した券まで止めている");
});

test("sessions: 一覧にセッションIDそのものを出さない", async () => {
	await putSession("sid-secret-value-1234567890", "leak@example.com", {loginAt: ago(5), ip: "203.0.113.9", userAgent: "UA"});
	const listed = JSON.stringify([...(await Sessions.listByUser("sid-secret-value-1234567890")).entries()]);
	assert.equal(listed.includes("sid-secret-value-1234567890"), false, "セッションIDが漏れている");
	// 自分のセッションには目印が付く
	const mine = (await Sessions.listByUser("sid-secret-value-1234567890")).get("leak@example.com")[0];
	assert.equal(mine.current, true);
	assert.equal(mine.ip, "203.0.113.9");
});

test("sessions: 最終アクセスは5分に1回だけ書き直す", () => {
	const now = Date.now();
	const session = {lastSeenAt: new Date(now - 60 * 1000).toISOString()};
	assert.equal(Sessions.touchLastSeen(session, now), false, "1分で書き直している(読むだけの要求が書き込みになる)");
	assert.equal(Sessions.touchLastSeen(session, now + 5 * 60 * 1000), true);
	assert.equal(Sessions.touchLastSeen(session, now + 6 * 60 * 1000), false);
	// まだ記録の無いセッション(この機能を入れる前からのもの)は、最初の要求で書く
	assert.equal(Sessions.touchLastSeen({}, now), true);
});

test("api-keys: 利用者のキーをまとめて失効させ、他の人のキーは残す", async () => {
	await AllowedUsers.addAllowedUser("keys-cut@example.com", "readwrite", "test");
	await AllowedUsers.addAllowedUser("keys-keep@example.com", "readwrite", "test");
	const cut1 = await ApiKeys.createApiKey("k1", "readonly", "30d", "keys-cut@example.com");
	const cut2 = await ApiKeys.createApiKey("k2", "readwrite", "30d", "keys-cut@example.com");
	const keep = await ApiKeys.createApiKey("k3", "readonly", "30d", "keys-keep@example.com");

	assert.equal(await ApiKeys.revokeAllByOwner("keys-cut@example.com"), 2);
	assert.notEqual((await ApiKeys.verifyApiKey(cut1.apiKey)).status, "ok");
	assert.notEqual((await ApiKeys.verifyApiKey(cut2.apiKey)).status, "ok");
	assert.equal((await ApiKeys.verifyApiKey(keep.apiKey)).status, "ok", "他の人のキーまで止めている");
	// もう一度呼んでも、止めるものは残っていない
	assert.equal(await ApiKeys.revokeAllByOwner("keys-cut@example.com"), 0);
});

test("audit-log: 切断は管理者向けの履歴に残り、本人向けの履歴には混ぜない", async () => {
	const admin = "audit-admin@example.com";
	await AuditLog.record({
		userIdentifier: admin, action: AuditLog.ACTION_SESSION_REVOKE, targetUser: "someone@example.com",
		detail: {sessions: 2, apiKeys: 1, sessionDetails: [{ip: "203.0.113.5", userAgent: "UA", loginAt: ago(10), lastSeenAt: ago(1)}]}
	});
	const entry = (await AuditLog.listSessionRevokes()).find((row) => row.by === admin);
	assert.equal(entry.targetUser, "someone@example.com");
	assert.equal(entry.sessions, 2);
	assert.equal(entry.apiKeys, 1);
	assert.equal(entry.sessionDetails[0].ip, "203.0.113.5");
	// 本人向けの画面は文書・プロジェクトの操作を並べる前提なので、ここには出さない
	assert.equal((await AuditLog.listMine(admin)).length, 0);
});

test.after(() => {
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true});
	} catch {}
});
