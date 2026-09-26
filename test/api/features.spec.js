/*!
 * features.spec.js : 機能のOn/Off(管理画面のサーバータブ)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * モックアップ機能は**既定Off**で、使う構成でだけ開ける。開け方は環境変数(その環境の既定)と
 * 管理画面(DBに保存。再起動不要・全インスタンスに効く)の2つで、DBの値が環境変数より優先される。
 *
 * ここで確かめたいのは「切り替えると本当に塞がるか」。画面のボタンが消えるだけでは意味がなく、
 * APIが断ることと、AIが読む仕様・ガイドから消えることまでが揃って初めて「Off」になる。
 *
 * このテストサーバは MOCKUPS_ENABLED=true で起動している(playwright.config.js)ため、
 * 初期状態は有効。最後に必ず有効へ戻す(他のスペックがモックアップを使うため)。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const session = () => ({Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`});

const setMockups = (request, enabled) =>
	request.put("api/features/mockups", {headers: session(), data: {enabled}});

test.describe.serial("機能のOn/Off", () => {
	test.afterAll(async ({request}) => {
		// 他のスペックが使うので、必ず有効に戻す
		await setMockups(request, true);
	});

	test("状態と、その根拠が分かる", async ({request}) => {
		const res = await request.get("api/features", {headers: session()});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.mockups.enabled).toBe(true);
		// 何を根拠に今の状態なのか(環境変数の既定か、画面で変えた値か)が分かること
		expect(["env", "setting"]).toContain(body.mockups.source);
		expect(body.mockups.storageSupported).toBe(true);
	});

	test("adminだけが見られる・変えられる", async ({request}) => {
		// APIキーはreadonly/readwriteしか発行できないため、キー経由では届かない
		expect((await request.get("api/features", {headers: rw})).status()).toBe(403);
		expect((await request.put("api/features/mockups", {headers: rw, data: {enabled: false}})).status()).toBe(403);
		expect((await request.get("api/features")).status()).toBe(401);
	});

	test("無効にするとAPIが断り、仕様からも消える", async ({request}) => {
		expect((await setMockups(request, false)).status()).toBe(200);

		// 画面のボタンが消えるだけでは「無効」にならない。APIが断ること
		for (const path of ["api/mockups", "api/mockups/archived", "api/mockups/no-such-id"]) {
			const res = await request.get(path, {headers: rw});
			expect(res.status(), `${path} が塞がっていない`).toBe(503);
		}
		const posted = await request.post("api/mockups", {
			headers: rw,
			multipart: {mockupfile: {name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK")}}
		});
		expect(posted.status(), "登録も塞がっていない").toBe(503);

		// 無効な機能が仕様に載っていると、AIが呼んで503を食う
		const spec = await (await request.get("api/openapi.json", {headers: rw})).json();
		expect(Object.keys(spec.paths).filter((p) => p.startsWith("/api/mockups"))).toEqual([]);
		const guide = await (await request.get("api/usage.md", {headers: rw})).text();
		expect(guide).not.toContain("モックアップ");

		// 画面がメニューを出すかどうかの判断材料も落ちること
		const auth = await (await request.get("api/check_access_token", {headers: session()})).json();
		expect(auth.mockupsEnabled).toBe(false);
	});

	test("有効に戻すと元どおり使える(登録済みのものは消えていない)", async ({request}) => {
		// 無効の間に登録しておいたものが残っているか見るため、先に1件作る
		await setMockups(request, true);
		const created = await request.post("api/mockups", {
			headers: rw,
			multipart: {
				mockupfile: {name: "keep.zip", mimeType: "application/zip", buffer: zipWithIndex()},
				name: `残るはずのモックアップ ${Date.now()}`
			}
		});
		expect(created.status()).toBe(200);
		const id = (await created.json()).id;

		await setMockups(request, false);
		expect((await request.get(`api/mockups/${id}`, {headers: rw})).status()).toBe(503);

		await setMockups(request, true);
		const back = await request.get(`api/mockups/${id}`, {headers: rw});
		expect(back.status(), "戻したら見えること").toBe(200);
		expect((await back.json()).id, "中身が消えていないこと").toBe(id);

		const spec = await (await request.get("api/openapi.json", {headers: rw})).json();
		expect(Object.keys(spec.paths).filter((p) => p.startsWith("/api/mockups")).length).toBeGreaterThan(0);
	});

	test("変更した人と時刻が残る", async ({request}) => {
		await setMockups(request, true);
		const body = await (await request.get("api/features", {headers: session()})).json();
		expect(body.mockups.source, "画面から変えた値として記録される").toBe("setting");
		expect(body.mockups.updatedBy).toBeTruthy();
		expect(body.mockups.updatedAt).toBeTruthy();
	});

	test("enabled は真偽値でなければ400", async ({request}) => {
		for (const value of ["true", 1, null, undefined]) {
			const res = await request.put("api/features/mockups", {headers: session(), data: {enabled: value}});
			expect(res.status(), `通してはいけない: ${String(value)}`).toBe(400);
		}
	});
});

/* index.html だけを入れた最小のZIP */
function zipWithIndex() {
	const zlib = require("zlib");
	const name = Buffer.from("index.html", "utf-8");
	const data = Buffer.from("<html><body>残る</body></html>", "utf-8");
	const payload = zlib.deflateRawSync(data, {level: 9});
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	const localPart = Buffer.concat([local, name, payload]);
	const centralPart = Buffer.concat([central, name]);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
}
