/*!
 * database-vacuum.e2e.js : DB のファイルを詰める(VACUUM)とメンテナンス中の画面(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 管理の画面の「サーバー」のタブの設定に「ファイルを詰める(VACUUM)」の節が出て、確認のモーダルの後に詰め始め、
 * メンテナンス中の画面(閉じるボタンなし)で覆い、終わったら読み直して結果を出すことを確かめる。
 * 文書一覧の画面は、開いたときの最初の確かめが 503 maintenance なら、ログインへ送らずにメンテナンス中の画面を出し、
 * 終われば読み直すことを確かめる(こちらは応答を差し替えて作る)。
 * API の形と、誰が始められるかは database-vacuum.spec.js、詰めること自体は test/vacuum.test.js。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

test.describe.serial("VACUUM とメンテナンス中の画面", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("管理の画面から詰めると、メンテナンス中の画面になり、終わると読み直して結果を出す", async ({page}) => {
		await page.goto("./admin.html?tab=server");
		const section = page.locator(".admin_server [data-part=vacuum]");
		await expect(section).toBeVisible();
		await expect(section.locator(".panel_section_title")).toContainText("ファイルを詰める(VACUUM)");
		await expect(section).toContainText("ファイルの大きさ");
		await expect(section).toContainText("空いている所(詰めると減る分)");
		// API の回数の上限の下、機能の On/Off の上に並ぶ
		const titles = await page.locator(".admin_server .panel_section_title").allTextContents();
		const at = (text) => titles.findIndex((t) => t.includes(text));
		expect(at("API の回数の上限")).toBeLessThan(at("ファイルを詰める"));
		expect(at("ファイルを詰める")).toBeLessThan(at("機能の On/Off"));

		await section.getByRole("button", {name: /VACUUM/}).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("メンテナンス中");
		await dialog.getByRole("button", {name: "実行"}).click();

		const overlay = page.locator("#maintenanceOverlay");
		await expect(overlay).toBeVisible();
		await expect(overlay).toContainText("データベースのメンテナンス中です");
		await expect(overlay).toContainText("完了すると自動で画面を読み直します。");
		await expect(overlay.getByRole("button")).toHaveCount(0);

		// 終わると読み直し、結果を出す(小さなファイルなので、すぐ終わる)
		await expect(page.locator(".admin_server [data-part=vacuum] .msg_success")).toContainText("ファイルを詰めた", {timeout: 15000});
		await expect(page.locator("#maintenanceOverlay")).toHaveCount(0);
		await expect(page.locator(".admin_server [data-part=vacuum]")).toContainText("前回は成功");
		// ログインはそのまま(セッションも同じファイルにあるが、中身は残る)
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});

	test("文書一覧は、開いたときにメンテナンス中ならログインへ送らずに覆い、終われば読み直す", async ({page}) => {
		let maintenance = true;
		await page.route("**/api/check_access_token", (route) => (maintenance
			? route.fulfill({status: 503, contentType: "application/json", headers: {"Retry-After": "30"},
				body: JSON.stringify({error: "メンテナンス中です", code: "maintenance"})})
			: route.continue()));
		await page.route("**/api/maintenance", (route) => route.fulfill({status: 200, contentType: "application/json",
			body: JSON.stringify({maintenance, reason: maintenance ? "vacuum" : null, startedAt: maintenance ? new Date().toISOString() : null})}));

		await page.goto("./");
		await expect(page.locator("#maintenanceOverlay")).toBeVisible();
		await expect(page).not.toHaveURL(/\/login/);
		// 終わったら、読み直してふつうの画面になる
		maintenance = false;
		await expect(page.locator("#uploadDropZone")).toBeVisible({timeout: 15000});
		await expect(page.locator("#maintenanceOverlay")).toHaveCount(0);
	});
});
