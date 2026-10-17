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

	test("レイアウトを選んで連動すると資料がボードに並び、状態が出る", async ({page}) => {
		await page.goto(`./?project=${projectId}`);
		const button = page.locator("#projectMiroButton");
		await expect(button).toBeVisible();
		await expect(button).toBeEnabled();
		await button.click();
		const overlay = page.locator("#miroProjectOverlay");
		await expect(overlay).toBeVisible();
		await expect(page.locator("#miroProjectTitle")).toContainText(`画面からMiro${STAMP}`);
		await expect(page.locator("#miroProjectStatus")).toContainText("未連動");

		// レイアウトを、見本の図のタイル(3 列 × 2 行。6 つ目はユーザーカスタム)で選んでから連動する(既定はフォルダ列)
		const chosen = page.locator('#miroLayoutTiles input[name="miroLayout"]:checked');
		await expect(chosen).toHaveValue("folder-columns");
		await expect(page.locator("#miroLayoutTiles .miroLayoutTile")).toHaveCount(6);
		await expect(page.locator("#miroLayoutTiles .miroLayoutTile").last()).toContainText("ユーザーカスタム");
		const cross = page.locator(".miroLayoutTile", {hasText: "十字"});
		await expect(cross.locator("img")).toHaveAttribute("src", /layout-preview\/quadrant-cross/);
		expect(await cross.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0), "見本の図が読み込めていない").toBe(true);
		await cross.click();
		await expect(cross).toHaveClass(/selected/);
		await expect(cross).toContainText("左上 要件定義〜設計");
		await expect(page.locator("#miroLayoutChosen")).toHaveText("十字");
		await overlay.locator('button[data-miro-action="link"]').click();
		await expect(page.locator("#miroProjectStatus")).toContainText("連動中", {timeout: 15000});
		await expect(page.locator("#miroProjectStatus")).toContainText("出ている 2 件");
		// 枠を Miro で開くリンク
		await expect(overlay.locator("a", {hasText: "Miro で開く"})).toHaveAttribute("href", /moveToWidget=/);
		await expect(page.locator("#miroProjectStatus")).toContainText("出せない/失敗 1 件");
		// 資料ごとの一覧・今すぐ反映は画面に出さない(AI から CLI で扱う)
		await expect(overlay.locator('button[data-miro-action="sync"]')).toHaveCount(0);
		await expect(chosen).toHaveValue("quadrant-cross");
		await expect(page.locator(".miroLayoutTile.current")).toContainText("十字");
		// いまのレイアウトを選んでいるあいだは「このレイアウトにする」は押せない
		await expect(page.locator("#miroArrangeButton")).toBeDisabled();
		// 区画の見出しがボードに置かれている
		const items = await (await page.request.get(`${STUB_URL}/__items`)).json();
		expect(items.some((i) => i.type === "text" && String(i.data?.content).includes("右上: 管理系"))).toBe(true);
	});

	test("レイアウトを変え(確かめてから)、元のレイアウトに戻せる", async ({page}) => {
		await page.goto(`./?project=${projectId}`);
		await page.locator("#projectMiroButton").click();
		const chosen = page.locator('#miroLayoutTiles input[name="miroLayout"]:checked');
		await expect(chosen).toHaveValue("quadrant-cross");
		await expect(page.locator("#miroUndoButton")).toHaveCount(0);
		await page.locator(".miroLayoutTile", {hasText: "時系列"}).click();
		await page.locator("#miroArrangeButton").click();
		await expect(page.locator("#confirmMessage")).toContainText("十字 から 時系列 に変えますか");
		await page.locator("#confirmYesButton").click();
		await expect(page.locator("#miroUndoButton")).toContainText("元のレイアウト(十字)に戻す", {timeout: 15000});
		await expect(chosen).toHaveValue("timeline");

		await page.locator("#miroUndoButton").click();
		await expect(page.locator("#confirmMessage")).toContainText("前の配置(十字)に戻しますか");
		await page.locator("#confirmYesButton").click();
		await expect(page.locator("#miroUndoButton")).toHaveCount(0, {timeout: 15000});
		await expect(chosen).toHaveValue("quadrant-cross");
	});

	test("ユーザーカスタムに変えると、資料は動かさずにレイアウトの見出しだけ片付く", async ({page}) => {
		await page.goto(`./?project=${projectId}`);
		await page.locator("#projectMiroButton").click();
		const before = (await (await page.request.get(`${STUB_URL}/__items`)).json()).filter((i) => i.type === "document").map((i) => [i.id, i.position]);
		await page.locator(".miroLayoutTile", {hasText: "ユーザーカスタム"}).click();
		await page.locator("#miroArrangeButton").click();
		await expect(page.locator("#confirmMessage")).toContainText("資料は今の場所のまま動かしません");
		await page.locator("#confirmYesButton").click();
		await expect(page.locator(".miroLayoutTile.current")).toContainText("ユーザーカスタム", {timeout: 15000});
		const items = await (await page.request.get(`${STUB_URL}/__items`)).json();
		for (const [id, position] of before) expect(items.find((i) => i.id === id).position).toMatchObject(position);
		expect(items.some((i) => i.type === "text" && String(i.data?.content).includes("右上: 管理系"))).toBe(false);
		// 元に戻しておく
		await page.locator("#miroUndoButton").click();
		await page.locator("#confirmYesButton").click();
		await expect(page.locator(".miroLayoutTile.current")).toContainText("十字", {timeout: 15000});
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
		await expect(page.locator("#miroProjectLayout")).toContainText("レイアウト: 十字");
		await expect(page.locator(".miroLayoutTile")).toHaveCount(0);
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
