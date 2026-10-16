/*!
 * miro-connection-env.test.js : Miro のアプリの値を環境変数で渡したとき(クラウドの秘密情報の保管庫から渡す形)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * AWS の Secrets Manager、GCP の Secret Manager、Azure の Key Vault などから、コンテナへ環境変数
 * MIRO_CLIENT_ID / MIRO_CLIENT_SECRET として渡す形。環境変数があればそちらを使い、管理画面からは
 * 変えられないこと(どこで決まっているかが二重にならないこと)を確かめる。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-miro-env-"));
process.env.DATA_DIR = DATA_DIR;
process.env.DATABASE_BACKEND = "sqlite";
process.env.LOG_LEVEL = "error";
process.env.SESSION_SECRET = "miro-connection-env-test";
process.env.MIRO_CLIENT_ID = "3458764600000000123";
process.env.MIRO_CLIENT_SECRET = "envSecretValue0123456789";

const MiroConnection = require("../app/lib/miro-connection.js");

test.after(() => {
	try {
		fs.rmSync(DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});

test("環境変数があれば、それを使う。状態にはどこで決まっているかとクライアントIDだけを出す", async () => {
	assert.equal(await MiroConnection.isConfigured(), true);
	assert.equal(MiroConnection.credentialsFromEnv(), true);
	const status = await MiroConnection.status();
	assert.deepEqual(status.credentials, {source: "env", clientId: "3458764600000000123", editable: false, updatedBy: null, updatedAt: null});
	assert.ok(!JSON.stringify(status).includes("envSecretValue"), "シークレットが状態に出ている");
});

test("環境変数で決まっているときは、管理画面からは変えられない・消せない", async () => {
	await assert.rejects(MiroConnection.saveCredentials({clientId: "3458764600000000999", clientSecret: "otherSecretValue0123456"}, "admin"),
		(err) => err.status === 409);
	await assert.rejects(MiroConnection.clearCredentials("admin"), (err) => err.status === 409);
	assert.equal((await MiroConnection.status()).credentials.clientId, "3458764600000000123");
});

test("許可の画面のURLには、環境変数のクライアントIDを使う(シークレットは載せない)", async () => {
	const url = new URL(await MiroConnection.authorizeUrl({redirectUri: "https://dm.example.com/api/miro/callback", state: "s"}));
	assert.equal(url.searchParams.get("client_id"), "3458764600000000123");
	assert.equal(url.searchParams.get("redirect_uri"), "https://dm.example.com/api/miro/callback");
	assert.ok(!url.toString().includes("envSecretValue"));
});

test("戻り先は公開URLから作る(MIRO_REDIRECT_URI が無いとき)", () => {
	assert.equal(MiroConnection.redirectUri("https://dm.example.com/document_management/"), "https://dm.example.com/document_management/api/miro/callback");
});

test("暗号化したものは同じ鍵(SESSION_SECRET)なら読め、壊れていれば読めない", () => {
	const sealed = MiroConnection.encrypt("token-value");
	assert.equal(MiroConnection.decrypt(sealed), "token-value");
	assert.notEqual(MiroConnection.encrypt("token-value"), sealed, "毎回違う値になる(同じ値でも見分けられない)");
	assert.equal(MiroConnection.decrypt(sealed.slice(0, -2) + "AA"), null);
	assert.equal(MiroConnection.decrypt("plain"), null);
});

test("許可の画面とのやりとりの印は、改ざん・期限切れを見抜く", () => {
	const {state, nonce} = MiroConnection.issueState("admin@example.com");
	assert.deepEqual(MiroConnection.readState(state), {user: "admin@example.com", nonce});
	const [payload, signature] = state.split(".");
	const forged = Buffer.from(JSON.stringify({u: "attacker", n: nonce, e: Date.now() + 60000})).toString("base64url");
	assert.equal(MiroConnection.readState(`${forged}.${signature}`), null);
	assert.equal(MiroConnection.readState(`${payload}.x`), null);
	assert.equal(MiroConnection.readState(null), null);
});
