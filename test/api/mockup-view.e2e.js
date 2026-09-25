/*!
 * mockup-view.e2e.js : モックアップの配信を実ブラウザで確かめるE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * モックアップは「JSが動くこと」と「このアプリに手が届かないこと」を同時に満たす必要がある。
 * ヘッダーが付いているかはAPIテストで見ているが、それで実際にブラウザがどう振る舞うかは別の話。
 * 実物を開いて、次の両方を確かめる。
 *   1. モックアップ自身のJS・CSS・相対パスのリンクが普通に動く
 *   2. オリジンを持たず(origin: null)、このアプリのAPIを読めない
 *
 * 1が特に大事で、ここは一度実際に壊れた。オリジンを落とすとページからの副リソース要求が
 * クロスサイト扱いになり、SameSite=Laxのセッションcookieが送られない。そのため配信側に
 * 素朴に認証を置くと、HTMLは開けるのに中のJS・CSSが全部401で遮断される
 * (Chromeは ERR_BLOCKED_BY_ORB として落とすので、画面には何も出ない)。
 * 今は入口で引換券を発行して配信しているが、それが本当にブラウザで動くのかは
 * ヘッダーを見ても分からない。だからここで実物を開いて確かめている。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const zlib = require("zlib");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

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

// Reactのように「JSがDOMを組み立てる」モックアップを模す。
// あわせて、このアプリのAPIを読みにいく処理も入れておく(遮断されることを確かめるため)
const APP_JS = `
	document.getElementById("app").innerHTML = '<h1 class="title">JSが組み立てた画面</h1>';
	window.__probe = {rendered: true, origin: String(window.origin)};
	try { window.__probe.cookie = document.cookie === "" ? "読めない" : "読めた"; }
	catch (e) { window.__probe.cookie = "読めない"; }
	fetch("/api/documents", {credentials: "include"})
		.then((res) => res.text())
		.then((text) => { window.__probe.api = "読めた: " + text.slice(0, 40); })
		.catch(() => { window.__probe.api = "読めない"; });
`;

const SITE = [
	{name: "index.html", data: t('<html><head><link rel="stylesheet" href="./assets/style.css"></head>'
		+ '<body><div id="app">まだ描画されていません</div>'
		+ '<a id="toDetail" href="./pages/detail.html">詳細へ</a>'
		+ '<script src="./app.js"></script></body></html>')},
	{name: "app.js", data: t(APP_JS)},
	{name: "assets/style.css", data: t(".title { color: rgb(0, 128, 0); }")},
	{name: "pages/detail.html", data: t('<html><head><link rel="stylesheet" href="../assets/style.css"></head>'
		+ '<body><h1 class="title" id="detail">詳細ページ</h1>'
		+ '<a id="back" href="../index.html">トップへ戻る</a></body></html>')}
];

test.describe.serial("モックアップの表示(実ブラウザ)", () => {
	let mockupId;

	test.beforeAll(async ({request}) => {
		const res = await request.post("api/mockups", {
			headers: {Authorization: `Bearer ${keys.readwrite}`},
			multipart: {
				mockupfile: {name: "e2e-mockup.zip", mimeType: "application/zip", buffer: buildZip(SITE)},
				name: `E2Eモックアップ ${Date.now()}`
			}
		});
		expect(res.status()).toBe(200);
		mockupId = (await res.json()).id;
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("JS・CSS・相対パスのリンクが普通に動く", async ({page}) => {
		// 入口から開く。ここは通常のページ遷移なのでcookieが届き、引換券つきのURLへ転送される
		await page.goto(`./api/mockups/${mockupId}/view`);
		// JSがDOMを組み立てている(Reactのようなモックアップでも中身が出る)
		await expect(page.locator("#app h1")).toHaveText("JSが組み立てた画面");
		// 同じ場所のCSSが効いている
		await expect(page.locator(".title")).toHaveCSS("color", "rgb(0, 128, 0)");

		// 相対パスのリンクで下の階層へ移動でき、そこから "../" で上のCSSも読める
		await page.click("#toDetail");
		await expect(page.locator("#detail")).toHaveText("詳細ページ");
		await expect(page.locator("#detail")).toHaveCSS("color", "rgb(0, 128, 0)");
		// "../" で戻れる
		await page.click("#back");
		await expect(page.locator("#app h1")).toHaveText("JSが組み立てた画面");
	});

	test("オリジンを持たず、このアプリのAPIにもcookieにも手が届かない", async ({page}) => {
		await page.goto(`./api/mockups/${mockupId}/view`);
		await expect(page.locator("#app h1")).toBeVisible();
		await page.waitForTimeout(600);

		const probe = await page.evaluate(() => window.__probe);
		expect(probe.rendered, "JSは動いている").toBe(true);
		expect(probe.origin, "オリジンを持たない").toBe("null");
		expect(probe.cookie, "cookieを読めない").toBe("読めない");
		expect(probe.api, "APIを読めない").toBe("読めない");
	});

	// 「HTMLは出るのにJS・CSSが全部401で落ちる」を見逃さないための番犬。
	// 画面の見た目だけ見ていると気づきにくいので、要求の結果を直接数える
	test("中の部品が一つも遮断されない", async ({page}) => {
		// 見るのはモックアップ自身のファイル(/view/配下)だけ。
		// このモックアップはわざとAPIも叩くが、そちらは遮断されるのが正しい
		const own = (url) => url.includes("/view/");
		const failures = [];
		const statuses = [];
		page.on("requestfailed", (request) => {
			if (own(request.url())) failures.push(`${request.url()} : ${request.failure()?.errorText}`);
		});
		page.on("response", (response) => {
			if (own(response.url())) statuses.push(`${response.status()} ${response.url()}`);
		});

		await page.goto(`./api/mockups/${mockupId}/view`);
		await expect(page.locator("#app h1")).toHaveText("JSが組み立てた画面");
		await page.waitForTimeout(400);

		expect(failures, "遮断された要求がある").toEqual([]);
		expect(statuses.filter((line) => !line.startsWith("200")), "200以外が返った要求がある").toEqual([]);
		expect(statuses.length, "HTML・JS・CSSの3つが配信される").toBe(3);
		// 引換券の下で配信されている
		expect(page.url()).toMatch(/\/view\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/);
	});

	test("引換券が無ければ中身は配信されない", async ({page}) => {
		// 券のところをでっち上げる
		const res = await page.goto(`./api/mockups/${mockupId}/view/abc.def/index.html`);
		expect(res.status()).toBe(401);
	});
});
