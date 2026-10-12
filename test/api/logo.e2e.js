/*!
 * logo.e2e.js : ロゴ(題字の横)とファビコン
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 同じ作りのサービスがいくつもあり、タブを並べて開く。見分ける手がかりは
 * タブのファビコンと、画面左上の題字の横のロゴ。
 *
 * ロゴは他のサービスと揃えた決まりで描いてある(角の丸い色付きのタイルに白い線の絵)。
 * 色は若草(#6f9b16)。画面で赤を「取り消せない操作」のボタンに、橙を選択中のメニューに
 * 使っているため、それらと重ならない色にしている。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

test.describe("ロゴとファビコン", () => {
	// ログイン画面へ迂回している間もタブには出る。認証の内側に置くと、そこで絵が欠ける
	test("ロゴはログインしていなくても取れる", async ({playwright}) => {
		const anonymous = await playwright.request.newContext({baseURL: `${BASE_URL}/`});
		try {
			const res = await anonymous.get("logo.svg");
			expect(res.status()).toBe(200);
			expect(res.headers()["content-type"]).toContain("image/svg+xml");
		} finally {
			await anonymous.dispose();
		}
	});

	// 他のサービスのロゴと並べたときに仲間に見えるための決まり
	test("他のサービスと同じ決まりで描いてある", async ({request}) => {
		const svg = await (await request.get("logo.svg")).text();
		expect(svg).toContain('viewBox="0 0 64 64"');
		expect(svg, "タイルの角の丸みが違う").toContain('<rect width="64" height="64" rx="14" fill="#6f9b16"/>');
		expect(svg, "線の太さ・色が違う").toContain('stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"');
		// 中にスクリプトや外部への参照を持たない(画像として安全に置けること)
		expect(svg).not.toMatch(/<script|href=|url\(/i);
	});

	// 文書を別ウィンドウで開いたときも、どのサービスのタブか分かること
	for (const page of ["", "alias-viewer.html", "drawio-viewer.html", "mermaid-viewer.html"]) {
		test(`${page || "本体の画面"} にファビコンが付いている`, async ({request}) => {
			const html = await (await request.get(page)).text();
			expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./logo.svg">');
		});
	}

	test("題字の左にロゴが出る(絵が読み込めている)", async ({page, context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		const logo = page.locator(".topBarTitle .topBarLogo");
		await expect(logo).toBeVisible();
		// 置いただけで読み込めていない(リンク切れ)と、枠だけが出る
		expect(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), "ロゴの絵が読み込めていない").toBe(true);
		// 題字はこれまでどおり読める(絵に置き換えていない)
		await expect(page.locator(".topBarTitle")).toHaveText("Document Manager");

		// 文字より左にあり、黒い帯の中に収まっている
		const [logoBox, barBox] = [await logo.boundingBox(), await page.locator("#topBar").boundingBox()];
		const textLeft = await page.locator(".topBarTitle").evaluate((el) => {
			const range = document.createRange();
			range.selectNodeContents(el.lastChild);
			return range.getBoundingClientRect().left;
		});
		expect(logoBox.x + logoBox.width, "ロゴが文字に重なっている").toBeLessThanOrEqual(textLeft);
		expect(logoBox.y).toBeGreaterThanOrEqual(barBox.y);
		expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(barBox.y + barBox.height);
	});
});
