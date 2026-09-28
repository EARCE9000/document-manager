/*!
 * mockup-storage-split.spec.js : モックアップの「原本」と「展開したもの」の分離
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * モックアップは1ページ開くたびにHTML/CSS/JS/画像と何十回も取りに行くため、展開後のものまで
 * S3から都度配信すると、リクエスト課金と往復遅延が効いてくる。そこで置き場所を2つに分けた。
 *
 *   source.zip / preview.<ext> … STORAGE_BACKEND に従う(local / s3 / gcs)。**原本**
 *   site/                       … 常にローカルディスク。**捨ててよい控え**
 *
 * この形が成り立つのは「site/ が無ければ原本から作り直せる」からで、そこが効くのは
 *   - 複数インスタンス(ECS等)で、登録した台と配信する台が違うとき
 *   - コンテナを作り直してローカルが空になったとき
 * である。どちらもこのテストでは site/ を消すことで再現する(実際に起きるのと同じ状態)。
 *
 * あわせて、**既に物理サーバで動いている環境(local構成)の並びが変わっていないこと**も見る。
 * ここが変わると、入れ替えた瞬間に既存のモックアップが見えなくなる。
 */

const {test, expect} = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {loadKeys, TEST_DATA_DIR} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

/* mockups.spec.js と同じ組み立て(共有するとどちらかの都合で壊れるため、あえて持つ) */
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
const SITE = [
	{name: "index.html", data: t("<html><body><h1>入口</h1></body></html>")},
	{name: "assets/style.css", data: t("body { color: rgb(0, 128, 0); }")},
	{name: "pages/detail.html", data: t("<html><body>詳細</body></html>")}
];

const mockupDir = (id) => path.join(TEST_DATA_DIR, "mockups", id);
const siteDir = (id) => path.join(mockupDir(id), "site");

const viewBase = async (request, id) => {
	const res = await request.get(`api/mockups/${id}/view`, {headers: ro, maxRedirects: 0});
	expect([301, 302, 307]).toContain(res.status());
	const matched = res.headers()["location"].match(/\/view\/([^/]+)\//);
	expect(matched).not.toBeNull();
	return `api/mockups/${id}/view/${matched[1]}`;
};

test.describe.serial("モックアップの原本と控え", () => {
	let id;

	test.beforeAll(async ({request}) => {
		const res = await request.post("api/mockups", {
			headers: rw,
			multipart: {
				mockupfile: {name: "mockup.zip", mimeType: "application/zip", buffer: buildZip(SITE)},
				name: `置き場所の分離 ${Date.now()}`,
				previewfile: {name: "preview.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex")}
			}
		});
		expect(res.status()).toBe(200);
		id = (await res.json()).id;
	});

	// 既に動いている環境がある。入れ替えた瞬間に見えなくなることがあってはいけない
	test("local構成の並びは従来どおり(<DATA_DIR>/mockups/<ID>/ に原本と site/)", async () => {
		expect(fs.existsSync(path.join(mockupDir(id), "source.zip")), "原本の置き場所が変わっている").toBe(true);
		expect(fs.existsSync(path.join(mockupDir(id), "preview.png")), "プレビュー画像の置き場所が変わっている").toBe(true);
		expect(fs.existsSync(path.join(siteDir(id), "index.html")), "展開先が変わっている").toBe(true);
		expect(fs.existsSync(path.join(siteDir(id), "assets", "style.css"))).toBe(true);
	});

	test("ふつうに配信できる", async ({request}) => {
		const base = await viewBase(request, id);
		const res = await request.get(`${base}/index.html`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain("入口");
	});

	// 登録した台と配信する台が違うとき(ECS)と、コンテナを作り直したときに起きる状態
	test("展開したものが消えていても、原本から作り直して配信する", async ({request}) => {
		fs.rmSync(siteDir(id), {recursive: true, force: true});
		expect(fs.existsSync(siteDir(id)), "前提: 消えている").toBe(false);

		const base = await viewBase(request, id);
		const res = await request.get(`${base}/index.html`, {headers: ro});
		expect(res.status(), "作り直せていない").toBe(200);
		expect(await res.text()).toContain("入口");

		// 下位ディレクトリまで揃っている
		expect(fs.existsSync(path.join(siteDir(id), "assets", "style.css"))).toBe(true);
		const nested = await request.get(`${base}/pages/detail.html`, {headers: ro});
		expect(nested.status()).toBe(200);
	});

	// 同じモックアップに同時に来たときに、二重に展開して取り違えないこと
	test("同時に開かれても壊れない", async ({request}) => {
		fs.rmSync(siteDir(id), {recursive: true, force: true});
		const base = await viewBase(request, id);

		const results = await Promise.all(Array.from({length: 8}, () =>
			request.get(`${base}/index.html`, {headers: ro})));
		for (const res of results) expect(res.status()).toBe(200);
		for (const res of results) expect(await res.text()).toContain("入口");

		// 作業用の一時ディレクトリが残っていない
		const leftovers = fs.readdirSync(mockupDir(id)).filter((name) => name.startsWith("site.tmp-"));
		expect(leftovers, `作業用の入れ物が残っている: ${leftovers.join(", ")}`).toEqual([]);
	});

	test("作り直しても、置き場所の外を指す要求は通らない", async ({request}) => {
		fs.rmSync(siteDir(id), {recursive: true, force: true});
		const base = await viewBase(request, id);
		await request.get(`${base}/index.html`, {headers: ro});

		for (const attempt of ["../source.zip", "..%2Fsource.zip", "pages/../../source.zip"]) {
			const res = await request.get(`${base}/${attempt}`, {headers: ro});
			expect(res.status(), `${attempt} が通っている`).toBe(404);
		}
	});

	// 原本まで失われていたら作り直しようがない。黙って空を返さず、失敗として扱う
	test("原本が無ければ、配信は失敗として扱う", async ({request}) => {
		const zipPath = path.join(mockupDir(id), "source.zip");
		const backup = fs.readFileSync(zipPath);
		fs.rmSync(siteDir(id), {recursive: true, force: true});
		fs.rmSync(zipPath, {force: true});
		try {
			const base = await viewBase(request, id);
			const res = await request.get(`${base}/index.html`, {headers: ro});
			expect([404, 500], "原本が無いのに200を返している").toContain(res.status());
		} finally {
			fs.writeFileSync(zipPath, backup);
		}
	});

	test("ZIPのダウンロードとプレビュー画像は原本から返る", async ({request}) => {
		const zip = await request.get(`api/mockups/${id}/download`, {headers: ro});
		expect(zip.status()).toBe(200);
		expect((await zip.body()).length).toBeGreaterThan(0);

		const preview = await request.get(`api/mockups/${id}/preview`, {headers: ro});
		expect(preview.status()).toBe(200);
	});
});
