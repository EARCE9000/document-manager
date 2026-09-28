/*!
 * mockup-list-ui.e2e.js : モックアップ一覧の見え方と自動更新
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 見ているのは2つ。
 *
 *  1. **メモが3行で止まること**。カードに並べて出すため、長いとそのカードだけ背が高くなり、
 *     並べたときに目が滑る。全文はマウスを乗せれば読める(title)
 *  2. **他の人の登録に追随すること**。モックアップはSSEの対象外で、開いたままだと
 *     いつまでも古い一覧を見ていた
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const zlib = require("node:zlib");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

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

const STAMP = Date.now();
const LONG_MEMO = "受注登録画面のスマホ版。入力項目を絞って1画面に収めた案で、確認画面は省いています。" + "あ".repeat(40);

const upload = async (request, name) => {
	const res = await request.post("api/mockups", {
		headers: rw,
		multipart: {
			mockupfile: {name: "m.zip", mimeType: "application/zip",
				buffer: buildZip([{name: "index.html", data: Buffer.from("<html><body>案</body></html>", "utf-8")}])},
			name
		}
	});
	expect(res.status()).toBe(200);
	return (await res.json()).id;
};

test.describe.serial("モックアップ一覧(実ブラウザ)", () => {
	let id;

	test.beforeAll(async ({request}) => {
		id = await upload(request, `一覧E2E ${STAMP}`);
		await request.put(`api/mockups/${id}/memo`, {headers: rw, data: {memo: LONG_MEMO}});
	});

	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await page.click("#menuMockupsLink");
		await expect(page.locator(".mockupCard").first()).toBeVisible();
	});

	test("メモは3行で止まり、全文はマウスを乗せれば読める", async ({page}) => {
		const memo = page.locator(".mockupCard", {hasText: `一覧E2E ${STAMP}`}).locator(".mockupCardMemo");
		await expect(memo).toBeVisible();

		const box = await memo.evaluate((el) => {
			const cs = getComputedStyle(el);
			// line-height は "normal" のことがあるので、その場合は文字サイズから見積もる
			const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
			return {
				行数: Math.round(el.getBoundingClientRect().height / lh),
				畳まれている: el.scrollHeight > el.clientHeight + 1
			};
		});
		expect(box.行数, `${box.行数}行になっている`).toBeLessThanOrEqual(3);
		expect(box.畳まれている, "そもそも畳む必要がない長さになっている").toBe(true);
		// 全文はtitleで読める
		await expect(memo).toHaveAttribute("title", LONG_MEMO.slice(0, 120));
	});

	// メモの長さでカードの高さが変わると、並べたときに目が滑る
	test("メモの有無でカードの高さが大きく変わらない", async ({request, page}) => {
		await upload(request, `メモなし ${STAMP}`);
		await page.reload();
		await page.click("#menuMockupsLink");

		const withMemo = page.locator(".mockupCard", {hasText: `一覧E2E ${STAMP}`});
		const without = page.locator(".mockupCard", {hasText: `メモなし ${STAMP}`});
		await expect(without).toBeVisible();

		const heights = await Promise.all([withMemo, without].map((l) =>
			l.evaluate((el) => Math.round(el.getBoundingClientRect().height))));
		expect(Math.abs(heights[0] - heights[1]),
			`メモあり ${heights[0]}px / メモなし ${heights[1]}px`).toBeLessThan(80);
	});

	// 開いたままでも古い一覧を見続けないこと
	test("他の人が登録すると、開いたままでも一覧に出る", async ({request, page}) => {
		const name = `あとから登録 ${Date.now()}`;
		await upload(request, name);
		await expect(page.locator(".mockupCard", {hasText: name})).toBeVisible({timeout: 10000});
	});

	test("他の人がメモを直すと、開いたままでも先頭に来る", async ({request, page}) => {
		const target = await upload(request, `先頭に来る ${STAMP}`);
		await expect(page.locator(".mockupCard", {hasText: `先頭に来る ${STAMP}`})).toBeVisible({timeout: 10000});

		// 別のものを登録して、いったん先頭を奪う
		await upload(request, `割り込み ${STAMP}`);
		await expect(page.locator(".mockupCard").first()).toContainText(`割り込み ${STAMP}`, {timeout: 10000});

		await request.put(`api/mockups/${target}/memo`, {headers: rw, data: {memo: "直したので先頭へ"}});
		await expect(page.locator(".mockupCard").first(), "メモを直したものが先頭に来ていない")
			.toContainText(`先頭に来る ${STAMP}`, {timeout: 10000});
	});

	test("メモの編集欄に残り文字数が出て、120文字で打ち止めになる", async ({page}) => {
		const card = page.locator(".mockupCard", {hasText: `一覧E2E ${STAMP}`});
		await card.locator('[data-action="memo"]').click();
		await expect(page.locator("#mockupMemoOverlay")).toBeVisible();
		await expect(page.locator("#mockupMemoCount")).toContainText("/ 120 文字");

		await page.fill("#mockupMemoInput", "あ".repeat(200));
		// 入力欄そのものが120文字で止まる(保存してから切り詰められるより分かりやすい)
		expect(await page.inputValue("#mockupMemoInput")).toHaveLength(120);
		await expect(page.locator("#mockupMemoCount")).toHaveClass(/overLimit/);
		await page.click("#mockupMemoCancelButton");
	});
});
