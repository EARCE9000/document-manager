/*!
 * playwright.config.js : API テスト(@playwright/test の APIRequestContext を使用)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm run test:api`(= playwright test)
 * webServer が認証有効・OIDC省略のテストサーバ(test/api/serve.js)を起動し、
 * serve.js自身が許可ユーザーとAPIキーを用意する。ブラウザは使わない(API専用)ため
 * `npx playwright install` は不要。
 */

const {defineConfig} = require("@playwright/test");
const {TEST_DATA_DIR, PORT, BASE_URL} = require("./test/api/config.js");

// テストサーバに渡す環境変数。既定は sqlite + local(外部サービス不要)。
// DATABASE_BACKEND / STORAGE_BACKEND 等を外から与えれば、同じテストを
// Postgres + S3(MinIO) 等の構成に対しても実行できる。
// 例) DATABASE_BACKEND=postgres DATABASE_URL=... STORAGE_BACKEND=s3 S3_BUCKET=... \
//     S3_ENDPOINT=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... npm run test:api
const serverEnv = {
	DATABASE_BACKEND: process.env.DATABASE_BACKEND || "sqlite",
	STORAGE_BACKEND: process.env.STORAGE_BACKEND || "local",
	DATA_DIR: TEST_DATA_DIR,
	LISTEN_PORT: String(PORT),
	SESSION_SECRET: "test-secret",
	LOG_LEVEL: process.env.LOG_LEVEL || "warn"
};
// 指定があるものだけ引き継ぐ(DB/ストレージの接続情報・認証情報)
for (const key of [
	"DATABASE_URL", "DATABASE_SSL",
	"S3_BUCKET", "S3_REGION", "S3_PREFIX", "S3_ENDPOINT",
	"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION",
	"GCS_BUCKET", "GCS_PREFIX", "STORAGE_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS"
]) {
	if (process.env[key] != null) serverEnv[key] = process.env[key];
}

module.exports = defineConfig({
	testDir: "./test/api",
	// 同一DBを共有する直列実行(認可状態・アップロードの副作用が絡むため並列にしない)
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: {
		baseURL: BASE_URL
	},
	webServer: {
		command: "node test/api/serve.js",
		url: `${BASE_URL}/`,
		reuseExistingServer: false,
		timeout: 30000,
		env: serverEnv,
		stdout: "pipe",
		stderr: "pipe"
	}
});
