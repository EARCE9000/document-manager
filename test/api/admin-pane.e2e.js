/*!
 * admin-pane.e2e.js : 管理ペイン(ページ切替+タブ)のE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * これまでモーダルだったアクセス許可ユーザー管理を、タブを持つページへ移した
 * (docs/admin-screen.md 参照)。ペインの出し入れと、移設した機能がそのまま動くことを確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const TEST_EMAIL = `e2e-admin-${Date.now()}@example.com`;

test.describe.serial("管理ペイン(実ブラウザ)", () => {
	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});

	test("管理ボタンでページが切り替わり、文書一覧は隠れる", async ({page}) => {
		await expect(page.locator("#adminPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();

		await page.click("#allowedUsersManageLink");

		await expect(page.locator("#adminPane")).toBeVisible();
		// モーダルではなくページなので、文書一覧とプレビューは隠れる
		await expect(page.locator("#sideBar")).toBeHidden();
		await expect(page.locator("#previewArea")).toBeHidden();
		await expect(page.locator("#adminPaneHeaderRow h2")).toHaveText("管理");
	});

	test("戻るボタンで文書一覧へ戻れる", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await expect(page.locator("#adminPane")).toBeVisible();

		await page.click("#adminBackButton");

		await expect(page.locator("#adminPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();
	});

	test("タブが表示され、選択中のタブの内容だけが出る", async ({page}) => {
		await page.click("#allowedUsersManageLink");

		const tabs = page.locator(".adminTab");
		await expect(tabs).toHaveCount(1); // 第一弾はアクセス許可ユーザーのみ
		await expect(tabs.first()).toHaveText("アクセス許可ユーザー");
		await expect(tabs.first()).toHaveClass(/active/);

		const panels = page.locator(".adminTabPanel");
		await expect(panels.filter({has: page.locator("#allowedUserTable")})).toBeVisible();
	});

	test("移設したアクセス許可ユーザーの追加・ロール変更・削除がそのまま動く", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await expect(page.locator("#allowedUserTable")).toBeVisible();

		await test.step("追加できる", async () => {
			await page.fill("#allowedUserEmailInput", TEST_EMAIL);
			await page.selectOption("#allowedUserRoleInput", "readonly");
			await page.click("#allowedUserAddButton");
			await expect(page.locator("#allowedUserList", {hasText: TEST_EMAIL})).toBeVisible();
			// 入力欄は空に戻る
			await expect(page.locator("#allowedUserEmailInput")).toHaveValue("");
		});

		const row = page.locator("#allowedUserList tr", {hasText: TEST_EMAIL});

		await test.step("ロールを変更できる", async () => {
			await row.locator("select.allowedUserRoleSelect").selectOption("readwrite");
			// 一覧は再読み込みされる。変更後の値が残っていることを確認する
			await expect(page.locator("#allowedUserList tr", {hasText: TEST_EMAIL}).locator("select")).toHaveValue("readwrite");
		});

		await test.step("削除は確認ダイアログを経てから実行される", async () => {
			await row.locator("button.allowedUserRemoveButton").click();
			// 確認ダイアログは管理ペインの上に出る(モーダルの入れ子ではなくなった)
			await expect(page.locator("#confirmOverlay")).toBeVisible();
			await page.click("#confirmYesButton");
			await expect(page.locator("#allowedUserList tr", {hasText: TEST_EMAIL})).toHaveCount(0);
		});
	});
});
