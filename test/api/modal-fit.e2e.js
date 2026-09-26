/*!
 * modal-fit.e2e.js : モーダルが画面からはみ出さないことの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * モーダルは中央寄せで出している。中身が画面より高くなると、上下が均等に画面の外へ出て
 * **スクロールもできず、説明の先頭と末尾のボタンに永久に届かなくなる**。
 * 実際にAPIキー管理でSkillの手順を開いた状態で起きた(ブックマークバー等で縦が狭いと起きやすい)。
 *
 * ブラウザの縦幅は利用者ごとに違うため、狭い画面で開いて「収まっているか」「中で操作できるか」を
 * 実ブラウザで確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

// ノートPC + ブックマークバー + 拡張機能、くらいの狭さ
const NARROW = {width: 1280, height: 620};

test.describe("モーダルが画面に収まる(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	// 箱が画面の内側にあり、かつ中身が長いなら自分でスクロールできること
	const expectFits = async (page, selector) => {
		const box = page.locator(selector);
		await expect(box).toBeVisible();
		const rect = await box.boundingBox();
		const viewport = page.viewportSize();

		expect(rect.y, `上が画面の外へ出ている (y=${rect.y})`).toBeGreaterThanOrEqual(0);
		expect(rect.y + rect.height, `下が画面の外へ出ている (下端=${Math.round(rect.y + rect.height)} / 画面=${viewport.height})`)
			.toBeLessThanOrEqual(viewport.height);

		// はみ出す中身は、箱の中でスクロールして届くこと
		const {scrollHeight, clientHeight} = await box.evaluate((el) => ({scrollHeight: el.scrollHeight, clientHeight: el.clientHeight}));
		if (scrollHeight > clientHeight) {
			await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
			const scrolled = await box.evaluate((el) => el.scrollTop);
			expect(scrolled, "中身がはみ出しているのにスクロールできない").toBeGreaterThan(0);
		}
	};

	test("APIキー管理はSkillの手順を開いても収まる", async ({page}) => {
		await page.setViewportSize(NARROW);
		await page.goto("./");
		await page.click("#apiKeyManageLink");
		await expect(page.locator("#apiKeyModalBox")).toBeVisible();
		await expectFits(page, "#apiKeyModalBox");

		// ここが実際に起きた状態。手順を開くと一気に長くなる
		await page.click("#claudeSkillBox summary");
		await page.locator('#claudeSkillBox .skillAgentTab[data-agent="claude"]').waitFor();
		await expectFits(page, "#apiKeyModalBox");

		// 末尾まで送っても、先頭の説明に戻れること(戻れないと読み直せない)
		await page.locator("#apiKeyModalBox").evaluate((el) => { el.scrollTop = el.scrollHeight; });
		await page.locator("#apiKeyModalBox").evaluate((el) => { el.scrollTop = 0; });
		expect(await page.locator("#apiKeyModalBox").evaluate((el) => el.scrollTop)).toBe(0);
	});

	test("かなり狭い画面でも上下が切れない", async ({page}) => {
		await page.setViewportSize({width: 1024, height: 450});
		await page.goto("./");
		await page.click("#apiKeyManageLink");
		await page.click("#claudeSkillBox summary");
		await expectFits(page, "#apiKeyModalBox");
	});

	// 横を広く取ったのは、キーの一覧・手順・コマンドを折り返させないため。
	// 折り返すと1件が何行にもなり、キーが増えたときに一覧として読めなくなる
	test("発行済みキーは1件が1行に収まる", async ({page}) => {
		await page.setViewportSize({width: 1920, height: 1080});
		await page.goto("./");
		await page.click("#apiKeyManageLink");

		await page.fill("#apiKeyLabelInput", `1行表示の確認 ${Date.now()}`);
		await page.click("#apiKeyCreateButton");
		await page.locator("#apiKeyList li").first().waitFor();

		// 行の中の要素(発行日時・用途・最終使用・有効期限)が同じ高さに並んでいること。
		// 高さの絶対値で見ると余白やフォントの変更で壊れるため、縦位置の揃いで見る
		const centers = await page.locator("#apiKeyList li").first().locator(".apiKeyInfo > *").evaluateAll(
			(els) => els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; })
		);
		expect(centers.length, "行の中身が取れていない").toBeGreaterThan(2);
		const spread = Math.max(...centers) - Math.min(...centers);
		expect(spread, `1行に並んでいない(縦のばらつき ${Math.round(spread)}px)`).toBeLessThan(6);
	});

	// 他のモーダルも同じ仕組み(.modalBox)で出しているため、まとめて確かめる
	test("他のモーダルも収まる", async ({page}) => {
		await page.setViewportSize(NARROW);
		await page.goto("./");

		await page.click("#helpButton");
		await expectFits(page, "#helpModalBox");
		await page.click("#helpCloseButton");

		await page.click("#historyManageLink");
		await expectFits(page, "#historyOverlay .modalBox");
	});
});
