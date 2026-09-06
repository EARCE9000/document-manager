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
		env: {
			DATABASE_BACKEND: "sqlite",
			DATA_DIR: TEST_DATA_DIR,
			LISTEN_PORT: String(PORT),
			SESSION_SECRET: "test-secret",
			LOG_LEVEL: "warn"
		},
		stdout: "pipe",
		stderr: "pipe"
	}
});
