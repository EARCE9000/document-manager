/*!
 * rate-limit.spec.js : APIの回数の上限を管理画面(admin)から変える API の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * テストサーバーではレート制限を切ってある(RATE_LIMIT_DISABLED。hardening.spec.js)ので、
 * ここでは上限の値の読み書き(管理画面で保存した値 → 環境変数 → 既定)と権限だけを確かめる。
 * 上限を超えたときの 429 は単体テスト(test/rate-limit.test.js)で確かめる。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};

test.describe.serial("APIの回数の上限(管理画面)", () => {
	test.afterAll(async ({request}) => {
		for (const kind of ["authenticated", "anonymous"]) await request.delete(`api/rate-limit/${kind}`, {headers: admin});
	});

	test("いまの上限と、何で決まっているかを返す(既定は 5 分で 10000・300)", async ({request}) => {
		const res = await request.get("api/rate-limit", {headers: admin});
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({
			windowMinutes: 5, disabled: true,
			ranges: {authenticated: {min: 100, max: 1000000}, anonymous: {min: 10, max: 100000}},
			authenticated: {limit: 10000, source: "default", envDefault: 10000}, anonymous: {limit: 300, source: "default", envDefault: 300}
		});
	});

	test("変えられ、誰がいつ変えたかが残る。範囲外は何も保存しない。既定に戻せる", async ({request}) => {
		const saved = await request.put("api/rate-limit", {headers: admin, data: {authenticated: 20000, anonymous: 500}});
		expect(saved.status()).toBe(200);
		const body = await saved.json();
		expect(body).toMatchObject({authenticated: {limit: 20000, source: "setting"}, anonymous: {limit: 500, source: "setting"}});
		expect(body.authenticated.updatedBy).toBeTruthy();
		expect(body.authenticated.updatedAt).toBeTruthy();
		// 片方が範囲外なら、もう片方も保存しない
		const bad = await request.put("api/rate-limit", {headers: admin, data: {authenticated: 30000, anonymous: 1}});
		expect(bad.status()).toBe(400);
		expect((await bad.json()).error).toContain("anonymous");
		expect((await (await request.get("api/rate-limit", {headers: admin})).json()).authenticated.limit).toBe(20000);
		expect((await request.put("api/rate-limit", {headers: admin, data: {}})).status()).toBe(400);
		expect((await request.put("api/rate-limit", {headers: admin, data: {authenticated: 1500.5}})).status()).toBe(400);
		// 既定に戻す
		for (const kind of ["authenticated", "anonymous"]) expect((await request.delete(`api/rate-limit/${kind}`, {headers: admin})).status()).toBe(200);
		expect(await (await request.get("api/rate-limit", {headers: admin})).json()).toMatchObject({
			authenticated: {limit: 10000, source: "default"}, anonymous: {limit: 300, source: "default"}
		});
		expect((await request.delete("api/rate-limit/other", {headers: admin})).status()).toBe(404);
	});

	test("admin 以外は見られない・変えられない", async ({request}) => {
		expect((await request.get("api/rate-limit", {headers: rw})).status()).toBe(403);
		expect((await request.put("api/rate-limit", {headers: rw, data: {authenticated: 100000}})).status()).toBe(403);
		expect((await request.delete("api/rate-limit/authenticated", {headers: rw})).status()).toBe(403);
	});
});
