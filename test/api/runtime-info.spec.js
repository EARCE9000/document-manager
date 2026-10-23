/*!
 * runtime-info.spec.js : 動いている部品の版(管理画面の「サーバー」タブ)の API の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 本体・DB・変換サービス・Weaviate を 1 行ずつ返すこと、部品表を名前で探せること、admin だけが見られることを確かめる。
 * テストサーバーの変換サービスは代わり(converter-stub.js)で、Weaviate は使っていない。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};

test.describe("動いている部品の版", () => {
	test("本体・DB・ファイルの置き場・IdP・変換サービス・Weaviate を 1 行ずつ返す(使っていないものは configured: false)", async ({request}) => {
		const res = await request.get("api/server-status/components", {headers: admin});
		expect(res.status()).toBe(200);
		const body = await res.json();
		const byKey = Object.fromEntries(body.components.map((c) => [c.key, c]));
		expect(Object.keys(byKey)).toEqual(["app", "database", "storage", "idp", "office", "pdf", "weaviate"]);
		expect(byKey.app).toMatchObject({configured: true, reachable: true, product: "Document Manager"});
		expect(byKey.app.runtime).toMatchObject({node: expect.stringMatching(/^\d+\.\d+\.\d+$/), openssl: expect.any(String), arch: expect.any(String)});
		expect(byKey.database).toMatchObject({configured: true, reachable: true, product: "SQLite(本体に同梱)", version: expect.stringMatching(/^3\./)});
		expect(byKey.weaviate).toEqual({key: "weaviate", name: "意味検索(Weaviate)", configured: false});
		// 試験では OIDC を使わない(serve.js)
		expect(byKey.idp).toEqual({key: "idp", name: "IdP(ログイン)", configured: false});
		// 変換サービスは、使っていれば問い合わせた結果(届く・届かない)が入る
		for (const key of ["office", "pdf"]) expect(typeof byKey[key].configured).toBe("boolean");
		expect(body.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({name: "express", version: expect.any(String)})]));
		expect(body.packageCount).toBeGreaterThan(body.dependencies.length);
	});

	test("部品表を名前で探せる(入れ子の別の版も出る)", async ({request}) => {
		const all = await (await request.get("api/server-status/packages", {headers: admin})).json();
		expect(all.count).toBe(all.total);
		const found = await (await request.get("api/server-status/packages?q=EXPRESS", {headers: admin})).json();
		expect(found.count).toBeGreaterThan(0);
		expect(found.packages.every((p) => p.name.toLowerCase().includes("express"))).toBe(true);
		expect(found.packages).toEqual(expect.arrayContaining([expect.objectContaining({name: "express", direct: true, path: "node_modules/express"})]));
	});

	test("admin 以外は見られない", async ({request}) => {
		expect((await request.get("api/server-status/components", {headers: rw})).status()).toBe(403);
		expect((await request.get("api/server-status/packages", {headers: rw})).status()).toBe(403);
	});
});
