/*!
 * miro-admin.e2e.js : 管理の画面(admin.html)の「Miro 連携」(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 「Miro と連携」→ Miro の許可の画面(代わりのサーバーがすぐ戻す)→ 管理画面へ戻って結果が出る、
 * ボードを選ぶ、解除する、までを画面から通す。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const STUB_URL = `http://127.0.0.1:${process.env.MIRO_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 20}`;
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const {CLIENT_ID, CLIENT_SECRET} = require("./miro-stub.js");

const openMiroTab = async (page) => {
	await page.locator("#allowedUsersManageLink").click();
	await page.locator("label[for=tab_miro]").click();
};
const state = (page) => page.locator("#miroConnectionResult .result_meta .status_badge").first();
const boardRows = (page) => page.locator("#miroBoardList tbody tr");

test.describe.serial("管理画面の Miro 連携(実ブラウザ)", () => {
	test.beforeEach(async ({context, page, request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await request.post(`${STUB_URL}/__control`, {data: {reset: true}});
		await request.put("api/miro/credentials", {headers: admin, data: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET}});
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});
	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("連携していないときは、連携の入口と、Miro のアプリに登録する戻り先が出る", async ({page}) => {
		await openMiroTab(page);
		const panel = page.locator("#miroConnectionResult");
		await expect(state(page)).toHaveText("未連携");
		await expect(page.locator("#miroConnectButton")).toBeVisible();
		await expect(panel.locator(".version_text").first()).toHaveText(`${BASE_URL}/api/miro/callback`);
	});

	test("連携すると管理画面に戻って知らせ、ボードを選べる", async ({page}) => {
		await openMiroTab(page);
		await page.locator("#miroConnectButton").click();
		// 許可の画面から戻ってくると、管理の画面の Miro 連携が開いて結果が出る
		await expect(page.locator("#miroFlash")).toHaveText(/連携した/);
		await expect(page).toHaveURL(/\/admin\.html\?/);
		await expect(page.locator("#tab_miro")).toBeChecked();
		// 結果の印は URL から消えている(再読み込みで同じ知らせを出さない)
		expect(new URL(page.url()).searchParams.has("miro")).toBe(false);

		const panel = page.locator("#miroConnectionResult");
		await expect(state(page)).toHaveText("Connected");
		await expect(panel).toContainText("Dev team");
		await expect(page.locator("#miroBoardName")).toContainText("未選択");

		// 連携したチームのボードだけが候補に出る
		const list = page.locator("#miroBoardList");
		await expect(boardRows(page)).toHaveCount(2);
		await expect(list).not.toContainText("別チームのボード");
		await boardRows(page).filter({hasText: "Document Manager 連携テスト"}).locator("button").click();
		await expect(page.locator("#miroBoardName")).toContainText("Document Manager 連携テスト");
		await expect(boardRows(page).filter({hasText: "Document Manager 連携テスト"}).locator(".status_badge")).toHaveText("貼り先");

		// 名前で絞り込める
		await page.locator("#miroBoardSearchInput").fill("ブレスト");
		await page.locator("#miroBoardSearchButton").click();
		await expect(boardRows(page)).toHaveCount(1);
		await expect(list).toContainText("企画ブレスト");
	});

	test("Miro で許可しなかったときは、理由を出す", async ({page, request}) => {
		await request.post(`${STUB_URL}/__control`, {data: {deny: true}});
		await openMiroTab(page);
		await page.locator("#miroConnectButton").click();
		await expect(page.locator("#miroFlash")).toHaveText(/許可されなかった/);
		await expect(state(page)).toHaveText("未連携");
	});

	test("連携を解除できる(確認を出す)", async ({page}) => {
		await openMiroTab(page);
		await page.locator("#miroConnectButton").click();
		await expect(page.locator("#miroFlash")).toHaveText(/連携した/);
		await page.locator("#miroDisconnectButton").click();
		await expect(page.locator(".modal_box")).toContainText("連携の解除");
		await page.locator("[data-ans=yes]").click();
		await expect(state(page)).toHaveText("未連携");
	});

	test("連携が切れたら、連携し直すよう出す", async ({page, request}) => {
		await openMiroTab(page);
		await page.locator("#miroConnectButton").click();
		await expect(page.locator("#miroFlash")).toHaveText(/連携した/);
		await request.post(`${STUB_URL}/__control`, {data: {expireAccess: true, refreshFails: true}});
		await page.locator("#miroBoardSearchButton").click();
		await expect(state(page)).toHaveText("連携し直しが必要");
		await expect(page.locator("#miroConnectionResult")).toContainText("連携し直");
		await expect(page.locator("#miroReconnectButton")).toBeVisible();
	});

	test("アプリの値が未設定なら、作り方の手順と入力欄が出て、画面から保存できる", async ({page, request}) => {
		await request.delete("api/miro/credentials", {headers: admin});
		await openMiroTab(page);
		const panel = page.locator("#miroConnectionResult");
		await expect(state(page)).toHaveText("Not set");
		// Miro 側で作るときに要る戻り先を、手順の中に出す
		await expect(panel.locator(".admin_steps")).toContainText(`${BASE_URL}/api/miro/callback`);
		await expect(page.locator("#miroClientSecretInput")).toHaveAttribute("type", "password");

		await page.locator("#miroClientIdInput").fill(CLIENT_ID);
		await page.locator("#miroClientSecretInput").fill(CLIENT_SECRET);
		await page.locator("#miroCredentialSaveButton").click();
		await expect(page.locator("#miroFlash")).toHaveText(/保存した/);
		await expect(state(page)).toHaveText("未連携");
		await expect(panel).toContainText("管理の画面で設定済み");
		// シークレットは画面に出さない
		await expect(panel).not.toContainText(CLIENT_SECRET);
		await expect(page.locator("#miroCredentialForm")).toBeHidden();

		// そのまま連携まで進める
		await page.locator("#miroConnectButton").click();
		await expect(page.locator("#miroFlash")).toHaveText(/連携した/);
	});
});
