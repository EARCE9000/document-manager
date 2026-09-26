/*!
 * project-manifest-xss.e2e.js : お品書きに仕込まれた文字列が実行されないことの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * お品書きは、利用者が自由に書いた文字列(説明書き・フォルダ名・プロジェクト名・ファイル名)を
 * そのまま並べて見せる画面である。ここでエスケープを1か所でも落とすと、**書いた人が
 * 見た人のブラウザで好きなことをできる**ようになる。この画面は「人に渡す」ためのもので、
 * 書いた本人以外が開く前提なので、そこが崩れると影響が大きい。
 *
 * ヘッダーやコードを読んでも「実際に実行されないこと」は分からないため、実ブラウザで開いて
 * 仕掛けが動かないことを確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
// 仕掛けが動いたら window.__xss に印が付く。印が付かないことを確かめる
const PAYLOADS = {
	script: `<script>window.__xss="script"</` + `script>`,
	img: `<img src=x onerror='window.__xss="img"'>`,
	svg: `<svg onload='window.__xss="svg"'>`,
	// 属性の外に出る形(data-id などに入る値を想定)
	attr: `" onmouseover="window.__xss='attr'" x="`,
	// 閉じタグを混ぜて周りの構造を壊しにいく形
	breakout: `</div><div id="xssBreakout">割り込み</div><div>`
};

const PROJECT = `XSS検証${STAMP} ${PAYLOADS.img}`;
const FOLDER = `章${STAMP} ${PAYLOADS.svg}`;
const DOC_NOTE = `説明 ${PAYLOADS.script} ${PAYLOADS.breakout}`;
const FOLDER_NOTE = `章の説明 ${PAYLOADS.attr}`;
const DOC_NAME = `xss-${STAMP}.txt`;

test.describe.serial("お品書きに仕込まれた文字列(実ブラウザ)", () => {
	let projectId;

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: PROJECT}})).json()).id;
		const folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: FOLDER}})).json()).id;

		const docId = (await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name: DOC_NAME, mimeType: "text/plain", buffer: Buffer.from("本文")}}
		})).json()).id;

		await request.put(`api/projects/${projectId}/documents/${docId}`, {headers: rw, data: {folderId}});
		await request.put(`api/projects/${projectId}/documents/${docId}/note`, {headers: rw, data: {note: DOC_NOTE}});
		await request.put(`api/projects/${projectId}/folders/${folderId}/note`, {headers: rw, data: {note: FOLDER_NOTE}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("仕掛けは実行されず、文字としてそのまま出る", async ({page}) => {
		const dialogs = [];
		page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });

		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("XSS検証${STAMP}")`);
		await page.click("#projectTreeTitle");
		await expect(page.locator("#manifestPane")).toBeVisible();

		// 画面を触ってからも確かめる(onmouseover のように操作で発火するものがあるため)
		await page.locator(".manifestNote").first().hover();
		await page.locator("#manifestTitle").hover();
		await page.waitForTimeout(300);

		expect(await page.evaluate(() => window.__xss), "仕掛けが実行された").toBeUndefined();
		expect(dialogs, "ダイアログが出た").toEqual([]);

		// 構造が割り込まれていない
		expect(await page.locator("#xssBreakout").count(), "閉じタグで構造に割り込まれた").toBe(0);
		// 仕込んだタグが本物の要素になっていない
		expect(await page.locator("#manifestPane img").count(), "img要素として解釈された").toBe(0);
		expect(await page.locator("#manifestPane svg").count(), "svg要素として解釈された").toBe(0);

		// 文字としては読める(消してしまうのではなく、そのまま見せるのが正しい)
		await expect(page.locator(".manifestItem", {hasText: DOC_NAME}).locator(".manifestNote")).toHaveText(DOC_NOTE);
		await expect(page.locator(".manifestFolder > .manifestNote")).toHaveText(FOLDER_NOTE);
		await expect(page.locator(".manifestFolderName")).toHaveText(FOLDER);
		await expect(page.locator("#manifestTitle")).toHaveText(`${PROJECT} お品書き`);
	});

	test("書き直しても実行されない(編集を経由した経路)", async ({page}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("XSS検証${STAMP}")`);
		await page.click("#projectTreeTitle");

		const note = page.locator(".manifestItem", {hasText: DOC_NAME}).locator(".manifestNote");
		await note.click();
		// 編集欄には元の文字がそのまま入っていること(ここで壊れていると保存で化ける)
		await expect(page.locator(".manifestNoteEditor textarea")).toHaveValue(DOC_NOTE);
		await page.locator(".manifestNoteEditor textarea").fill(`書き直し ${PAYLOADS.img}`);
		await page.keyboard.press("Control+Enter");

		await expect(page.locator(".manifestItem", {hasText: DOC_NAME}).locator(".manifestNote"))
			.toHaveText(`書き直し ${PAYLOADS.img}`);
		expect(await page.evaluate(() => window.__xss), "保存後の描き直しで実行された").toBeUndefined();
		expect(await page.locator("#manifestPane img").count()).toBe(0);
	});

	test("資料名の押下先が、仕込まれた値で他の文書にすり替わらない", async ({page}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("XSS検証${STAMP}")`);
		await page.click("#projectTreeTitle");

		await page.locator(`.manifestItemName .openLink:has-text("${DOC_NAME}")`).click();
		await expect(page.locator("#previewTitle")).toHaveText(DOC_NAME);
	});
});
