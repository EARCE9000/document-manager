/*!
 * mockups-archived-access.spec.js : アーカイブ済みモックアップに readonly が到達できないことの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 「アーカイブ済みは readwrite 以上」という線を引いた以上、一覧を断るだけでは足りない。
 * **そこへ至る経路が他に無いこと**を確かめるのがこのテストの目的である。
 *
 * 特に版履歴(`/api/mockups/:id/versions`)は readonly に開けてある。ここは名前と日付だけを
 * 返す約束だが、モックアップIDも返る。つまり readonly は
 *
 *   現役の一覧を引く → 各版の版履歴を引く → アーカイブ済みのIDを知る
 *
 * まで到達できる。そのIDで中身が開けてしまうと、線を引いた意味が無くなる。
 * ここではIDを知っている前提で、中身に触れる全経路を総当たりする。
 */

const {test, expect} = require("@playwright/test");
const zlib = require("zlib");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const buildZip = (entries) => {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const {name, data} of entries) {
		const nameBuf = Buffer.from(name, "utf-8");
		const payload = zlib.deflateRawSync(data, {level: 9});
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + payload.length;
	}
	const localPart = Buffer.concat(locals);
	const centralPart = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
};

const t = (value) => Buffer.from(value, "utf-8");
// 引退した版にしか入っていない語。現役の検索で引っかかってはいけない
const SECRET = `退役した版にしかない語_${Date.now()}`;

const site = () => buildZip([
	{name: "index.html", data: t(`<html><body><h1>${SECRET}</h1></body></html>`)},
	{name: "app.js", data: t('document.title = "old";')},
	{name: "secret.txt", data: t(SECRET)}
]);

test.describe.serial("アーカイブ済みモックアップへの到達", () => {
	let archivedId;
	let activeId;
	let rwToken;

	test.beforeAll(async ({request}) => {
		// 旧版を作って、新しい版で置き換える(＝自動でアーカイブされる)
		const first = await (await request.post("api/mockups", {
			headers: rw,
			multipart: {
				mockupfile: {name: "old.zip", mimeType: "application/zip", buffer: site()},
				// 画像を付けておく。付けないと preview は「画像が無い」の404になり、
				// 権限で断ったのか区別がつかない
				previewfile: {name: "preview.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex")},
				name: `退役予定 ${Date.now()}`
			}
		})).json();
		archivedId = first.id;

		const second = await (await request.post("api/mockups", {
			headers: rw,
			multipart: {
				mockupfile: {name: "new.zip", mimeType: "application/zip", buffer: buildZip([{name: "index.html", data: t("<html><body>現役</body></html>")}])},
				name: `現役 ${Date.now()}`,
				previousId: archivedId
			}
		})).json();
		activeId = second.id;
		expect(second.archivedPrevious, "旧版がアーカイブされた前提").toBe(true);

		// readwrite なら開ける(比較対象。ここが開けないなら機能が壊れている)
		const entry = await request.get(`api/mockups/${archivedId}/view`, {headers: rw, maxRedirects: 0});
		expect([301, 302, 307]).toContain(entry.status());
		rwToken = entry.headers()["location"].match(/\/view\/([^/]+)\//)[1];
		const served = await request.get(`api/mockups/${archivedId}/view/${rwToken}/index.html`);
		expect(served.status(), "readwriteは開ける").toBe(200);
		expect(await served.text()).toContain(SECRET);
		// 以降の404が「権限で断った」ものだと言えるよう、readwriteでは取れることを固定する
		for (const path of [`api/mockups/${archivedId}`, `api/mockups/${archivedId}/preview`, `api/mockups/${archivedId}/download`]) {
			expect((await request.get(path, {headers: rw})).status(), `readwriteでは取れる: ${path}`).toBe(200);
		}
	});

	// 版履歴からIDは知れる(そういう線引きにした)。知れること自体はここで明示しておく
	test("版履歴からアーカイブ済みのIDは知れる(意図した線引き)", async ({request}) => {
		const versions = await (await request.get(`api/mockups/${activeId}/versions`, {headers: ro})).json();
		const found = versions.find((v) => v.id === archivedId);
		expect(found, "版履歴に旧版が載る").toBeTruthy();
		expect(found.archived).toBe(true);
		// ただし中身は載らない
		expect(found.contentText).toBeUndefined();
	});

	test("readonlyはアーカイブ済みを一覧できない", async ({request}) => {
		expect((await request.get("api/mockups/archived", {headers: ro})).status()).toBe(403);
		expect((await request.get(`api/mockups/archived?q=${encodeURIComponent(SECRET)}`, {headers: ro})).status()).toBe(403);
	});

	test("現役の検索にアーカイブ済みの本文が混ざらない", async ({request}) => {
		const hits = await (await request.get(`api/mockups?q=${encodeURIComponent(SECRET)}`, {headers: ro})).json();
		expect(hits.map((m) => m.id)).not.toContain(archivedId);
	});

	// ここが本題。IDを知っていても中身に触れないこと
	test("readonlyはIDを知っていてもアーカイブ済みの中身に触れられない", async ({request}) => {
		const attempts = [
			{what: "1件の情報", path: `api/mockups/${archivedId}`},
			{what: "プレビュー画像", path: `api/mockups/${archivedId}/preview`},
			{what: "原本ZIP", path: `api/mockups/${archivedId}/download`},
			{what: "入口(引換券の発行)", path: `api/mockups/${archivedId}/view`}
		];
		// 1つ目で止めず、開いている経路をすべて並べる(塞ぎ漏らしに気づけるように)
		const opened = [];
		for (const {what, path} of attempts) {
			const res = await request.get(path, {headers: ro, maxRedirects: 0});
			if (![403, 404].includes(res.status())) opened.push(`${what} (HTTP ${res.status()})`);
		}
		expect(opened, "readonly に開いている経路がある").toEqual([]);
	});

	test("readonlyが入口を叩いても引換券は出ない", async ({request}) => {
		const res = await request.get(`api/mockups/${archivedId}/view`, {headers: ro, maxRedirects: 0});
		const location = res.headers()["location"] || "";
		expect(location, "転送先に引換券が乗ってはいけない").not.toMatch(/\/view\/[A-Za-z0-9_-]+\./);
	});

	// 引換券は認証の代わりになるため、誰が持っていても効く。
	// readonlyが券を手に入れられないことが上で担保されている必要がある
	test("readwriteが取った引換券は、アーカイブ後も期限内は効く(仕様)", async ({request}) => {
		const res = await request.get(`api/mockups/${archivedId}/view/${rwToken}/secret.txt`);
		expect(res.status(), "券を持っている限り開ける(アーカイブは削除ではない)").toBe(200);
	});

	test("復元すれば readonly からも見えるようになる", async ({request}) => {
		expect((await request.post(`api/mockups/${archivedId}/restore`, {headers: rw})).status()).toBe(200);
		const res = await request.get(`api/mockups/${archivedId}`, {headers: ro});
		expect(res.status(), "現役に戻れば readonly でも読める").toBe(200);

		// 後片付け(以降のテストに現役として残さない)
		await request.delete(`api/mockups/${archivedId}`, {headers: rw});
		await request.delete(`api/mockups/${activeId}`, {headers: rw});
	});
});
