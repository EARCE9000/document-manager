/*!
 * project-manifest.e2e.js : お品書きの画面を実ブラウザ(Chromium)で検証するE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクト名を押す → お品書きが出る → 資料に説明を書く → 残る、までを通す。
 * 説明はプレビューと同じ場所に出すため、文書を選ぶと引っ込むことも確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const PROJECT = `お品書きE2E ${STAMP}`;
const COVER = `e2e-cover-${STAMP}.txt`;
const SPEC = `e2e-spec-${STAMP}.txt`;

test.use({permissions: ["clipboard-read", "clipboard-write"]});

test.describe.serial("お品書き(実ブラウザ)", () => {
	let projectId;

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: PROJECT}})).json()).id;
		const folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件"}})).json()).id;

		const upload = async (name, body) => (await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body)}}
		})).json()).id;

		const coverId = await upload(COVER, "表紙の本文");
		const specId = await upload(SPEC, "要件定義の本文");
		await request.put(`api/projects/${projectId}/documents/${coverId}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${projectId}/documents/${specId}`, {headers: rw, data: {folderId}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	const openProject = async (page) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreeTitle")).toHaveText(PROJECT);
	};

	test("プロジェクト名を押すとお品書きが出る", async ({page}) => {
		await openProject(page);
		await expect(page.locator("#manifestPane")).toBeHidden();

		await page.click("#projectTreeTitle");
		await expect(page.locator("#manifestPane")).toBeVisible();
		await expect(page.locator("#manifestTitle")).toHaveText(`${PROJECT} お品書き`);
		await expect(page.locator("#manifestSummary")).toHaveText("資料 2 件");

		// 直下の資料が先、そのあとフォルダの章
		await expect(page.locator(".manifestItemName").first()).toContainText(COVER);
		await expect(page.locator(".manifestFolderName")).toHaveText("要件");
		await expect(page.locator(".manifestFolder .manifestItemName")).toContainText(SPEC);

		// ツリーは左に残っている(見ながら書けること)
		await expect(page.locator("#projectTreePane")).toBeVisible();

		// もう一度押すと閉じる
		await page.click("#projectTreeTitle");
		await expect(page.locator("#manifestPane")).toBeHidden();
	});

	test("資料に説明を書くと残る", async ({page}) => {
		await openProject(page);
		await page.click("#projectTreeTitle");

		const row = page.locator(".manifestItem", {hasText: SPEC});
		await expect(row.locator(".manifestNote")).toHaveClass(/empty/);
		await row.locator(".manifestNote").click();
		await page.locator(".manifestNoteEditor textarea").fill("3章が今回の変更点です。");
		await page.keyboard.press("Control+Enter");

		await expect(page.locator(".manifestItem", {hasText: SPEC}).locator(".manifestNote"))
			.toHaveText("3章が今回の変更点です。");

		// 読み込み直しても残る(画面上だけの変更になっていないこと)
		await openProject(page);
		await page.click("#projectTreeTitle");
		await expect(page.locator(".manifestItem", {hasText: SPEC}).locator(".manifestNote"))
			.toHaveText("3章が今回の変更点です。");
	});

	test("フォルダにも説明を書ける(章の前書きになる)", async ({page}) => {
		await openProject(page);
		await page.click("#projectTreeTitle");

		await page.locator(".manifestFolder > .manifestNote").click();
		await page.locator(".manifestNoteEditor textarea").fill("この案件で合意した範囲です。");
		await page.keyboard.press("Control+Enter");
		await expect(page.locator(".manifestFolder > .manifestNote")).toHaveText("この案件で合意した範囲です。");
	});

	test("Escでやめると書きかけは反映されない", async ({page}) => {
		await openProject(page);
		await page.click("#projectTreeTitle");

		const note = page.locator(".manifestItem", {hasText: SPEC}).locator(".manifestNote");
		await note.click();
		await page.locator(".manifestNoteEditor textarea").fill("書きかけの文章");
		await page.keyboard.press("Escape");
		await expect(page.locator(".manifestItem", {hasText: SPEC}).locator(".manifestNote"))
			.toHaveText("3章が今回の変更点です。");
	});

	test("資料名を押すとその文書のプレビューに切り替わる", async ({page}) => {
		await openProject(page);
		await page.click("#projectTreeTitle");

		await page.locator(`.manifestItemName .openLink:has-text("${COVER}")`).click();
		await expect(page.locator("#manifestPane")).toBeHidden();
		await expect(page.locator("#previewTitle")).toHaveText(COVER);
	});

	test("Markdownをコピーできる", async ({page}) => {
		await openProject(page);
		await page.click("#projectTreeTitle");
		await page.click("#manifestCopyButton");
		await expect(page.locator("#manifestCopyButton")).toHaveText("コピーしました");

		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toContain(`# ${PROJECT} お品書き`);
		expect(copied).toContain("## 要件");
		expect(copied).toContain("3章が今回の変更点です。");
	});
});
