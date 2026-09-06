/*!
 * serve.js : APIテスト用のサーバ起動エントリ(認証有効・OIDC省略)+ テスト用データのseed
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * server.js を require して app/server を取得し、認証は有効なまま(AUTH_DISABLEDを設定しない)、
 * OIDC初期化(ブラウザログイン用)だけ省いて listen する。APIキー認証と
 * requireAuth/requireWrite/requireAdmin はOIDCに依存しないため、これで認可のテストができる。
 *
 * DBの seed(許可ユーザー・APIキー)は、DBを所有するこのプロセス内で行う。別プロセス(globalSetup)から
 * 同じSQLiteファイルを触るとWindowsでファイルロック衝突(EPERM)を起こすため、あえて一本化している。
 * 生成した平文キーは .auth-keys.json に書き出し、各specがそれを読む。DATA_DIR/LISTEN_PORT等は
 * playwright.config.js の webServer.env から渡る。
 */

const fs = require("node:fs");
const {KEYS_FILE} = require("./config.js");

const DATA_DIR = process.env.DATA_DIR;
const port = Number(process.env.LISTEN_PORT || 18090);

// このプロセスがDBを開く前に、前回のテストDBを消してまっさらから始める
// (直前の実行のサーバは既に停止しておりロックは無い想定。念のため失敗は無視する)
try {
	fs.rmSync(DATA_DIR, {recursive: true, force: true});
} catch {}
fs.mkdirSync(DATA_DIR, {recursive: true});

// require時にdb.jsがDATA_DIR上にSQLiteを作成する
const ds = require("../../app/lib/datastore.js");
const AllowedUsers = require("../../app/lib/allowed-users.js");
const ApiKeys = require("../../app/lib/api-keys.js");
const {server} = require("../../app/server.js");

(async () => {
	await ds.init(); // sqliteはno-op

	// テスト用の許可ユーザーとAPIキーを用意する。
	// APIキーの発行者は許可ユーザーである必要がある(resolveAuthがisAllowedを確認するため)。
	// APIキーのロールはreadonly/readwriteのみ(admin不可)なので、requireAdminルートは
	// readwriteキーでも403になる(=requireAdminが効いていることの検証になる)。
	const owner = "apitest@example.com";
	await AllowedUsers.addAllowedUser(owner, "admin", "serve");
	const readonly = await ApiKeys.createApiKey("test-readonly", "readonly", "30d", owner);
	const readwrite = await ApiKeys.createApiKey("test-readwrite", "readwrite", "30d", owner);
	const expired = await ApiKeys.createApiKey("test-expired", "readonly", "30d", owner);
	await ds.run("UPDATE api_keys SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", expired.id]);

	fs.writeFileSync(KEYS_FILE, JSON.stringify({
		owner,
		readonly: readonly.apiKey,
		readwrite: readwrite.apiKey,
		expired: expired.apiKey,
		invalid: "dm_thisisnotarealkey"
	}, null, 2));

	server.listen(port, () => {
		console.log(`api test server listening on ${port}`);
	});
})().catch((err) => {
	console.error("api test server failed to start:", err);
	process.exit(1);
});
