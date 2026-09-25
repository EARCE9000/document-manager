/*!
 * mockups.spec.js : モックアップの登録・配信のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * いちばん確かめたいのは配信のしかた。モックアップのJSは動かす必要がある一方で、
 * このアプリのAPIやcookieに手が届いてはいけない。そのために
 * `Content-Security-Policy: sandbox allow-scripts` を付けてオリジンを落としている
 * (docs/mockup.md)。ヘッダーが実際に付いていることと、URLで置き場所の外へ出られない
 * ことを確認する。
 *
 * オリジンを落とすと副リソースの要求にセッションcookieが付かないため、中身の配信は
 * 入口で発行する引換券で認可している(lib/mockup-token.js)。「券があれば見られる」と
 * 同時に「券が無ければ見られない」「他のモックアップの券では見られない」ことを確かめる。
 */

const {test, expect} = require("@playwright/test");
const zlib = require("zlib");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

/* ---- テスト用のZIPを組み立てる ---- */
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
	{name: "index.html", data: t('<html><body><h1>トップ</h1><a href="./pages/detail.html">詳細</a><script src="./app.js"></script></body></html>')},
	{name: "app.js", data: t('document.title = "うごいた";')},
	{name: "assets/style.css", data: t("body { color: rgb(0, 128, 0); }")},
	{name: "pages/detail.html", data: t('<html><head><link rel="stylesheet" href="../assets/style.css"></head><body>詳細ページの本文</body></html>')},
	{name: "sample.xlsx", data: t("サンプルの添付ファイル")}
];

const upload = (request, {zip = buildZip(SITE), name = "テストモックアップ", previousId, preview} = {}) => {
	const multipart = {
		mockupfile: {name: "mockup.zip", mimeType: "application/zip", buffer: zip},
		name
	};
	if (previousId) multipart.previousId = previousId;
	if (preview) multipart.previewfile = {name: "preview.png", mimeType: "image/png", buffer: preview};
	return request.post("api/mockups", {headers: rw, multipart});
};

