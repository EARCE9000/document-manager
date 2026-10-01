/*!
 * preview-links.e2e.js : プレビュー枠の中のリンクが辿れること
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 文書はiframeの中に出している。スクリプトは動かさない(中身は信用できない入力)が、
 * **リンクは押せないといけない**。何もしないと行き先が枠の中になり、
 *
 *   同じ出どころ … 画面が入れ子で開く(しかもスクリプトが動かないので壊れて見える)
 *   外部サイト   … CSPで止まって何も起きない
 *
 * のどちらかになる。どちらも「リンクが死んでいる」としか見えない。
 *
 * 本体のプレビューは一覧・絞り込み・選択中の文書を抱えているため、別タブで開かせる。
 * 共有リンクの表示(alias-viewer.e2e.js)は文書しか出していないので、そちらは画面ごと移動する。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const NAME = `プレビューのリンク${STAMP}.md`;
const BODY = "# 案内\n\n## 目次\n\n- [この文書の中へ](#案内)\n- [一覧へ](/)\n";

test.describe.serial("プレビュー枠の中のリンク(実ブラウザ)", () => {
	test.beforeAll(async ({request}) => {
		const res = await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name: NAME, mimeType: "text/markdown", buffer: Buffer.from(BODY)}}
		});
		expect(res.status()).toBe(200);
	});

	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await page.fill("#filterInput", NAME);
		await page.click(`text=${NAME}`);
		await expect(page.locator("#previewTitle")).toHaveText(NAME);
	});

	test("リンクを押すと別タブで開き、作業中の画面はそのまま", async ({page, context}) => {
		const [opened] = await Promise.all([
			context.waitForEvent("page"),
			page.frameLocator("#previewFrame").getByText("一覧へ").click()
		]);
		await opened.waitForLoadState("domcontentloaded");
		// 開いた先が枠の制限を引きずっていないこと(引きずると画面が動かない)
		await expect(opened.locator("#documentList")).toBeVisible();
		await opened.close();

		// 元の画面は、選んでいた文書も絞り込みもそのまま
		await expect(page).toHaveURL(new URL("./", BASE_URL).href);
		await expect(page.locator("#previewTitle")).toHaveText(NAME);
		await expect(page.locator("#filterInput")).toHaveValue(NAME);
	});

	// 長い文書の目次。別タブにすると全部おかしくなる
	test("ページ内の見出しへのリンクは、枠の中のまま", async ({page}) => {
		const inside = page.frameLocator("#previewFrame").getByText("この文書の中へ");
		await expect(inside).not.toHaveAttribute("target", "_blank");
	});

	// 枠を緩めたせいで、文書に仕込まれたスクリプトが動くようになっていないこと
	test("スクリプトは動かないまま", async ({page, request}) => {
		const html = `<!DOCTYPE html><html><body><h1 id="marker">safe</h1>`
			+ `<script>document.getElementById('marker').textContent='XSS-EXECUTED';</script></body></html>`;
		const name = `罠プレビュー${STAMP}.html`;
		await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name, mimeType: "text/html", buffer: Buffer.from(html)}}
		});

		await page.fill("#filterInput", name);
		await page.click(`text=${name}`);
		await expect(page.locator("#previewTitle")).toHaveText(name);
		await expect(page.frameLocator("#previewFrame").locator("#marker")).toHaveText("safe");
		expect(await page.locator("#previewFrame").getAttribute("sandbox")).not.toContain("allow-scripts");
	});
});
