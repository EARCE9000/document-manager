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

	// 案件が大きくなると全体のお品書きは長い。「この章だけ」を見たい/渡したいことがある
	test("フォルダを押すと、開閉すると同時にその章のお品書きが出る", async ({page}) => {
		await openProject(page);
		const folderRow = page.locator(".treeFolderRow", {hasText: "要件"});
		await expect(folderRow).toBeVisible();

		await folderRow.click();
		await expect(page.locator("#manifestPane")).toBeVisible();
		await expect(page.locator("#manifestTitle")).toHaveText(`${PROJECT} › 要件 お品書き`);
		// その章の資料だけが並ぶ(プロジェクト直下の表紙は出ない)
		await expect(page.locator(".manifestItem")).toHaveCount(1);
		await expect(page.locator(".manifestItem")).toContainText(SPEC);
		// いま見ている章が、ツリー側でも分かる
		await expect(folderRow).toHaveClass(/manifestOpen/);
		// 同時に開閉もしている(1回押したので閉じている)
		await expect(page.locator(".treeFolderRow", {hasText: "要件"}).locator(".treeToggleIcon")).toHaveText("▶");

		// 全体へ戻れる
		await page.click("#manifestWholeLink");
		await expect(page.locator("#manifestTitle")).toHaveText(`${PROJECT} お品書き`);
		await expect(page.locator(".manifestItem")).toHaveCount(2);
	});

	test("章の前書きも、その場で書ける", async ({page}) => {
		await openProject(page);
		await page.locator(".treeFolderRow", {hasText: "要件"}).click();
		await expect(page.locator("#manifestPane")).toBeVisible();

		await page.locator("#manifestBody > .manifestNote").first().click();
		await page.locator(".manifestNoteEditor textarea").fill("この章だけ先に見てください。");
		await page.keyboard.press("Control+Enter");
		await expect(page.locator("#manifestBody > .manifestNote").first()).toHaveText("この章だけ先に見てください。");
	});

	// お品書きではフォルダがそのまま章の順番になる
	test("フォルダを上下に動かすと、お品書きの章の順番が変わる", async ({page, request}) => {
		const projects = await (await request.get("api/projects", {headers: rw})).json();
		const target = projects.find((p) => p.name === PROJECT);
		await request.post(`api/projects/${target.id}/folders`, {headers: rw, data: {name: "参考"}});

		await openProject(page);
		await page.click("#projectTreeTitle");
		const chapters = page.locator("#manifestBody > .manifestFolder > .manifestFolderName");
		// allTextContents は自動待機しないので、描画を待ってから読む
		await expect(chapters).toHaveCount(2);
		const chapterNames = () => chapters.allTextContents();
		expect(await chapterNames()).toEqual(["要件", "参考"]);

		// 「参考」を上へ
		await page.locator(".treeFolderRow", {hasText: "参考"}).locator(".treeFolderUpButton").click();
		await expect(page.locator("#manifestBody > .manifestFolder > .manifestFolderName").first()).toHaveText("参考");
		expect(await chapterNames()).toEqual(["参考", "要件"]);

		// 先頭では上へ押せない(端で押しても何も起きない、が分かるように無効化する)
		await expect(page.locator(".treeFolderRow", {hasText: "参考"}).locator(".treeFolderUpButton")).toBeDisabled();
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
