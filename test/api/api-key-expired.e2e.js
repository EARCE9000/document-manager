/*!
 * api-key-expired.e2e.js : APIキーの画面で、期限切れのキーをまとめて消す
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 一覧の右上に「期限切れのキー: N 本」とゴミ箱が出て、押すと期限切れのキーだけが一覧から消える。
 * 期限切れが 0 本になったら、その行は出さない。消すと戻せないので、serve.js が用意した
 * 専用の利用者(expiredCleanupUi。期限内 1 本 + 期限切れ 2 本)で確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const {expiredCleanupUi} = keys.revokeTargets;

test("期限切れのキーをまとめて消すと、期限内のキーだけが残り、まとめて消す行も消える", async ({context, page}) => {
	await context.addCookies([{name: keys.sessionCookieName, value: expiredCleanupUi.cookies[0], url: BASE_URL}]);
	await page.goto("./");
	await page.click("#apiKeyManageLink");

	const bar = page.locator("#apiKeyExpiredBar");
	await expect(bar).toBeVisible();
	await expect(bar).toContainText("期限切れのキー: 2 本");
	await expect(page.locator("#apiKeyList li")).toHaveCount(3);
	await expect(page.locator("#apiKeyList .apiKeyExpiredBadge").first()).toHaveText("期限切れ");

	await page.click("#apiKeyDeleteExpiredButton");
	// 確認に、消すキーの名前を並べる
	await expect(page.locator("#confirmOverlay")).toBeVisible();
	await expect(page.locator("#confirmOverlay")).toContainText("expired-a-of-expiredCleanupUi");
	await expect(page.locator("#confirmOverlay")).toContainText("期限内のキーは残ります");
	await page.click("#confirmYesButton");

	await expect(page.locator("#apiKeyList li")).toHaveCount(1);
	await expect(page.locator("#apiKeyList li")).not.toContainText("期限切れ");
	await expect(bar).toBeHidden();
});
