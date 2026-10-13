/*!
 * project-link.e2e.js : プロジェクトを開くリンク(実ブラウザ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 文書には共有リンクがあるが、プロジェクトには「この案件の資料はここ」と渡せるURLが無かった。
 * プロジェクトの画面でリンクをコピーでき、開くとそのプロジェクトのおしながき(資料一覧と説明書き)が出る。
 *
 * いちばん困るのは、**渡したのと違うプロジェクトが開くこと**。受け取った人には区別がつかず、
 * 別の案件の資料を「渡された資料」として読んでしまう。見つからないときは、そうと伝える。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const STAMP = Date.now();
const FIRST = `リンク先ではないPJ ${STAMP}`;
const TARGET = `リンクで開くPJ ${STAMP}`;
const ARCHIVED = `アーカイブ済みPJ ${STAMP}`;
const DOC = `リンクPJの資料${STAMP}.txt`;

test.describe.serial("プロジェクトを開くリンク(実ブラウザ)", () => {
	let targetId;
	let archivedId;

	test.beforeAll(async ({request}) => {
		const create = async (name) => (await (await request.post("api/projects", {headers: rw, data: {name}})).json()).id;
		await create(FIRST);
		targetId = await create(TARGET);
		archivedId = await create(ARCHIVED);
		const doc = await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name: DOC, mimeType: "text/plain", buffer: Buffer.from("本文")}}
		})).json();
		await request.put(`api/projects/${targetId}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${targetId}/documents/${doc.id}/note`, {headers: rw, data: {note: "リンクで開いた人に見せたい説明"}});
		expect((await request.post(`api/projects/${archivedId}/archive`, {headers: rw})).status()).toBeLessThan(300);
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	});

	test("プロジェクトの画面で、そのプロジェクトのリンクをコピーできる", async ({page}) => {
		await page.goto("./");
		await page.locator("#menuProjectsLink").click();
		await page.locator(`.projectTab[data-id="${targetId}"]`).click();
		await expect(page.locator("#projectTreeTitle")).toHaveText(TARGET);

		const button = page.locator("#projectCopyLinkButton");
		await expect(button).toBeEnabled();
		await button.click();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toBe(`${BASE_URL}/?project=${encodeURIComponent(targetId)}`);
	});

	// この機能の要
	test("リンクを開くと、そのプロジェクトが選ばれて、おしながきが出る", async ({page}) => {
		await page.goto(`./?project=${encodeURIComponent(targetId)}`);
		// 一覧の先頭ではなく、指定したプロジェクトが開く
		await expect(page.locator("#projectTreeTitle")).toHaveText(TARGET);
		await expect(page.locator(".projectTab.active")).toHaveText(TARGET);
		await expect(page.locator("#menuProjectsLink")).toHaveClass(/active/);
		// 資料の一覧と説明書きが、開いた時点で見えている
		await expect(page.locator("#manifestPane")).toBeVisible();
		await expect(page.locator("#manifestPane")).toContainText(DOC);
		await expect(page.locator("#manifestPane")).toContainText("リンクで開いた人に見せたい説明");
	});

	// 残すと、別のプロジェクトへ移ったあとの再読み込みで元のプロジェクトへ戻されてしまう
	test("開いたあと、URLから目印を外す(再読み込みで引き戻されない)", async ({page}) => {
		await page.goto(`./?project=${encodeURIComponent(targetId)}`);
		await expect(page.locator("#projectTreeTitle")).toHaveText(TARGET);
		expect(new URL(page.url()).search).toBe("");
	});

	test("見つからないプロジェクトのリンクは、別のプロジェクトを出さずに、そうと伝える", async ({page}) => {
		const dialogMessage = new Promise((resolve) => {
			page.once("dialog", async (dialog) => {
				resolve(dialog.message());
				await dialog.accept();
			});
		});
		await page.goto("./?project=no-such-project");
		expect(await dialogMessage).toContain("見つかりません");
		// 文書一覧のまま。プロジェクトの画面へは切り替えない
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await expect(page.locator("#menuProjectsLink")).not.toHaveClass(/active/);
		await expect(page.locator("#manifestPane")).toBeHidden();
	});

	// 渡したあとでアーカイブされても、行き止まりにしない
	test("アーカイブ済みのプロジェクトのリンクも開ける", async ({page}) => {
		await page.goto(`./?project=${encodeURIComponent(archivedId)}`);
		await expect(page.locator("#projectTreeTitle")).toHaveText(ARCHIVED);
		// アーカイブ済みの一覧として開いている(通常の一覧に混ぜない)
		await expect(page.locator("#appShell")).toHaveClass(/projectsArchiveMode/);
		await expect(page.locator("#manifestPane")).toBeVisible();
	});

	test("閲覧だけの権限でも、リンクのコピーと、リンクからの表示ができる", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const res = await route.fetch();
			await route.fulfill({response: res, json: {...(await res.json()), isAdmin: false, role: "readonly"}});
		});
		await page.goto(`./?project=${encodeURIComponent(targetId)}`);
		await expect(page.locator("#projectTreeTitle")).toHaveText(TARGET);
		await expect(page.locator("#manifestPane")).toBeVisible();
		await expect(page.locator("#projectCopyLinkButton")).toBeVisible();
		await expect(page.locator("#projectCopyLinkButton")).toBeEnabled();
	});

	// 戻り先を渡さないと、ログインのあとただのトップ画面に着いて、リンクが消える
	test("未ログインで開くと、ログインのあと同じリンクへ戻るよう、戻り先を付けてログインへ回す", async ({browser}) => {
		const context = await browser.newContext({baseURL: `${BASE_URL}/`});
		const page = await context.newPage();
		try {
			const loginRequest = page.waitForRequest((req) => new URL(req.url()).pathname.endsWith("/login"));
			await page.goto(`./?project=${encodeURIComponent(targetId)}`).catch(() => {});
			const url = new URL((await loginRequest).url());
			expect(url.searchParams.get("next")).toBe(`/?project=${encodeURIComponent(targetId)}`);
		} finally {
			await context.close();
		}
	});

	test("リンクなしで開いたときは、これまでどおり(戻り先なしでログインへ、ログイン済みなら文書一覧)", async ({page, browser}) => {
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await expect(page.locator("#menuDocumentsLink")).toHaveClass(/active/);

		const context = await browser.newContext({baseURL: `${BASE_URL}/`});
		const anonymous = await context.newPage();
		try {
			const loginRequest = anonymous.waitForRequest((req) => new URL(req.url()).pathname.endsWith("/login"));
			await anonymous.goto("./").catch(() => {});
			expect(new URL((await loginRequest).url()).searchParams.has("next")).toBe(false);
		} finally {
			await context.close();
		}
	});
});