// 入口を開いて、配信URLの土台(引換券まで)を得る。ここは認証が必要
const viewBase = async (request, id, headers = ro) => {
	const res = await request.get(`api/mockups/${id}/view`, {headers, maxRedirects: 0});
	expect([301, 302, 307], "入口は転送される").toContain(res.status());
	const location = res.headers()["location"];
	const matched = location.match(/\/view\/([^/]+)\//);
	expect(matched, `引換券が付いた転送先ではない: ${location}`).not.toBeNull();
	return `api/mockups/${id}/view/${matched[1]}`;
};

test.describe.serial("モックアップ", () => {
	let mockupId;

	test("ZIPを登録すると展開され、入口が決まる", async ({request}) => {
		const res = await upload(request, {preview: Buffer.from("89504e470d0a1a0a", "hex")});
		expect(res.status()).toBe(200);
		const body = await res.json();
		mockupId = body.id;

		expect(body.name).toBe("テストモックアップ");
		expect(body.entryFile).toBe("index.html");
		expect(body.fileCount).toBe(SITE.length);
		expect(body.totalBytes).toBeGreaterThan(0);
		expect(body.previewFile).toBe("preview.png");
		// 本文は応答に載せない(AIの文脈を埋めないため)
		expect(body.contentText).toBeUndefined();
	});

	test("一覧に出て、中のHTMLのテキストで検索できる", async ({request}) => {
		const list = await (await request.get("api/mockups", {headers: ro})).json();
		expect(list.some((item) => item.id === mockupId)).toBe(true);

		const found = await (await request.get("api/mockups?q=詳細ページの本文", {headers: ro})).json();
		expect(found.some((item) => item.id === mockupId), "HTMLから抜いたテキストで探せる").toBe(true);
	});

	// ここが設計の要。JSは動かせる必要があるが、オリジンは渡してはいけない
	test("配信されるファイルには sandbox のCSPが付く", async ({request}) => {
		// 認証ヘッダーは付けない。ブラウザでも同じで、cookieは届かず引換券だけが根拠になる
		const base = await viewBase(request, mockupId);
		const res = await request.get(`${base}/index.html`);
		expect(res.status()).toBe(200);
		expect(res.headers()["content-security-policy"]).toBe("sandbox allow-scripts");
		expect(res.headers()["content-type"]).toContain("text/html");
		expect(await res.text()).toContain("トップ");

		// JS・CSSも同じ扱いで配信される(モックアップが動くために必要)
		const js = await request.get(`${base}/app.js`);
		expect(js.status()).toBe(200);
		expect(js.headers()["content-type"]).toContain("text/javascript");
		expect(js.headers()["content-security-policy"]).toBe("sandbox allow-scripts");

		const css = await request.get(`${base}/assets/style.css`);
		expect(css.status()).toBe(200);
		expect(css.headers()["content-type"]).toContain("text/css");
	});

	test("表に無い種類はブラウザに解釈させず、保存してもらう", async ({request}) => {
		const res = await request.get(`${await viewBase(request, mockupId)}/sample.xlsx`);
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/octet-stream");
		expect(res.headers()["content-disposition"]).toContain("attachment");
	});

	test("入口を開くと、引換券つきの index.html へ転送される", async ({request}) => {
		const res = await request.get(`api/mockups/${mockupId}/view`, {headers: ro, maxRedirects: 0});
		expect([301, 302, 307]).toContain(res.status());
		const location = res.headers()["location"];
		expect(location).toMatch(/\/view\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/);
		// 券がURLのパスに入っていても、相対パスの解決先は券の下に収まる
		expect(location).not.toContain("?");
	});

	// URLのパスは利用者が送ってくる値で、展開時の検査とは別物
	test("URLで置き場所の外へ出られない", async ({request}) => {
		const hostile = [
			"../../../db/document_manager_v15.sqlite",
			"..%2f..%2f..%2fdb%2fdocument_manager_v15.sqlite",
			"%2e%2e%2f%2e%2e%2fsource.zip",
			"../source.zip"
		];
		const base = await viewBase(request, mockupId);
		for (const target of hostile) {
			const res = await request.get(`${base}/${target}`, {maxRedirects: 0});
			expect([404, 301, 302], `拒否されるべき: ${target}`).toContain(res.status());
			if (res.status() === 200) throw new Error(`外のファイルが読めてしまった: ${target}`);
		}
	});

	test("原本のZIPをダウンロードできる", async ({request}) => {
		const res = await request.get(`api/mockups/${mockupId}/download`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/zip");
		expect((await res.body()).subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
	});

	test("プレビュー画像を取得できる", async ({request}) => {
		const res = await request.get(`api/mockups/${mockupId}/preview`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("image/png");
	});

	test("新しい版を登録すると旧版はアーカイブされ、版履歴で辿れる", async ({request}) => {
		const res = await upload(request, {name: "テストモックアップ v2", previousId: mockupId});
		expect(res.status()).toBe(200);
		const v2 = await res.json();
		expect(v2.previousId).toBe(mockupId);
		expect(v2.archivedPrevious).toBe(true);

		const versions = await (await request.get(`api/mockups/${v2.id}/versions`, {headers: ro})).json();
		expect(versions.map((item) => item.id)).toEqual([mockupId, v2.id]);

		// 既に新しい版がある版を指定すると409
        const again = await upload(request, {previousId: mockupId});
		expect(again.status()).toBe(409);

		mockupId = v2.id;
	});

	test("壊れたZIP・細工したZIPは400で拒否する", async ({request}) => {
		expect((await upload(request, {zip: Buffer.from("これはZIPではありません")})).status()).toBe(400);

		// 展開先の外を指すエントリ名
		const escaping = buildZip([{name: "../../db/document_manager_v15.sqlite", data: t("乗っ取り")}]);
		const res = await upload(request, {zip: escaping});
		expect(res.status()).toBe(400);
		expect((await res.json()).error).toMatch(/上位の階層|展開先の外/);
	});

	test("readonlyキーでは登録できない", async ({request}) => {
		const res = await request.post("api/mockups", {
			headers: ro,
			multipart: {mockupfile: {name: "m.zip", mimeType: "application/zip", buffer: buildZip(SITE)}}
		});
		expect(res.status()).toBe(403);
	});

	test("未認証では入口を開けない(引換券が手に入らない)", async ({request}) => {
		expect((await request.get("api/mockups")).status()).toBe(401);
		// 入口は認証が必要。ここを通れない限り引換券は発行されない
		expect((await request.get(`api/mockups/${mockupId}/view`, {maxRedirects: 0})).status()).toBe(401);
	});

	test("引換券が無い・偽の券では中身を配信しない", async ({request}) => {
		const base = await viewBase(request, mockupId);
		const token = base.split("/").pop();

		// 券のところをファイル名だと言い張っても、そんなルートは無い
		const noToken = await request.get(`api/mockups/${mockupId}/view/index.html`, {maxRedirects: 0});
		expect([401, 404]).toContain(noToken.status());

		// でっち上げた券
		for (const forged of ["abc.def", `${token}x`, `x${token}`, "a".repeat(64) + "." + "b".repeat(43)]) {
			const res = await request.get(`api/mockups/${mockupId}/view/${forged}/index.html`, {maxRedirects: 0});
			expect(res.status(), `通してはいけない券: ${forged.slice(0, 20)}...`).toBe(401);
		}
	});

	test("他のモックアップの引換券では見られない", async ({request}) => {
		const other = await (await upload(request, {name: "別のモックアップ"})).json();
		const otherBase = await viewBase(request, other.id);
		const otherToken = otherBase.split("/").pop();

		// 券は本来のモックアップには通る
		expect((await request.get(`${otherBase}/index.html`)).status()).toBe(200);
		// 別のモックアップのIDに差し替えると通らない
		const res = await request.get(`api/mockups/${mockupId}/view/${otherToken}/index.html`, {maxRedirects: 0});
		expect(res.status()).toBe(401);
	});

	test("アーカイブして復元できる", async ({request}) => {
		expect((await request.delete(`api/mockups/${mockupId}`, {headers: rw})).status()).toBe(204);
		const archived = await (await request.get("api/mockups?archived=1", {headers: ro})).json();
		expect(archived.some((item) => item.id === mockupId)).toBe(true);

		expect((await request.post(`api/mockups/${mockupId}/restore`, {headers: rw})).status()).toBe(200);
		const active = await (await request.get("api/mockups", {headers: ro})).json();
		expect(active.some((item) => item.id === mockupId)).toBe(true);
	});
});
