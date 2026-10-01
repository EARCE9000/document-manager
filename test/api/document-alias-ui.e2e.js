/*!
 * document-alias-ui.e2e.js : 共有リンク(Alias)と版のリンクのコピー
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 人に渡すリンクは2種類あり、**取り違えると静かに困る**。
 *
 *   共有リンク(Alias) … 版をまたいで変わらない。更新すると自動で最新を指す
 *   この版のリンク    … その版を指したまま。更新しても動かない
 *
 * 既定は共有リンク。版のリンクは「この版を見てほしい」と明示したいときだけ使う。
 * 別ウィンドウで開くときもAliasのURLにしている(開いた先のアドレスバーを見て貼る人がいるため)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const NAME = `共有リンク${STAMP}.txt`;

test.use({permissions: ["clipboard-read", "clipboard-write"]});

const upload = async (request, name, body, previousId) => {
	const multipart = {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body, "utf-8")}};
	if (previousId) multipart.previousId = previousId;
	return (await (await request.post("api/documents", {headers: rw, multipart})).json());
};

test.describe.serial("共有リンクのコピー(実ブラウザ)", () => {
	let v1;

	test.beforeAll(async ({request}) => {
		v1 = await upload(request, NAME, "v1の本文");
	});

	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await page.fill("#filterInput", NAME);
		await page.click(`text=${NAME}`);
		await expect(page.locator("#previewTitle")).toHaveText(NAME);
	});

	test("2つのコピーボタンが出る", async ({page}) => {
		await expect(page.locator("#copyLinkButton")).toBeVisible();
		await expect(page.locator("#copyVersionLinkButton")).toBeVisible();
		// どちらがどちらか、説明で分かること
		await expect(page.locator("#copyLinkButton")).toHaveAttribute("title", /常に最新/);
		await expect(page.locator("#copyVersionLinkButton")).toHaveAttribute("title", /この版/);
	});

	test("共有リンクはAliasのURLになる", async ({page}) => {
		await page.click("#copyLinkButton");
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toContain(`/api/documents/alias/${v1.alias}/viewer`);
		expect(copied, "版のIDが混ざっている").not.toContain(v1.id);
	});

	test("この版のリンクは文書IDのURLになる", async ({page}) => {
		await page.click("#copyVersionLinkButton");
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toContain(`/api/documents/${v1.id}/viewer`);
		expect(copied, "Aliasが混ざっている").not.toContain("/alias/");
	});

	// 開いた先のアドレスバーを見て貼る人がいる
	test("別ウィンドウで開くと、AliasのURLで開きに行く", async ({page, context}) => {
		// 開きに行ったURLを要求で捕まえる(転送されるため、着地だけでは分からない場合がある)
		const requested = [];
		context.on("request", (req) => {
			const path = new URL(req.url()).pathname;
			if (path.includes("/api/documents/")) requested.push(path);
		});

		const [win] = await Promise.all([
			context.waitForEvent("page"),
			page.locator("#documentList li").filter({hasText: NAME}).locator(".openButton").first().click()
		]);
		await win.waitForLoadState("domcontentloaded");
		// 開いた先のアドレスバーも共有リンクのまま(ここを見て貼られる)
		const landed = win.url();
		await win.close();

		const first = requested.find((path) => path.endsWith("/viewer"));
		expect(first, `開きに行ったURL: ${requested.join(" / ")}`).toContain(`/alias/${v1.alias}/viewer`);
		expect(landed, "アドレスバーが共有リンクになっていない").toContain(`/alias/${v1.alias}/viewer`);
	});

	// 更新したあとも、同じ共有リンクでよいこと
	test("新しい版を上げても、共有リンクは変わらない", async ({page, request}) => {
		const v2 = await upload(request, NAME, "v2の本文", v1.id);
		expect(v2.alias).toBe(v1.alias);

		await page.reload();
		await page.fill("#filterInput", NAME);
		await page.click(`text=${NAME}`);
		await page.click("#copyLinkButton");
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied, "共有リンクが版ごとに変わっている").toContain(`/api/documents/alias/${v1.alias}/viewer`);

		// 版のリンクのほうは新しい版を指す
		await page.click("#copyVersionLinkButton");
		const versionUrl = await page.evaluate(() => navigator.clipboard.readText());
		expect(versionUrl).toContain(v2.id);
	});

	// 矢印が外れた文書でも、押せば発行してコピーできる。
	// 隠すだけだと「この文書は共有できない」と誤解される
	test("Aliasを持たない文書は、押すと発行してコピーする", async ({page, request}) => {
		const older = await upload(request, `矢印なし旧${STAMP}.txt`, "旧");
		const newer = await upload(request, `矢印なし新${STAMP}.txt`, "新", older.id);
		// 古い版へ付け直すと、新しい版から矢印が外れる
		await request.put(`api/documents/alias/${older.alias}`, {headers: rw, data: {documentId: older.id}});
		expect((await (await request.get(`api/documents/${newer.id}`, {headers: rw})).json()).alias).toBeNull();

		await page.goto("./");
		await page.fill("#filterInput", `矢印なし新${STAMP}.txt`);
		await page.click(`text=矢印なし新${STAMP}.txt`);
		await expect(page.locator("#copyLinkButton")).toBeVisible();
		await expect(page.locator("#copyLinkButton")).toHaveAttribute("title", /発行してコピー/);

		await page.click("#copyLinkButton");
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toContain("/api/documents/alias/");

		// 発行されたものが、その文書を指している
		const issued = (await page.evaluate(() => navigator.clipboard.readText())).match(/alias\/([0-9a-f]{12})\//)[1];
		const resolved = await (await request.get(`api/documents/alias/${issued}`, {headers: rw})).json();
		expect(resolved.id).toBe(newer.id);
	});
});
