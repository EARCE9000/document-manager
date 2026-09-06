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
