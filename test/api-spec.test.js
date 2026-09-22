/*!
 * api-spec.test.js : API仕様(app/lib/api-spec.js)が実際のルート登録と一致していることの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 * Expressに登録済みの api/* のルートを数え上げ、仕様(OPERATIONS)との過不足を検出する。
 * APIを追加したのに仕様・利用ガイドを更新し忘れる、を防ぐのが目的。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-spec-"));
process.env.AUTH_DISABLED = "true"; // OIDC初期化を避ける(listenはしないので実害なし)

const test = require("node:test");
const assert = require("node:assert/strict");

const ApiSpec = require("../app/lib/api-spec.js");
const {app} = require("../app/server.js");

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

// Expressに登録された "api/" 配下のルートを "METHOD /path" の集合にする
const registeredRoutes = () => {
	const routes = new Set();
	for (const layer of app._router.stack) {
		if (layer.route == null) continue;
		const routePath = layer.route.path;
		if (!routePath.startsWith("/api/")) continue;
		// app.all() で登録したルートは全メソッドが有効になる(Express 4.22)。
		// 仕様上はGETとして扱う(実装が app.all なのは歴史的な経緯で、実際にはGETで呼ばれる)
		const enabled = HTTP_METHODS.filter((method) => layer.route.methods[method]);
		if (enabled.length === HTTP_METHODS.length) {
			routes.add(`GET ${routePath}`);
			continue;
		}
		for (const method of enabled) {
			routes.add(`${method.toUpperCase()} ${routePath}`);
		}
	}
	return routes;
};

const specRoutes = () => new Set(ApiSpec.OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`));

test("仕様に載っていないAPIが無い(APIを追加したら api-spec.js も更新する)", () => {
	const missing = [...registeredRoutes()].filter((route) => !specRoutes().has(route));
	assert.deepEqual(missing, [], `仕様(app/lib/api-spec.js)に未記載のAPI: ${missing.join(", ")}`);
});

test("実在しないAPIが仕様に載っていない", () => {
	const registered = registeredRoutes();
	const extra = [...specRoutes()].filter((route) => !registered.has(route));
	assert.deepEqual(extra, [], `実際には登録されていないAPIが仕様にある: ${extra.join(", ")}`);
});

test("operationId・パスが重複していない", () => {
	const ids = ApiSpec.OPERATIONS.map((op) => op.id);
	assert.equal(new Set(ids).size, ids.length, "operationIdが重複している");
	const routes = ApiSpec.OPERATIONS.map((op) => `${op.method} ${op.path}`);
	assert.equal(new Set(routes).size, routes.length, "同じメソッド+パスが重複している");
});

test("OpenAPIが組み立てられ、全操作が含まれる", () => {
	const spec = ApiSpec.buildOpenApi({baseUrl: "https://example.com/", vectorSearchEnabled: true, version: "20260101"});
	assert.equal(spec.openapi, "3.1.0");
	assert.equal(spec.servers[0].url, "https://example.com");
	const count = Object.values(spec.paths).reduce((n, item) => n + Object.keys(item).length, 0);
	assert.equal(count, ApiSpec.OPERATIONS.length, "全操作がpathsに入る");
	// Expressの :param は OpenAPI の {param} に変換され、パスパラメータが定義される
	const getDocument = spec.paths["/api/documents/{id}"].get;
	assert.equal(getDocument.operationId, "getDocument");
	assert.ok(getDocument.parameters.some((p) => p.in === "path" && p.name === "id" && p.required));
	// AIへの指示が仕様にも載る(AIエージェントがOpenAPIだけ読んでも使い方が分かる)
	assert.ok(spec.info.description.includes("アップして"), "info.descriptionにAIへの指示が含まれる");
	assert.ok(spec["x-ai-instructions"].length >= 2);
	// adminロールの操作はAPIキーから実行できないことが分かる
	assert.equal(spec.paths["/api/allowed_users"].get["x-api-key-usable"], false);
	assert.equal(spec.paths["/api/documents"].get["x-api-key-usable"], true);
});

test("ベクトル検索が無効な環境では、その操作を仕様に載せない", () => {
	const disabled = ApiSpec.buildOpenApi({baseUrl: "https://example.com", vectorSearchEnabled: false});
	assert.equal(disabled.paths["/api/documents/search/vector"], undefined);
	const enabled = ApiSpec.buildOpenApi({baseUrl: "https://example.com", vectorSearchEnabled: true});
	assert.ok(enabled.paths["/api/documents/search/vector"].get);
});

test("利用ガイド(Markdown)にベースURLとAIへの指示が反映される", () => {
	const markdown = ApiSpec.buildUsageMarkdown({baseUrl: "https://example.com/docs/", vectorSearchEnabled: false});
	assert.ok(markdown.startsWith("# Document Manager API 利用ガイド (AI向け)"));
	assert.ok(markdown.includes("- ベースURL: `https://example.com/docs`"), "末尾のスラッシュは落とす");
	assert.ok(markdown.includes("`GET https://example.com/docs/api/documents?q=<検索語>`"));
	assert.ok(markdown.includes("## AIへの指示"));
	assert.ok(!markdown.includes("セマンティック検索"), "無効な機能は載せない");

	const withVector = ApiSpec.buildUsageMarkdown({baseUrl: "https://example.com/docs", vectorSearchEnabled: true});
	assert.ok(withVector.includes("### セマンティック検索(意味検索)"));
	// adminロール限定・画面用のAPIはAI向けガイドには載せない
	for (const hidden of ["/api/allowed_users", "/api/check_access_token", "/api/tag_order"]) {
		assert.ok(!withVector.includes(hidden), `${hidden} はAI向けガイドに載せない`);
	}
});

test.after(() => {
	// SQLiteのファイルを掴んだままのことがある(Windows)。消せなくてもテストは失敗させない
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});
