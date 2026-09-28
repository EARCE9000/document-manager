/*!
 * mockup-order-memo.spec.js : モックアップの並び順とメモの上限
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 一覧は**最後に触ったものが左上**に来る。登録だけでなく、名前やメモを直したときも進む
 * (v18で足した mockups.updated_at)。直したのに埋もれたままだと、探して直した意味が薄れる。
 *
 * メモは一覧のカードに並べて出るため、長いとそのカードだけ背が高くなり、並べたときに
 * 目が滑る。上限は120文字(実測で1行約20文字・カードでは3行で打ち切り)。
 *
 * どちらもAIからも使うものなので、API仕様と利用ガイドに載っていることも確かめる。
 */

const {test, expect} = require("@playwright/test");
const zlib = require("node:zlib");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const buildZip = (entries) => {
	const locals = [], centrals = [];
	let offset = 0;
	for (const {name, data} of entries) {
		const n = Buffer.from(name, "utf-8"), p = zlib.deflateRawSync(data, {level: 9});
		const l = Buffer.alloc(30);
		l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8);
		l.writeUInt32LE(p.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
		locals.push(l, n, p);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
		c.writeUInt32LE(p.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
		centrals.push(c, n);
		offset += l.length + n.length + p.length;
	}
	const lp = Buffer.concat(locals), cp = Buffer.concat(centrals), e = Buffer.alloc(22);
	e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
	e.writeUInt32LE(cp.length, 12); e.writeUInt32LE(lp.length, 16);
	return Buffer.concat([lp, cp, e]);
};

const ZIP = () => buildZip([{name: "index.html", data: Buffer.from("<html><body>案</body></html>", "utf-8")}]);
const STAMP = Date.now();

const upload = async (request, name) => {
	const res = await request.post("api/mockups", {
		headers: rw, multipart: {mockupfile: {name: "m.zip", mimeType: "application/zip", buffer: ZIP()}, name}
	});
	expect(res.status()).toBe(200);
	return (await res.json()).id;
};

const listIds = async (request) => (await (await request.get("api/mockups", {headers: ro})).json()).map((m) => m.id);

test.describe.serial("モックアップの並び順とメモ", () => {
	let first, second, third;

	test.beforeAll(async ({request}) => {
		// 間を空けて登録する(同じ時刻になると並びが決まらない)
		first = await upload(request, `並び1 ${STAMP}`);
		await new Promise((r) => setTimeout(r, 20));
		second = await upload(request, `並び2 ${STAMP}`);
		await new Promise((r) => setTimeout(r, 20));
		third = await upload(request, `並び3 ${STAMP}`);
	});

	test("登録が新しいものが先頭に来る", async ({request}) => {
		const ids = await listIds(request);
		expect(ids.indexOf(third)).toBeLessThan(ids.indexOf(second));
		expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
	});

	// 直したのに埋もれたままだと、探して直した意味が薄れる
	test("メモを直すと先頭に来る", async ({request}) => {
		await new Promise((r) => setTimeout(r, 20));
		const res = await request.put(`api/mockups/${first}/memo`, {headers: rw, data: {memo: "後から書いた説明"}});
		expect(res.status()).toBe(200);

		const ids = await listIds(request);
		expect(ids[0], "メモを直したものが先頭に来ていない").toBe(first);
	});

	test("名前を直しても先頭に来る", async ({request}) => {
		await new Promise((r) => setTimeout(r, 20));
		await request.put(`api/mockups/${second}/name`, {headers: rw, data: {name: `並び2改 ${STAMP}`}});
		expect((await listIds(request))[0]).toBe(second);
	});

	test("応答に updatedAt が入り、登録時刻とは別に進む", async ({request}) => {
		const list = await (await request.get("api/mockups", {headers: ro})).json();
		const target = list.find((m) => m.id === first);
		expect(target.updatedAt).toBeTruthy();
		expect(new Date(target.updatedAt).getTime(), "更新しても登録時刻のままになっている")
			.toBeGreaterThan(new Date(target.uploadedAt).getTime());
	});

	// カードに並べて出すため、長いとそのカードだけ背が高くなる
	test("メモは120文字で切り詰められる", async ({request}) => {
		const long = "あ".repeat(200);
		const res = await request.put(`api/mockups/${third}/memo`, {headers: rw, data: {memo: long}});
		expect(res.status()).toBe(200);
		expect((await res.json()).memo).toHaveLength(120);

		const list = await (await request.get("api/mockups", {headers: ro})).json();
		expect(list.find((m) => m.id === third).memo).toHaveLength(120);
	});

	test("120文字ちょうどはそのまま入る", async ({request}) => {
		const exact = "い".repeat(120);
		const res = await request.put(`api/mockups/${third}/memo`, {headers: rw, data: {memo: exact}});
		expect((await res.json()).memo).toBe(exact);
	});

	test("アーカイブ済みの並びはアーカイブした順のまま", async ({request}) => {
		await request.delete(`api/mockups/${first}`, {headers: rw});
		await new Promise((r) => setTimeout(r, 20));
		await request.delete(`api/mockups/${second}`, {headers: rw});

		const archived = await (await request.get("api/mockups/archived", {headers: rw})).json();
		const ids = archived.map((m) => m.id);
		expect(ids.indexOf(second), "後からアーカイブしたものが先に来ていない").toBeLessThan(ids.indexOf(first));

		await request.post(`api/mockups/${first}/restore`, {headers: rw});
		await request.post(`api/mockups/${second}/restore`, {headers: rw});
	});

	// AIからも使うので、仕様とガイドに載っていること
	test("AI向けの仕様とガイドに、上限と並び順が載っている", async ({request}) => {
		const guide = await (await request.get("api/usage.md", {headers: ro})).text();
		expect(guide, "メモの上限がAIに伝わっていない").toContain("120文字");
		expect(guide, "並び順がAIに伝わっていない").toContain("updatedAt");
		expect(guide, "SSEのイベントがAIに伝わっていない").toContain("mockups-changed");

		const openapi = await (await request.get("api/openapi.json", {headers: ro})).json();
		const memo = openapi.paths["/api/mockups/{id}/memo"].put;
		expect(JSON.stringify(memo)).toContain("120");
	});
});
