/*!
 * help.e2e.js : 使い方(ヘルプ)の画面
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 以前のヘルプはAI向けの利用ガイド(api/usage.md)をそのまま載せていた。同じものを
 * APIキーの発行画面が**実際のキーに差し替えた形**で出しており、ヘルプ側はそのままでは
 * 動かない版だった。重複を畳み、こちらは画面の使い方に充てている。
 *
 * 見ているのは3つ。
 *   - AIの話が混ざっていないこと(戻ると、また動かない版を配ることになる)
 *   - 使えない機能の説明を出さないこと(書いてあるのに見当たらない、が一番困る)
 *   - 画面に収まること(閉じるボタンへ手が届かないと詰む)
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

test.describe("使い方(実ブラウザ)", () => {
	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await page.click("#helpButton");
		await expect(page.locator("#helpBody")).toBeVisible();
	});

	test("画面の使い方が書かれている", async ({page}) => {
		const body = page.locator("#helpBody");
		await expect(body.locator("section")).not.toHaveCount(0);
		for (const heading of ["探す", "おしながき", "アーカイブ(消さない削除)"]) {
			await expect(body.locator("h3", {hasText: heading})).toBeVisible();
		}
	});

	// ここが戻ると、そのままでは動かないAI向けガイドをまた配ることになる
	test("AI向けの案内は載せていない(APIキーの画面に一本化している)", async ({page}) => {
		const text = await page.locator("#helpBody").innerText();
		for (const word of ["APIキー", "Claude", "Antigravity", "カスタム指示", "OpenAPI"]) {
			expect(text, `「${word}」がヘルプに残っている`).not.toContain(word);
		}
		// 貼り付け用のテキスト欄も無い
		await expect(page.locator("#helpModalBox textarea")).toHaveCount(0);
	});

	test("閉じるボタンが画面に収まっている", async ({page}) => {
		const fits = await page.evaluate(() => {
			const box = document.getElementById("helpModalBox").getBoundingClientRect();
			return box.top >= 0 && box.bottom <= window.innerHeight;
		});
		expect(fits, "モーダルが画面からはみ出している").toBe(true);

		await page.click("#helpCloseButton");
		await expect(page.locator("#helpBody")).toBeHidden();
	});

	// 書いてあるのに見当たらない、が一番困る
	test("モックアップが無効なら、その説明は出さない", async ({page}) => {
		const enabled = await page.evaluate(() =>
			document.getElementById("appShell").classList.contains("mockupsEnabled"));
		const section = page.locator("#helpBody .helpMockups");
		if (enabled) await expect(section).toBeVisible();
		else await expect(section).toBeHidden();
	});

	test("狭い画面でも読めて、閉じられる", async ({page}) => {
		// beforeEach で既に開いている。開いたまま画面を狭めても収まること
		await page.setViewportSize({width: 900, height: 600});
		await expect(page.locator("#helpBody")).toBeVisible();

		const fits = await page.evaluate(() => {
			const box = document.getElementById("helpModalBox").getBoundingClientRect();
			return box.top >= 0 && box.bottom <= window.innerHeight;
		});
		expect(fits, "狭い画面でモーダルがはみ出している").toBe(true);
		// 中身は枠の中でスクロールする
		const scrolls = await page.locator("#helpBody").evaluate((el) => el.scrollHeight > el.clientHeight);
		expect(scrolls).toBe(true);
	});
});
