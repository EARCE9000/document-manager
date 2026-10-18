/*!
 * tag-order-miro.e2e.js : タグ体系の管理の「Miro の十字のタグをそろえる」(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro に十字で書き出すときの振り分けに使う共通のタグ(docs/miro.md の「十字」)を、決まった順で下書きに入れる。
 * ほかのタグの順は変えず、保存するまでは反映しない。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};

test.describe.serial("タグ体系に Miro の十字のタグをそろえる", () => {
	let saved;

	test.beforeAll(async ({request}) => {
		saved = (await (await request.get("api/tag_order", {headers: admin})).json()).map((r) => r.tag);
		// 既存のタグの間に、共通のタグが順不同で 1 つ入っている状態にする
		await request.put("api/tag_order", {headers: admin, data: {tags: ["設計", "工程:基本設計", "区分:管理", "仕様"]}});
	});

	test.afterAll(async ({request}) => {
		await request.put("api/tag_order", {headers: admin, data: {tags: saved}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("押すと、共通のタグが最初に出てくる位置に決まった順でまとまり、ほかのタグの順は変わらない。保存までは反映しない", async ({page, request}) => {
		await page.goto("./");
		// タグ体系の表示に切り替えると、管理者には「タグ体系を管理」が出る
		await page.locator("#menuTagTreeLink").click();
		await page.locator("#tagOrderManageButton").click();
		await page.locator("#tagOrderMiroButton").click();
		const items = page.locator("#tagOrderList li");
		await expect(items.first()).toContainText("設計");
		await expect(items.nth(1)).toContainText("区分:管理");
		await expect(items.nth(2)).toContainText("区分:会議");
		await expect(items.nth(3)).toContainText("工程:要件定義");
		await expect(items.last()).toContainText("仕様");
		// まだ保存していない
		expect((await (await request.get("api/tag_order", {headers: admin})).json()).map((r) => r.tag)).toEqual(["設計", "工程:基本設計", "区分:管理", "仕様"]);
		await page.locator("#tagOrderSaveButton").click();
		await expect(page.locator("#tagOrderOverlay")).toBeHidden();
		const tags = (await (await request.get("api/tag_order", {headers: admin})).json()).map((r) => r.tag);
		expect(tags[0]).toBe("設計");
		expect(tags.at(-1)).toBe("仕様");
		expect(tags.indexOf("工程:要件定義")).toBeLessThan(tags.indexOf("工程:基本設計"));
	});
});
