/*!
 * document-diff.e2e.js : 版の差分の画面(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 版履歴の「前の版と比べる」で差分が開き、足した行・消した行・行の中の変わった文字に色が付くこと、
 * 比べる元を選び直せること、全文を表示できること、最初の版には比べるボタンが出ないこと、Esc で閉じることを確かめる。
 * 中身の正しさは document-diff.spec.js で確かめている。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

test("版履歴から前の版と比べられる", async ({context, page, request}) => {
	const name = `e2e-差分-${Date.now()}.md`;
	const upload = async (body, previousId) => (await (await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType: "text/markdown", buffer: Buffer.from(body)}, ...(previousId ? {previousId} : {})}
	})).json()).id;
	const lines = Array.from({length: 12}, (_, i) => `行 ${i + 1}`);
	const v1 = await upload(["# 手順", "本文はこれです。", ...lines].join("\n"));
	const v2 = await upload(["# 手順", "本文はこちらです。", "足した行", ...lines].join("\n"), v1);
	await upload(["# 手順", "本文はこちらです。", "足した行", ...lines.slice(0, 11), "最後の行を直した"].join("\n"), v2);

	await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	await page.goto("./");
	await page.locator("#documentList li", {hasText: name}).click();
	const row = page.locator("#versionHistoryRow");
	await expect(row.locator(".versionPosition")).toHaveText("v3 / 全3版");

	await test.step("前の版(v2)と比べると、変わった行だけが前後の行と出る", async () => {
		await row.getByRole("button", {name: "前の版と比べる"}).click();
		const overlay = page.locator("#diffOverlay");
		await expect(overlay).toBeVisible();
		await expect(page.locator("#diffTargetLabel")).toContainText(`v3 ${name}`);
		await expect(page.locator("#diffBaseSelect")).toHaveValue(v2);
		await expect(page.locator("#diffSummary")).toContainText("+1 行");
		await expect(page.locator("#diffSummary")).toContainText("−1 行");
		await expect(page.locator("#diffBody .diffLine.del")).toHaveText(/行 12/);
		await expect(page.locator("#diffBody .diffLine.add")).toHaveText(/最後の行を直した/);
		await expect(page.locator("#diffBody .diffHunk")).toHaveCount(1);
	});

	await test.step("比べる元を v1 にすると、行の中の変わった文字に色が付く", async () => {
		await page.locator("#diffBaseSelect").selectOption(v1);
		await expect(page.locator("#diffSummary")).toContainText("+3 行");
		await expect(page.locator("#diffBody .diffLine.add mark").first()).toHaveText("ちら");
		await expect(page.locator("#diffBody .diffLine.del mark").first()).toHaveText("れ");
	});

	await test.step("全文を表示すると、変わっていない行も全部出る", async () => {
		await page.locator("#diffShowAll").check();
		await expect(page.locator("#diffBody .diffHunk")).toHaveCount(0);
		await expect(page.locator("#diffBody .diffLine.same").first()).toHaveText(/# 手順/);
		await expect(page.locator("#diffBody .diffLine:not(.del)")).toHaveCount(15);
	});

	await test.step("Esc で閉じる", async () => {
		await page.locator("#diffShowAll").focus();
		await page.keyboard.press("Escape");
		await expect(page.locator("#diffOverlay")).toBeHidden();
	});

	await test.step("最初の版には「前の版と比べる」が出ない", async () => {
		await row.getByLabel("1つ前の版へ").click();
		await row.getByLabel("1つ前の版へ").click();
		await expect(row.locator(".versionPosition")).toHaveText("v1 / 全3版");
		await expect(row.getByRole("button", {name: "前の版と比べる"})).toHaveCount(0);
	});
});
