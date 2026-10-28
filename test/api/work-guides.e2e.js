/*!
 * work-guides.e2e.js : 管理の画面「作業の手引き」のタブ(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * - 見本を入れて書き換え、保存できる(AI が読む WebAPI にそのまま出る)
 * - 保存の前にリンクを確かめ、見つからないリンクがあれば保存してよいか聞く
 * - AI に下書きを作らせる依頼文を、選んでいる置き場所に合わせて出す
 * WebAPI の決まり(だれが書けるか・新しい版を追いかけるか など)は work-guides.spec.js
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const admin = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(keys.sessionCookie)}`};
const panel = (page) => page.locator("#tab_guides + .tab_label + .tab_panel");

test.describe.serial("作業の手引き(管理の画面)", () => {
	let alias;
	let entryFile;

	test.beforeAll(async ({request}) => {
		const doc = await (await request.post("api/documents", {headers: rw, multipart: {
			uploadfile: {name: `テスト方針-${Date.now()}.md`, mimeType: "text/markdown", buffer: Buffer.from("# テスト方針")}
		}})).json();
		entryFile = doc.entryFile;
		alias = (await (await request.post(`api/documents/${doc.id}/alias`, {headers: rw})).json()).alias;
		await request.put("api/admin/work-guides/global", {headers: admin, data: {markdown: ""}});
	});

	test.afterAll(async ({request}) => {
		await request.put("api/admin/work-guides/global", {headers: admin, data: {markdown: ""}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("見本を入れられ、見本のままのリンクは「見つからない」と出る", async ({page}) => {
		await page.goto("./admin.html?tab=guides");
		const tab = panel(page);
		await expect(tab.locator("#guideScopeSelect")).toHaveValue("global");
		await expect(tab.locator("#guideMeta")).toContainText("まだ書いていない");
		await expect(tab.locator("#guideEditor")).toHaveValue("");

		await tab.locator("#guideSampleLink").click();
		await expect(tab.locator("#guideEditor")).toHaveValue(/## サービスフローを作るとき/);
		await expect(tab.locator("#guideCount")).toContainText("保存していない変更がある");

		await tab.locator("#guideCheckButton").click();
		await expect(tab.locator("#guideLinkResult")).toContainText("確かめる物");
		await expect(tab.locator("#guideLinkResult")).toContainText("見つからない");

		// 見つからないリンクのまま保存しようとすると止まる(やめれば保存されない)
		await tab.locator("#guideSaveButton").click();
		await expect(page.locator(".modal_box")).toContainText("見つからないリンクがある");
		await page.locator("[data-ans=no]").click();
		await expect(tab.locator("#guideMeta")).toContainText("まだ書いていない");
	});

	test("書き換えて保存すると、AI が読む WebAPI に出る。依頼文は置き場所に合わせて出る", async ({page, request}) => {
		await page.goto("./admin.html?tab=guides");
		const tab = panel(page);
		await expect(tab.locator("#guidePrompt")).toContainText("全体共通");
		await expect(tab.locator("#guidePrompt")).toContainText("share-url");

		const markdown = `## テストコードを作るとき\n- 工程と作るもの: [テスト方針](${BASE_URL}/api/documents/alias/${alias}/viewer)\n`;
		await tab.locator("#guideEditor").fill(markdown);
		await tab.locator("#guideSaveButton").click();
		await expect(tab.locator("#guideFlash")).toContainText("保存した");
		await expect(tab.locator("#guideLinkResult")).toContainText("すべて見つかった");
		await expect(tab.locator("#guideLinkResult")).toContainText(entryFile);
		await expect(tab.locator("#guideScopeSelect option[value=global]")).toContainText("書いてある");
		await expect(tab.locator("#guideMeta")).toContainText(keys.owner);

		const body = await (await request.get("api/work-guides", {headers: {Authorization: `Bearer ${keys.readonly}`}})).json();
		expect(body.global.markdown).toBe(markdown);
	});

	test("保存していない変更があるまま置き場所を変えようとすると、確かめる", async ({page, request}) => {
		const project = await (await request.post("api/projects", {headers: rw, data: {name: `手引きの画面 ${Date.now()}`}})).json();
		try {
			await page.goto("./admin.html?tab=guides");
			const tab = panel(page);
			await expect(tab.locator("#guideEditor")).not.toHaveValue("");
			await tab.locator("#guideEditor").fill("書きかけ");
			await tab.locator("#guideScopeSelect").selectOption(project.id);
			await expect(page.locator(".modal_box")).toContainText("保存していない変更");
			await page.locator("[data-ans=no]").click();
			await expect(tab.locator("#guideScopeSelect")).toHaveValue("global");
			await expect(tab.locator("#guideEditor")).toHaveValue("書きかけ");

			await tab.locator("#guideScopeSelect").selectOption(project.id);
			await page.locator("[data-ans=yes]").click();
			await expect(tab.locator("#guideMeta")).toContainText(`プロジェクト「${project.name}」`);
			await expect(tab.locator("#guidePrompt")).toContainText(`プロジェクト「${project.name}」`);
		} finally {
			await request.delete(`api/projects/${project.id}`, {headers: rw});
		}
	});
});
