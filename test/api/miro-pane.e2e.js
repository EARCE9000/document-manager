/*!
 * miro-project.e2e.js : 上のメニューの「Miro」の画面(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * メニューの「Miro」を開くと、目印を置く欄・ボードの目印の一覧・書き出しの履歴(全プロジェクト分)が出る。
 * 画面から目印の付箋をボード(Miro の代わり)に置き、API で書き出したものが履歴に出るところまでを通す。
 * 書き出しそのものは Claude Code などから頼むもので、画面には書き出すボタンを置かない。
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

test.describe.serial("Miro の画面(実ブラウザ)", () => {
	let projectId;
	const docs = [];

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
		for (const name of [`要件${STAMP}.pdf`, `計画${STAMP}.pdf`, `メモ${STAMP}.txt`]) {
			const doc = await upload(request, name, name.endsWith(".txt") ? Buffer.from("テキスト") : PDF);
			await request.put(`api/projects/${projectId}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});
			docs.push(doc);
		}
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("目印の付箋を画面から置くと、ボードに [DM]名前・向き・メモの付箋ができ、目印の一覧に出る", async ({page}) => {
		await page.goto("./");
		const menu = page.locator("#menuMiroLink");
		await expect(menu).toBeVisible();
		await menu.click();
		const overlay = page.locator("#miroPane");
		await expect(overlay).toBeVisible();
		await expect(page.locator("#miroAnchorList")).toContainText("ボードに目印がありません");
		// プロジェクトの画面には Miro のボタンを置かない
		await expect(page.locator("#projectMiroButton")).toHaveCount(0);
		// 書き出すボタンは画面に置かない(Claude Code などから頼む)
		await expect(overlay.locator("button", {hasText: "書き出す"})).toHaveCount(0);
		await expect(overlay.locator(".miroHowTo")).toContainText("Claude Code");

		// 向きの既定は右
		await expect(page.locator('input[name="miroAnchorDirection"]:checked')).toHaveValue("right");
		// 向きは図で選ぶ: 付箋(真ん中)のまわりに 8 つの置き場所。選んだ向きはフレームの形と中の並びまで描く
		const preview = page.locator("#miroDirectionPreview");
		await expect(preview.locator(".slot")).toHaveCount(8);
		await expect(preview.locator(".slot.selected")).toHaveAttribute("data-direction", "right");
		await expect(page.locator("#miroDirectionNote")).toContainText("付箋の右に");
		await page.locator("#miroAnchorName").fill("定例");
		await preview.locator('[data-direction="lower-left"]').click();
		await expect(preview.locator(".slot.selected")).toHaveAttribute("data-direction", "lower-left");
		await expect(preview.locator(".slot.selected .card")).toHaveCount(9);
		await expect(preview.locator(".sticky")).toContainText("[DM]");
		await expect(page.locator('input[name="miroAnchorDirection"]:checked')).toHaveValue("lower-left");
		await page.locator("#miroAnchorNote").fill("議事録の最新");
		await page.locator("#miroAnchorPlaceButton").click();
		await expect(page.locator("#miroAnchorPlaced")).toContainText("[DM]定例");
		await expect(page.locator("#miroAnchorPlaced a")).toHaveAttribute("href", /moveToWidget=/);
		const items = await (await page.request.get(`${STUB_URL}/__items`)).json();
		expect(items.find((i) => i.type === "sticky_note").data.content).toBe("<p>[DM]定例</p><p>(左下)</p><p>議事録の最新</p>");
		const row = page.locator("#miroAnchorList tr", {hasText: "定例"});
		await expect(row).toContainText("左下");
		await expect(row).toContainText("議事録の最新");
		await expect(row.locator("a")).toHaveAttribute("href", /moveToWidget=/);
		await expect(page.locator("#miroAnchorName")).toHaveValue("");
	});

	test("書き出すと(Claude Code などから API で)、履歴にフレームへのリンクと件数が出る", async ({page, request}) => {
		const res = await request.post("api/miro/exports", {headers: rw, data: {anchor: "定例", project: projectId}});
		expect(res.status()).toBe(202);
		const started = await res.json();
		await expect.poll(async () => (await (await request.get(`api/miro/exports/${started.id}`, {headers: rw})).json()).state).toBe("done");
		await page.goto("./");
		await page.locator("#menuMiroLink").click();
		const row = page.locator("#miroExportList tbody tr").first();
		await expect(row).toContainText("[DM]定例");
		await expect(row).toContainText(`画面からMiro${STAMP}`);
		await expect(row).toContainText("出した 2 件・出せない 1 件");
		await expect(row.locator(".frames a")).toContainText(/^定例 \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\(左下\)$/);
		await expect(row.locator(".frames a")).toHaveAttribute("href", /moveToWidget=/);
		await expect(page.locator("#miroAnchorList tr", {hasText: "定例"})).not.toContainText("右(書いていない)");
	});

	test("閲覧だけの権限では、目印と履歴は見られるが、目印は置けない", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const response = await route.fetch();
			await route.fulfill({response, json: {...(await response.json()), role: "readonly", isAdmin: false}});
		});
		await page.goto("./");
		await page.locator("#menuMiroLink").click();
		await expect(page.locator("#miroExportList tbody tr").first()).toContainText("[DM]定例");
		await expect(page.locator("#miroAnchorList")).toContainText("定例");
		await expect(page.locator("#miroAnchorSection")).toBeHidden();
	});

	test("Miro 連携が無い環境では、メニューに出さない", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const response = await route.fetch();
			await route.fulfill({response, json: {...(await response.json()), miroEnabled: false}});
		});
		await page.goto("./");
		await expect(page.locator("#menuToolsLink")).toBeVisible();
		await expect(page.locator("#menuMiroLink")).toBeHidden();
	});
});
