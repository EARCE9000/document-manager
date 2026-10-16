/*!
 * miro-project.e2e.js : プロジェクトの画面の「Miro と連動」(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクトを開いて「Miro と連動」を押すと、資料がボード(Miro の代わり)に並び、状態と資料ごとの
 * 出す/出さないが画面に出る。連動をやめるところまでを画面から通す。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");
const {CLIENT_ID, CLIENT_SECRET} = require("./miro-stub.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const STUB_URL = `http://127.0.0.1:${process.env.MIRO_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 20}`;
const STAMP = Date.now();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

const upload = async (request, name, buffer) => {
	const res = await request.post("api/documents", {headers: rw, multipart: {uploadfile: {name, mimeType: "application/octet-stream", buffer}}});
	expect(res.status()).toBe(200);
	return res.json();
};

test.describe.serial("プロジェクトの Miro 連動(実ブラウザ)", () => {
	let projectId;

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await request.post(`${STUB_URL}/__control`, {data: {reset: true}});
		await request.put("api/miro/credentials", {headers: admin, data: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET}});
		const start = await request.get("api/miro/connect", {headers: admin, maxRedirects: 0});
		const back = await request.get(start.headers().location, {maxRedirects: 0});
		await request.get(back.headers().location, {headers: admin, maxRedirects: 0});
		await request.put("api/miro/settings", {headers: admin, data: {boardId: "uXjVStubBoard1="}});

		const project = await (await request.post("api/projects", {headers: rw, data: {name: `画面からMiro${STAMP}`}})).json();
		projectId = project.id;
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		for (const name of [`要件${STAMP}.pdf`, `計画${STAMP}.pdf`]) {
			const doc = await upload(request, name, PDF);
			await request.put(`api/projects/${projectId}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});
		}
		const text = await upload(request, `メモ${STAMP}.txt`, Buffer.from("テキスト"));
		await request.put(`api/projects/${projectId}/documents/${text.id}`, {headers: rw, data: {folderId: null}});
	});

	test.afterAll(async ({request}) => {
		await request.delete(`api/projects/${projectId}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("連動すると資料がボードに並び、状態と出せない理由が出る", async ({page}) => {
		await page.goto(`./?project=${projectId}`);
		const button = page.locator("#projectMiroButton");
		await expect(button).toBeVisible();
		await expect(button).toBeEnabled();
		await button.click();
		const overlay = page.locator("#miroProjectOverlay");
		await expect(overlay).toBeVisible();
		await expect(page.locator("#miroProjectTitle")).toContainText(`画面からMiro${STAMP}`);
		await expect(page.locator("#miroProjectStatus")).toContainText("未連動");

		await overlay.locator('button[data-miro-action="link"]').click();
		await expect(page.locator("#miroProjectStatus")).toContainText("連動中", {timeout: 15000});
		await expect(page.locator("#miroProjectStatus")).toContainText("出ている 2 件");
		// 枠を Miro で開くリンク
		await expect(overlay.locator("a", {hasText: "Miro で開く"})).toHaveAttribute("href", /moveToWidget=/);
		// 資料ごとの状態。出せないものは理由つき
		const rows = overlay.locator(".miroItemTable tbody tr");
		await expect(rows).toHaveCount(3);
		await expect(rows.filter({hasText: `メモ${STAMP}.txt`})).toContainText("出せない");
		await expect(rows.filter({hasText: `メモ${STAMP}.txt`})).toContainText("出せない形式");
		await expect(rows.filter({hasText: `要件${STAMP}.pdf`}).locator(".miroState")).toHaveText("出ている");
	});

	test("資料ごとに「出さない」にでき、もう一度「出す」にもできる", async ({page}) => {
		await page.goto(`./?project=${projectId}`);
		await page.locator("#projectMiroButton").click();
		const row = page.locator(".miroItemTable tbody tr", {hasText: `計画${STAMP}.pdf`});
		await row.locator('button[data-miro-publish="false"]').click();
		await expect(row.locator(".miroState")).toHaveText("出さない", {timeout: 15000});
		await row.locator('button[data-miro-publish="true"]').click();
		await expect(row.locator(".miroState")).toHaveText("出ている", {timeout: 15000});
	});

	test("連動をやめると「止めています」になり、ボードの資料を残すか選べる", async ({page, request}) => {
		await page.goto(`./?project=${projectId}`);
		await page.locator("#projectMiroButton").click();
		await page.locator('button[data-miro-action="unlink"]').click();
		await page.locator("#confirmYesButton").click();
		// 2つ目の確認: 資料も消すか → いいえ(残す)
		await expect(page.locator("#confirmMessage")).toContainText("資料も消しますか");
		await page.locator("#confirmNoButton").click();
		await expect(page.locator("#miroProjectStatus")).toContainText("止めています");
		const items = await (await request.get(`${STUB_URL}/__items`)).json();
		expect(items.filter((i) => i.type === "document").length, "資料を残していない").toBeGreaterThan(0);
	});

	test("閲覧だけの権限では、状態は見られるが操作のボタンは出ない", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const response = await route.fetch();
			await route.fulfill({response, json: {...(await response.json()), role: "readonly", isAdmin: false}});
		});
		await page.goto(`./?project=${projectId}`);
		await page.locator("#projectMiroButton").click();
		await expect(page.locator("#miroProjectStatus")).toContainText("止めています");
		await expect(page.locator('button[data-miro-action]')).toHaveCount(0);
		await expect(page.locator("button[data-miro-publish]")).toHaveCount(0);
	});

	test("Miro 連携が無い環境では、ボタンを出さない", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const response = await route.fetch();
			await route.fulfill({response, json: {...(await response.json()), miroEnabled: false}});
		});
		await page.goto(`./?project=${projectId}`);
		await expect(page.locator("#projectCopyLinkButton")).toBeVisible();
		await expect(page.locator("#projectMiroButton")).toBeHidden();
	});
});
