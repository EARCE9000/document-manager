/*!
 * database-vacuum.spec.js : DB のファイルを詰める(VACUUM)の API の形と、誰が始められるか
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 始められるのは、画面でログインした管理者だけ(APIキーでは 403。このサービスのキーは閲覧・編集だけで、管理者のキーは発行できない。
 * サーバーは念のため requireSession でもキーを断っている)。
 * この試験では詰め始めない(詰めている間はメンテナンス中になり、同時に動くほかの試験が 503 になるため)。
 * 実際に詰めること・メンテナンス中の扱いは test/vacuum.test.js で確かめる。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(keys.sessionCookie)}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

test("メンテナンス中かは、認証なしで読める(いまはメンテナンス中でない)", async ({request}) => {
	const res = await request.get("api/maintenance");
	expect(res.status()).toBe(200);
	expect(await res.json()).toEqual({maintenance: false, reason: null, startedAt: null});
});

test("画面でログインした管理者は、状態を読める(SQLite なので使える)", async ({request}) => {
	const res = await request.get("api/database/vacuum", {headers: admin});
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body).toMatchObject({available: true, running: false});
	expect(typeof body.fileBytes).toBe("number");
	expect(typeof body.freeBytes).toBe("number");
	expect(typeof body.enoughSpace).toBe("boolean");
});

test("APIキーでは読めず始められない(403)。未認証は 401", async ({request}) => {
	for (const key of [rw, ro]) {
		expect((await request.get("api/database/vacuum", {headers: key})).status()).toBe(403);
		expect((await request.post("api/database/vacuum", {headers: key, data: {}})).status()).toBe(403);
	}
	expect((await request.get("api/database/vacuum")).status()).toBe(401);
	expect((await request.post("api/database/vacuum", {data: {}})).status()).toBe(401);
	// どれも始まっていない
	expect((await (await request.get("api/maintenance")).json()).maintenance).toBe(false);
});
