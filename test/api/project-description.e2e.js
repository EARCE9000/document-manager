/*!
 * project-description.e2e.js : プロジェクトの名前と説明の入力(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクトを作るときと、鉛筆(名前・説明を変更)で、名前と説明(複数行・空でもよい)を入れられる。
 * 説明は Miro に十字で書き出したときの、目印の下の概要カードに出す。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const NAME = `説明の画面${Date.now()}`;

test.describe.serial("プロジェクトの名前と説明(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("作るときに名前と説明を入れられる。名前が空なら OK を押せない", async ({page, request}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click("#projectAddButton");
		await expect(page.locator("#projectEditOverlay")).toBeVisible();
		await expect(page.locator("#projectEditOkButton")).toBeDisabled();
		await page.fill("#projectEditName", NAME);
		await page.fill("#projectEditDescription", "受注管理の再構築\n2026 年度");
		await page.click("#projectEditOkButton");
		await expect(page.locator("#projectEditOverlay")).toBeHidden();
		await expect(page.locator(`.projectTab:has-text("${NAME}")`)).toBeVisible();
		const project = (await (await request.get("api/projects", {headers: rw})).json()).find((p) => p.name === NAME);
		expect(project.description).toBe("受注管理の再構築\n2026 年度");
	});

	test("鉛筆で名前と説明を変えられ、説明を空にすると消える", async ({page, request}) => {
		const project = (await (await request.get("api/projects", {headers: rw})).json()).find((p) => p.name === NAME);
		await request.post(`api/projects/${project.id}/unlock`, {headers: rw});
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${NAME}")`);
		await page.click("#projectEditToggleButton");
		await page.click("#projectRenameButton");
		await expect(page.locator("#projectEditName")).toHaveValue(NAME);
		await expect(page.locator("#projectEditDescription")).toHaveValue("受注管理の再構築\n2026 年度");
		await page.fill("#projectEditDescription", "説明を変えた");
		await page.click("#projectEditOkButton");
		await expect.poll(async () => (await (await request.get("api/projects", {headers: rw})).json()).find((p) => p.id === project.id).description).toBe("説明を変えた");
		await page.click("#projectRenameButton");
		await page.fill("#projectEditDescription", "");
		await page.click("#projectEditOkButton");
		await expect.poll(async () => (await (await request.get("api/projects", {headers: rw})).json()).find((p) => p.id === project.id).description).toBeNull();
		// キャンセルでは変わらない
		await page.click("#projectRenameButton");
		await page.fill("#projectEditName", "変えない名前");
		await page.click("#projectEditCancelButton");
		expect((await (await request.get("api/projects", {headers: rw})).json()).find((p) => p.id === project.id).name).toBe(NAME);
	});
});
