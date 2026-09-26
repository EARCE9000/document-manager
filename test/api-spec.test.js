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

	// 貼り付けて保存されたガイドは古くなる。AIが自力で取り直せるよう、版と取り直し先を先頭に書く
	const dated = ApiSpec.buildUsageMarkdown({baseUrl: "https://example.com/docs/", vectorSearchEnabled: false, version: "20260924_101530"});
	assert.ok(dated.includes("サーバー版 20260924_101530"), "どの版の内容かが分かる");
	assert.ok(dated.includes("`GET https://example.com/docs/api/usage.md` で取り直してください"), "取り直し先を示す");
	assert.ok(markdown.includes("サーバー版 不明"), "版が渡らなくても案内は出す");

	// 冒頭の紹介文は対応形式の入口になるため、扱える形式が増えたらここも更新する
	for (const format of ["Office文書", "PDF", "Markdown", "draw.io"]) {
		assert.ok(markdown.includes(format), `冒頭の紹介文に ${format} が無い`);
	}

	const withVector = ApiSpec.buildUsageMarkdown({baseUrl: "https://example.com/docs", vectorSearchEnabled: true});
	assert.ok(withVector.includes("### セマンティック検索(意味検索)"));
	// adminロール限定・画面用のAPIはAI向けガイドには載せない
	for (const hidden of ["/api/allowed_users", "/api/check_access_token", "/api/tag_order"]) {
		assert.ok(!withVector.includes(hidden), `${hidden} はAI向けガイドに載せない`);
	}
});

// aiGuide は「AI向けガイドに載せるか」を表す注釈だが、ガイド自体は手書きの
// GUIDE_SECTIONS から組み立てている。二重管理なので、放っておくと必ずずれる
// (実際、モックアップを足したときに aiGuide だけ書いて節を足し忘れていた)。
// 片方だけ直しても気づけるよう、両者の一致をここで検査する
test("AI向けガイドの内容と aiGuide の指定が一致している", () => {
	const source = fs.readFileSync(path.join(__dirname, "..", "app", "lib", "api-spec.js"), "utf-8");
	const sections = source.slice(source.indexOf("const GUIDE_SECTIONS = ["), source.indexOf("const CURL_EXAMPLES"));
	const guided = new Set([...sections.matchAll(/\{id: "([A-Za-z]+)"/g)].map((m) => m[1]));
	const byId = new Map(ApiSpec.OPERATIONS.map((op) => [op.id, op]));

	const unknown = [...guided].filter((id) => !byId.has(id));
	assert.deepEqual(unknown, [], `ガイドに、存在しない操作IDが書かれている: ${unknown.join(", ")}`);

	const missing = ApiSpec.OPERATIONS.filter((op) => op.aiGuide !== false && !guided.has(op.id)).map((op) => op.id);
	assert.deepEqual(missing, [], `AIに使わせる指定なのにガイドに載っていない(GUIDE_SECTIONSに節を足すか、aiGuide: false を付ける): ${missing.join(", ")}`);

	const extra = [...guided].filter((id) => byId.get(id).aiGuide === false);
	assert.deepEqual(extra, [], `aiGuide: false なのにガイドに載っている: ${extra.join(", ")}`);
});

// モックアップはAIが作って登録するもの。ガイドに載っていなければAIは存在に気づけない
test("AI向けガイドにモックアップとお品書きが載る", () => {
	const markdown = ApiSpec.buildUsageMarkdown({baseUrl: "https://example.com", vectorSearchEnabled: false});
	for (const expected of [
		"モックアップの一覧・検索",
		"モックアップの登録",
		"mockupfile",
		"index.html",
		"プロジェクトのお品書き",
		"manifest.md"
	]) {
		assert.ok(markdown.includes(expected), `AI向けガイドに「${expected}」が無い`);
	}
	// 中を読ませるのではなく、利用者に開いてもらうものだと伝わること
	assert.ok(markdown.includes("利用者に伝えて開いてもらう"), "モックアップの見せ方の指示が無い");
});

test.after(() => {
	// SQLiteのファイルを掴んだままのことがある(Windows)。消せなくてもテストは失敗させない
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true, maxRetries: 3});
	} catch {}
});
