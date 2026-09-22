/*!
 * auth.spec.js : 認証・認可の強制(enforcement)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * resolveAuth(Bearer APIキー経路) + requireAuth/requireWrite/requireAdmin が
 * ルートごとに正しく効いているか(401/403/200)を、実サーバに対して検証する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const bearer = (key) => (key ? {Authorization: `Bearer ${key}`} : {});

test.describe("requireAuth: 未認証は401", () => {
	const protectedGet = ["api/documents", "api/tag_order", "api/projects", "api/history", "api/apikeys"];
	for (const url of protectedGet) {
		test(`GET /${url} は認証なしで401`, async ({request}) => {
			const res = await request.get(url);
			expect(res.status()).toBe(401);
		});
	}

	test("不正なAPIキーは401", async ({request}) => {
		const res = await request.get("api/documents", {headers: bearer(keys.invalid)});
		expect(res.status()).toBe(401);
	});

	test("期限切れのAPIキーは401(期限切れメッセージ)", async ({request}) => {
		const res = await request.get("api/documents", {headers: bearer(keys.expired)});
		expect(res.status()).toBe(401);
		const body = await res.json();
		expect(body.error).toContain("有効期限");
	});
});

test.describe("requireAuth: 有効なキーは200(読み取り)", () => {
	for (const role of ["readonly", "readwrite"]) {
		test(`${role}キーで GET /api/documents は200・配列`, async ({request}) => {
			const res = await request.get("api/documents", {headers: bearer(keys[role])});
			expect(res.status()).toBe(200);
			expect(Array.isArray(await res.json())).toBe(true);
		});

		test(`${role}キーで GET /api/tag_order は200`, async ({request}) => {
			const res = await request.get("api/tag_order", {headers: bearer(keys[role])});
			expect(res.status()).toBe(200);
		});
	}
});

test.describe("requireWrite: readonlyは書き込み403、readwriteは許可", () => {
	test("readonlyキーで PUT タグ更新は403", async ({request}) => {
		const res = await request.put("api/documents/nonexistent-id/tags", {
			headers: bearer(keys.readonly),
			data: {tags: ["x"]}
		});
		expect(res.status()).toBe(403);
	});

	test("readonlyキーで DELETE 文書は403", async ({request}) => {
		const res = await request.delete("api/documents/nonexistent-id", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(403);
	});

	test("readwriteキーで PUT タグ更新は書き込み権限を通過する(存在しないIDなので404)", async ({request}) => {
		// 403にならず404になること = requireWriteを通過したことの確認
		const res = await request.put("api/documents/nonexistent-id/tags", {
			headers: bearer(keys.readwrite),
			data: {tags: ["x"]}
		});
		expect(res.status()).toBe(404);
	});
});

test.describe("requireAdmin: APIキー(最大readwrite)では管理APIに到達できない", () => {
	// APIキーのロールはreadonly/readwriteのみ。requireAdminが効いていれば403になる
	test("readwriteキーで GET /api/allowed_users は403", async ({request}) => {
		const res = await request.get("api/allowed_users", {headers: bearer(keys.readwrite)});
		expect(res.status()).toBe(403);
	});

	test("readonlyキーで GET /api/allowed_users は403", async ({request}) => {
		const res = await request.get("api/allowed_users", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(403);
	});

	test("未認証で GET /api/allowed_users は401", async ({request}) => {
		const res = await request.get("api/allowed_users");
		expect(res.status()).toBe(401);
	});
});

test.describe("APIキーの無期限モード", () => {
	const rw = bearer(keys.readwrite);
	test("無期限キーを発行でき(expiresAt=null)、使え、失効させると401になる", async ({request}) => {
		const created = await request.post("api/apikeys", {headers: rw, data: {label: "unlimited-test", role: "readonly", expiryOption: "unlimited"}});
		expect(created.status()).toBe(200);
		const body = await created.json();
		expect(body.expiresAt).toBeNull();

		const unlimited = {Authorization: `Bearer ${body.apiKey}`};
		expect((await request.get("api/documents", {headers: unlimited})).status()).toBe(200);

		const list = await (await request.get("api/apikeys", {headers: rw})).json();
		expect(list.find((k) => k.id === body.id).expiresAt).toBeNull();

		expect((await request.delete(`api/apikeys/${body.id}`, {headers: rw})).status()).toBe(204);
		expect((await request.get("api/documents", {headers: unlimited})).status()).toBe(401);
	});

	test("不正な expiryOption は400", async ({request}) => {
		const res = await request.post("api/apikeys", {headers: rw, data: {role: "readonly", expiryOption: "forever"}});
		expect(res.status()).toBe(400);
	});
});

test.describe("Claude Code用SkillのZIPダウンロード", () => {
	test("未認証は401", async ({request}) => {
		expect((await request.get("api/claude-skill.zip")).status()).toBe(401);
	});

	test("readonlyキーでもダウンロードでき、document-manager/SKILL.md を含むZIPが返る", async ({request}) => {
		const res = await request.get("api/claude-skill.zip", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/zip");
		expect(res.headers()["content-disposition"]).toContain("document-manager-skill.zip");
		const body = await res.body();
		expect(body.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
		expect(body.includes(Buffer.from("document-manager/SKILL.md"))).toBe(true);
		expect(body.includes(Buffer.from("document-manager/scripts/dm_client.py"))).toBe(true);
	});
});

test.describe("API仕様の取得", () => {
	const rw = bearer(keys.readwrite);

	test("未認証は401", async ({request}) => {
		expect((await request.get("api/openapi.json")).status()).toBe(401);
		expect((await request.get("api/usage.md")).status()).toBe(401);
	});

	test("readonlyキーでOpenAPIを取得でき、主要なAPIと権限情報が含まれる", async ({request}) => {
		const res = await request.get("api/openapi.json", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(200);
		const spec = await res.json();
		expect(spec.openapi).toBe("3.1.0");
		expect(spec.paths["/api/documents"].get.operationId).toBe("listDocuments");
		expect(spec.paths["/api/documents/{id}/versions"].get).toBeTruthy();
		expect(spec.paths["/api/documents/archived"].get).toBeTruthy();
		// adminロールの操作はAPIキーからは実行できないことが分かる
		expect(spec.paths["/api/allowed_users"].get["x-api-key-usable"]).toBe(false);
		// AIへの指示も仕様に含まれる
		expect(spec.info.description).toContain("アップして");
		expect(Array.isArray(spec["x-ai-instructions"])).toBe(true);
	});

	test("利用ガイド(Markdown)を取得できる", async ({request}) => {
		const res = await request.get("api/usage.md", {headers: rw});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("text/markdown");
		const markdown = await res.text();
		expect(markdown.startsWith("# Document Manager API 利用ガイド (AI向け)")).toBe(true);
		expect(markdown).toContain("## AIへの指示");
	});

	test("baseUrlを指定するとその値が使われ、不正な値は無視される", async ({request}) => {
		const specified = await (await request.get("api/usage.md?baseUrl=https%3A%2F%2Fdocs.example.com%2Fsub%2F", {headers: rw})).text();
		expect(specified).toContain("- ベースURL: `https://docs.example.com/sub`");
		expect(specified).toContain("`GET https://docs.example.com/sub/api/documents?q=<検索語>`");

		// http/https以外・壊れた値はリクエストから組み立てた既定値にフォールバックする
		for (const bad of ["javascript:alert(1)", "not-a-url"]) {
			const fallback = await (await request.get(`api/usage.md?baseUrl=${encodeURIComponent(bad)}`, {headers: rw})).text();
			expect(fallback).not.toContain(bad);
			expect(fallback).toContain("- ベースURL: `http://127.0.0.1:");
		}
	});
});
