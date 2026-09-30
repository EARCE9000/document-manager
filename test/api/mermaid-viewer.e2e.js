/*!
 * mermaid-viewer.e2e.js : .mmd / .mermaid をブラウザ上で図として描く
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Mermaidの図は**ラベルにHTMLを書ける**(draw.ioと同じ性質)。つまり図のテキストは
 * 信用できない入力で、守りは二重にしている。
 *
 *   1. securityLevel: "strict"(Mermaid側のサニタイズ)
 *   2. script-src 'self' のCSP(server.jsがレスポンスヘッダーで付ける)
 *
 * ここで見るのは主に次の3つ。
 *   - 図として描けること(テキストのまま出ていないこと)
 *   - **外部へ取りに行かないこと**。CDNから読むと図の存在が第三者に伝わる
 *   - 仕込まれたスクリプトが動かないこと
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const FLOW = "graph TD;\n  A[受注登録] --> B{在庫あり?};\n  B -->|はい| C[出荷];\n  B -->|いいえ| D[取り寄せ];";

const upload = async (request, name, body) => (await (await request.post("api/documents", {
	headers: rw, multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body, "utf-8")}}
})).json()).id;

test.describe.serial("Mermaidビューア(実ブラウザ)", () => {
	let flowId;

	test.beforeAll(async ({request}) => {
		flowId = await upload(request, `業務フロー${STAMP}.mmd`, FLOW);
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("図として描かれ、外部へは取りに行かない", async ({page}) => {
		const outside = [];
		page.on("request", (req) => {
			const host = new URL(req.url()).hostname;
			if (host !== new URL(BASE_URL).hostname) outside.push(host);
		});

		await page.goto(`mermaid-viewer.html?id=${flowId}`);
		await expect(page.locator("#viewer svg")).toBeAttached({timeout: 15000});

		// 図の中身が描けている(四角と線があり、ラベルが入っている)
		expect(await page.locator("#viewer svg").count()).toBe(1);
		await expect(page.locator("#viewer svg")).toContainText("受注登録");
		await expect(page.locator("#viewer svg")).toContainText("取り寄せ");

		expect(outside, "外部へ取りに行っている").toEqual([]);
		await expect(page.locator("#status")).toBeHidden();
	});

	// CDNから読むと、どの図がいつ見られたかが第三者に伝わる
	test("Mermaid本体を同梱から読んでいる", async ({page}) => {
		const scripts = [];
		page.on("request", (req) => { if (req.resourceType() === "script") scripts.push(new URL(req.url()).pathname); });
		await page.goto(`mermaid-viewer.html?id=${flowId}`);
		await expect(page.locator("#viewer svg")).toBeAttached({timeout: 15000});
		expect(scripts.some((p) => p.endsWith("/vendor/mermaid/mermaid.min.js")), `読んだもの: ${scripts.join(", ")}`).toBe(true);
	});

	// ここが崩れると、図に仕込まれたスクリプトが動く
	test("配信のCSPでスクリプトの出どころが絞られている", async ({request}) => {
		const res = await request.get("mermaid-viewer.html", {headers: rw});
		expect(res.status()).toBe(200);
		const csp = res.headers()["content-security-policy"];
		expect(csp, "CSPが付いていない").toBeTruthy();
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("default-src 'none'");
		// インラインを許すと、図に仕込まれたものが動く余地ができる
		expect(csp, "インラインのスクリプトを許している").not.toContain("unsafe-inline'; script-src");
		expect(csp, "evalを許している").not.toContain("unsafe-eval");
	});

	test("図に仕掛けを入れても動かない", async ({page, request}) => {
		const evil = 'graph TD;\n  A["<img src=x onerror=\'window.__xss=1\'>"] --> B[通常];';
		const id = await upload(request, `仕掛け${STAMP}.mmd`, evil);

		const dialogs = [];
		page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
		await page.goto(`mermaid-viewer.html?id=${id}`);
		await page.waitForTimeout(1500);

		expect(await page.evaluate(() => window.__xss), "仕込まれたスクリプトが動いた").toBeUndefined();
		expect(dialogs).toEqual([]);
	});

	// 書き間違いは珍しくない。黙って空にせず、直せるようにする
	test("図にできないときは、原因と元のテキストを見せる", async ({page, request}) => {
		const id = await upload(request, `壊れ${STAMP}.mmd`, "graph TD;\n  A --> ;;;壊れた");
		await page.goto(`mermaid-viewer.html?id=${id}`);
		await expect(page.locator("#status.failed")).toBeVisible({timeout: 15000});
		await expect(page.locator("#source")).toBeVisible();
		await expect(page.locator("#source")).toContainText("壊れた");
	});

	test("元のテキストに切り替えられる", async ({page}) => {
		await page.goto(`mermaid-viewer.html?id=${flowId}`);
		await expect(page.locator("#viewer svg")).toBeAttached({timeout: 15000});
		await expect(page.locator("#source")).toBeHidden();

		await page.click("#sourceToggle");
		await expect(page.locator("#source")).toBeVisible();
		await expect(page.locator("#source")).toContainText("graph TD");
	});

	// 別ウィンドウ・共有リンクからもビューアへ回ること
	test("別ウィンドウで開くとビューアへ転送される", async ({request}) => {
		const res = await request.get(`api/documents/${flowId}/viewer`, {
			headers: {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`}, maxRedirects: 0
		});
		expect([301, 302, 307]).toContain(res.status());
		expect(res.headers()["location"]).toContain("mermaid-viewer.html");
	});

	test("本体の画面でもテキストではなく図で出る", async ({page}) => {
		await page.goto("./");
		await page.fill("#filterInput", `業務フロー${STAMP}.mmd`);
		await page.click(`text=業務フロー${STAMP}.mmd`);
		await expect(page.locator("#previewFrame")).toBeVisible();
		expect(await page.locator("#previewFrame").getAttribute("src")).toContain("mermaid-viewer.html");
		await expect(page.frameLocator("#previewFrame").locator("#viewer svg")).toBeVisible({timeout: 15000});
	});

	// 図の原本はビューアが取りに来る。ダウンロード扱いにはしない
	test("?source=1 で原本がそのまま取れる", async ({request}) => {
		const res = await request.get(`api/documents/${flowId}/file?source=1`, {headers: rw});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("text/plain");
		expect(await res.text()).toBe(FLOW);
	});

	test("図でない形式に ?source=1 は使えない", async ({request}) => {
		const id = await upload(request, `ただの文${STAMP}.txt`, "本文");
		const res = await request.get(`api/documents/${id}/file?source=1`, {headers: rw});
		expect(res.status()).toBe(400);
	});
});
