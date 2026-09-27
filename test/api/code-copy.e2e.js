/*!
 * code-copy.e2e.js : Markdownプレビューのコードブロックをコピーするボタン
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 手順書に貼ったシェルスクリプトを、選択せずに丸ごと取れるようにするためのもの。
 *
 * **プレビュー側にスクリプトは足していない。** Markdownには生のHTMLを書けるため、
 * プレビューは script-src 'none' で配信し、iframeからも allow-scripts を外してある。
 * ボタンのためにそこを緩めると、守りたかったものが崩れる。iframeは同一オリジンなので、
 * この画面(index.html)のスクリプトから中のDOMへ触れる形にしている。
 *
 * つまり「プレビューのCSPとサンドボックスが元のままであること」も、この機能の一部である。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const SCRIPT = "#!/usr/bin/env bash\nset -euo pipefail\napt-get update\n";
const MD_NAME = `コピー確認-${STAMP}.md`;
const HTML_NAME = `そのまま-${STAMP}.html`;

test.use({permissions: ["clipboard-read", "clipboard-write"]});

test.describe.serial("コードブロックのコピー(実ブラウザ)", () => {
	test.beforeAll(async ({request}) => {
		await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: MD_NAME, mimeType: "text/markdown", buffer: Buffer.from(
				"# 手順\n\n```bash\n" + SCRIPT + "```\n\n本文です。\n\n```\n2つ目のブロック\n```\n")}}
		});
		await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: HTML_NAME, mimeType: "text/html",
				buffer: Buffer.from("<pre>アップロードされた生のHTML</pre>")}}
		});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	const openPreview = async (page, name) => {
		await page.goto("./");
		await page.fill("#filterInput", name);
		await page.click(`text=${name}`);
		return page.frameLocator("#previewFrame");
	};

	test("コードブロックごとにボタンが付く", async ({page}) => {
		const frame = await openPreview(page, MD_NAME);
		await expect(frame.locator(".dmCodeWrap").first()).toBeVisible();
		expect(await frame.locator(".dmCopyButton").count()).toBe(2);
	});

	// 常に出ているとコードの1行目に重なる
	test("マウスを乗せたときだけ出る", async ({page}) => {
		const frame = await openPreview(page, MD_NAME);
		const button = frame.locator(".dmCopyButton").first();
		await expect(button).toBeAttached();
		expect(await button.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

		await frame.locator(".dmCodeWrap").first().hover();
		await expect.poll(() => button.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
	});

	test("押すと中身がそのままクリップボードへ入る", async ({page}) => {
		const frame = await openPreview(page, MD_NAME);
		const button = frame.locator(".dmCopyButton").first();
		await button.click();
		await expect(button).toHaveText("コピーしました");

		const copied = await page.evaluate(() => navigator.clipboard.readText());
		// Windowsのクリップボードは改行をCRLFへ直すため、比較の前に揃える
		expect(copied.replace(/\r\n/g, "\n")).toBe(SCRIPT);
		// ボタンの文字を拾っていないこと(中身を控えてからボタンを入れている)
		expect(copied, "ボタンの文字まで混ざっている").not.toContain("コピー");
	});

	test("しばらくすると元の表示に戻る", async ({page}) => {
		const frame = await openPreview(page, MD_NAME);
		const button = frame.locator(".dmCopyButton").first();
		await button.click();
		await expect(button).toHaveText("コピーしました");
		await expect(button).toHaveText("コピー", {timeout: 5000});
	});

	// ここが崩れると、仕込まれたスクリプトが動くようになる
	test("プレビュー側のスクリプトは止めたままになっている", async ({page, request}) => {
		const frame = await openPreview(page, MD_NAME);
		await expect(frame.locator(".dmCodeWrap").first()).toBeVisible();

		const sandbox = await page.locator("#previewFrame").getAttribute("sandbox");
		expect(sandbox, "iframeでスクリプトを許してしまっている").not.toContain("allow-scripts");

		const list = await (await request.get(`api/documents?q=${encodeURIComponent(MD_NAME)}`, {headers: rw})).json();
		const res = await request.get(`api/documents/${list[0].id}/file`, {headers: rw});
		expect(res.headers()["content-security-policy"], "配信のCSPが緩んでいる").toContain("script-src 'none'");
		expect(await res.text(), "プレビューにスクリプトが入っている").not.toContain("<script");
	});

	// 見せているものを書き換えると、原本と違うものを見ることになる
	test("アップロードされた生のHTMLには手を入れない", async ({page}) => {
		const frame = await openPreview(page, HTML_NAME);
		await expect(frame.locator("pre")).toHaveText("アップロードされた生のHTML");
		await expect(frame.locator(".dmCopyButton")).toHaveCount(0);
	});
});
