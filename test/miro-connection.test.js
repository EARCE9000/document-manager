/*!
 * miro-connection.test.js : Miro 連携の、複数台で動かしたときのトークンの更新と、アプリの値の受け取り方
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * クラウド(AWS の ECS、GCP の Cloud Run、Azure の Container Apps など)では、同じデータベースを見る台が
 * 複数動く。Miro の更新用トークンは1回使うと無効になるため、2台が同時に更新すると、遅れた方が
 * 「連携が切れた」と誤って判断してしまう。ここでは、同じデータベースを共有する2つの部品(=2台)を
 * 同時に動かして、更新が1回だけ行われ、両方が新しいトークンを使えることを確かめる。
 *
 * Miro には代わりのサーバー(test/api/miro-stub.js)を使う。db.js などは require 時に環境変数を読むので、
 * このファイルは単体で動かす(node --test はファイルごとに別のプロセスで動かす)。
 *
 * 既定は SQLite。クラウドと同じ Postgres でも確かめられる:
 *   DATABASE_BACKEND=postgres DATABASE_URL=postgres://user:pass@host:5432/db node --test test/miro-connection.test.js
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-miro-conn-"));
process.env.DATA_DIR = DATA_DIR;
process.env.DATABASE_BACKEND = process.env.DATABASE_BACKEND || "sqlite";
process.env.LOG_LEVEL = "error";
process.env.SESSION_SECRET = "miro-connection-test";
// 順番を持っていた台が落ちたときの取り直しを、短い時間で確かめる
process.env.MIRO_REFRESH_LOCK_SECONDS = "1";
delete process.env.MIRO_CLIENT_ID;
delete process.env.MIRO_CLIENT_SECRET;

const miroStub = require("./api/miro-stub.js");
const CONNECTION_PATH = require.resolve("../app/lib/miro-connection.js");
const CLIENT_PATH = require.resolve("../app/lib/miro-client.js");

let stubPort;
let stubServer;
const stub = (pathname, init) => fetch(`http://127.0.0.1:${stubPort}${pathname}`, init).then((res) => res.json());
const control = (body) => stub("/__control", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
const refreshCount = async () => (await stub("/__requests")).filter((r) => r.path === "/v1/oauth/token" && r.query.grant_type === "refresh_token").length;

/** 1台ぶんの部品を読み込む(同じデータベースを共有し、更新の1本化や台の名前は台ごとに別になる) */
const loadInstance = () => {
	delete require.cache[CONNECTION_PATH];
	return require(CONNECTION_PATH);
};

/** 許可の画面を通って連携する(代わりのサーバーがすぐコードを返す) */
const connect = async (conn) => {
	const redirectUri = "http://localhost:18220/api/miro/callback";
	const authorize = new URL(await conn.authorizeUrl({redirectUri, state: "s"}));
	const res = await fetch(authorize, {redirect: "manual"});
	const code = new URL(res.headers.get("location")).searchParams.get("code");
	await conn.connect({code, redirectUri, user: "admin@example.com"});
};

let ds;

test.before(async () => {
	({server: stubServer, port: stubPort} = await miroStub.start(0));
	process.env.MIRO_API_URL = `http://127.0.0.1:${stubPort}`;
	process.env.MIRO_AUTH_URL = `http://127.0.0.1:${stubPort}`;
	delete require.cache[CLIENT_PATH];
	ds = require("../app/lib/datastore.js");
	await ds.init();
	// Postgres は前の実行の行が残っているので消しておく(SQLite は毎回新しいファイル)
	await ds.run("DELETE FROM miro_connection");
	await loadInstance().saveCredentials({clientId: miroStub.CLIENT_ID, clientSecret: miroStub.CLIENT_SECRET}, "admin@example.com");
});

test.after(async () => {
	stubServer.close();
	await ds.close?.();
	try {
		fs.rmSync(DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});

test.beforeEach(async () => {
	await control({reset: true});
	// 発行するアクセストークンの寿命を、更新の目安(5分)より短くしておく(使うたびに更新が要る状態)
	await control({accessTtlSeconds: 60});
	await connect(loadInstance());
});

test("2台が同時に更新しようとしても、Miro への更新は1回だけで、両方が新しいトークンを使える", async () => {
	const a = loadInstance();
	const b = loadInstance();
	assert.notEqual(a.INSTANCE_ID, b.INSTANCE_ID);
	const before = await refreshCount();
	const [tokenA, tokenB] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
	assert.equal(await refreshCount() - before, 1, "更新が2回走っている(遅れた方の更新用トークンが無効になる)");
	assert.equal(tokenA, tokenB, "両方が同じ新しいトークンを使う");
	const status = await a.status();
	assert.equal(status.usable, true, "連携が切れたと誤って判断している");
	assert.equal(status.lastError, null);
});

test("3台が続けて使っても、連携は切れない(更新用トークンの入れ替えが全台に伝わる)", async () => {
	const instances = [loadInstance(), loadInstance(), loadInstance()];
	for (let round = 0; round < 3; round++) {
		await Promise.all(instances.map((conn) => conn.getAccessToken()));
	}
	assert.equal((await instances[0].status()).usable, true);
	assert.equal((await stub("/__state")).validRefreshTokens, 1, "使える更新用トークンが1つだけ残っている");
});

test("更新の順番を持った台が落ちても、期限が過ぎればほかの台が取り直して更新する", async () => {
	// 落ちた台が順番を持ったまま(期限はまだ先)
	await ds.run("UPDATE miro_connection SET refresh_lock_owner = 'dead-instance', refresh_lock_until = ? WHERE id = 1",
		[new Date(Date.now() + 800).toISOString()]);
	const started = Date.now();
	const token = await loadInstance().getAccessToken();
	assert.ok(token.startsWith("stub-access-"));
	assert.ok(Date.now() - started >= 500, "順番の期限を待たずに更新している");
	assert.equal((await loadInstance().status()).usable, true);
});

test("更新できない(取り消された)ときは、全台で「連携し直し」になる", async () => {
	await control({refreshFails: true});
	const a = loadInstance();
	const b = loadInstance();
	const results = await Promise.allSettled([a.getAccessToken(), b.getAccessToken()]);
	for (const result of results) {
		assert.equal(result.status, "rejected");
		assert.equal(result.reason.needsReconnect, true);
	}
	assert.equal((await a.status()).usable, false);
	// 1台が「切れた」と記録したら、ほかの台は Miro に問い合わせずにそれを使う
	assert.equal(await refreshCount(), 1);
});

test("期限の前に取り消されていた(401)トークンは、1回だけ更新してやり直す", async () => {
	await control({accessTtlSeconds: 3599});
	await connect(loadInstance());
	const conn = loadInstance();
	await control({expireAccess: true});
	const boards = await conn.listBoards();
	assert.ok(boards.length > 0);
});

test("管理画面で保存したシークレットは、暗号化して保存する", async () => {
	const row = await ds.get("SELECT value FROM app_settings WHERE key = 'miro.client_secret'");
	assert.match(row.value, /^v1:/);
	assert.ok(!row.value.includes(miroStub.CLIENT_SECRET));
});
