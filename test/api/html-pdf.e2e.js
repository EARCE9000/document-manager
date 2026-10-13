/*!
 * html-pdf.e2e.js : 「PDFでダウンロード」のボタン(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * HTMLで作った資料をメールで渡すと、相手の環境ではテキストとして出てしまうことがある。
 * 人が画面の操作でPDFにして持ち出せるようにする。
 *
 * 変換そのものは pdf-converter/test/smoke.js、APIの振る舞いは html-pdf.spec.js が見る。
 * ここで見るのは画面: 出すべきときにだけボタンが出るか、押して保存まで行くか、
 * うまくいかなかったときに黙らないか。変換サービスにはスタブを使う。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const STUB_URL = process.env.PDF_STUB_URL || `http://127.0.0.1:${process.env.PDF_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 10}`;
const STAMP = Date.now();
const MARKDOWN_NAME = `PDF持ち出し${STAMP}.md`;
const TEXT_NAME = `PDF対象外${STAMP}.txt`;

const upload = async (request, name, body) => {
	const res = await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType: "application/octet-stream", buffer: Buffer.from(body, "utf-8")}}
	});
	expect(res.status()).toBe(200);
	return res.json();
};

const openDocument = async (page, name) => {
	await page.locator("#filterInput").fill(name.replace(/\.[^.]+$/, ""));
	await page.locator("#documentList li", {hasText: name}).first().click();
	await expect(page.locator("#previewTitle")).toContainText(name);
};

test.describe.serial("PDFでダウンロード(実ブラウザ)", () => {
	test.beforeAll(async ({request}) => {
		await upload(request, MARKDOWN_NAME, "# 手順\n\n本文です。\n");
		await upload(request, TEXT_NAME, "テキストの本文");
	});

	test.beforeEach(async ({context, page, request}) => {
		await request.post(`${STUB_URL}/__control`, {data: {mode: "ok", blocked: 0, status: 500, reset: true}});
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});

	test.afterAll(async ({request}) => {
		await request.post(`${STUB_URL}/__control`, {data: {mode: "ok", blocked: 0, status: 500, reset: true}});
	});

	test("Markdownの文書ではボタンが出て、押すとPDFが保存される", async ({page, request}) => {
		await openDocument(page, MARKDOWN_NAME);
		const button = page.locator("#previewPdfButton");
		await expect(button).toBeVisible();
		await expect(button).toHaveAttribute("aria-label", "PDFでダウンロード");

		const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
		// 保存するときの名前は、元の名前の拡張子を .pdf に替えたもの
		expect(download.suggestedFilename()).toBe(MARKDOWN_NAME.replace(/\.md$/, ".pdf"));
		// 変換サービスへ渡っているのは、整えたプレビュー(原本のMarkdownではない)
		const sent = await (await request.get(`${STUB_URL}/__requests`)).json();
		expect(sent).toHaveLength(1);
		expect(sent[0].bodyHead).toContain("<h1>手順</h1>");
		// 押し直せる状態に戻っている
		await expect(button).toBeEnabled();
	});

	test("対象外の形式では、ボタンを出さない", async ({page}) => {
		await openDocument(page, TEXT_NAME);
		await expect(page.locator("#downloadLink")).toBeVisible();
		await expect(page.locator("#previewPdfButton")).toBeHidden();
	});

	// 黙って渡すと「相手に送ったら画像が無かった」となる
	test("外部の画像が入らなかったときは、保存したうえで知らせる", async ({page, request}) => {
		await request.post(`${STUB_URL}/__control`, {data: {blocked: 2}});
		await openDocument(page, MARKDOWN_NAME);
		const dialogMessage = new Promise((resolve) => {
			page.once("dialog", async (dialog) => {
				resolve(dialog.message());
				await dialog.accept();
			});
		});
		const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#previewPdfButton").click()]);
		expect(download.suggestedFilename()).toMatch(/\.pdf$/);
		const message = await dialogMessage;
		expect(message).toContain("2 件");
		expect(message).toContain("PDFには入っていません");
	});

	test("変換に失敗したら理由を出し、何も保存しない。ボタンは押し直せる", async ({page, request}) => {
		await request.post(`${STUB_URL}/__control`, {data: {mode: "fail", status: 500}});
		await openDocument(page, MARKDOWN_NAME);
		let downloaded = false;
		page.on("download", () => {
			downloaded = true;
		});
		const dialogMessage = new Promise((resolve) => {
			page.once("dialog", async (dialog) => {
				resolve(dialog.message());
				await dialog.accept();
			});
		});
		await page.locator("#previewPdfButton").click();
		expect(await dialogMessage).toContain("変換サービス");
		await expect(page.locator("#previewPdfButton")).toBeEnabled();
		expect(downloaded, "失敗したのに何かを保存している").toBe(false);
		// 画面はそのまま(エラーのJSON表示へ切り替わっていない)
		await expect(page.locator("#previewTitle")).toContainText(MARKDOWN_NAME);
	});

	test("変換サービスが無い環境では、ボタンも使い方の説明も出さない", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const res = await route.fetch();
			await route.fulfill({response: res, json: {...(await res.json()), htmlPdfEnabled: false}});
		});
		await page.reload();
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await openDocument(page, MARKDOWN_NAME);
		await expect(page.locator("#downloadLink")).toBeVisible();
		await expect(page.locator("#previewPdfButton")).toBeHidden();
		await page.locator("#helpButton").click();
		await expect(page.locator("#helpBody")).toBeVisible();
		await expect(page.locator("#helpPdfSection")).toBeHidden();
	});

	test("使える環境では、使い方に説明が出る", async ({page}) => {
		await page.locator("#helpButton").click();
		await expect(page.locator("#helpPdfSection")).toBeVisible();
		await expect(page.locator("#helpPdfSection")).toContainText("1枚の長いページ");
	});

	test("管理画面の変換サービスタブに、PDF用の状態が出る", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="convert"]');
		const result = page.locator("#pdfHealthResult");
		await expect(result.locator(".adminStatus")).toHaveText("正常");
		await expect(result).toContainText("Chromium");
		// Office用の状態はこれまでどおり、別に出ている
		await expect(page.locator("#convertHealthResult .adminStatus")).toBeVisible();
	});
});
