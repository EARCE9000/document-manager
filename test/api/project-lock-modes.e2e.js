/*!
 * project-lock-modes.e2e.js : プロジェクトの2つの「止め方」の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 止め方が1つだと、画面の誤操作を防ぐために閉じるとAIエージェント(APIキー)からの編集まで
 * 止まってしまう。実際の並べ替えはAI側で行うことが多いため、用途の違う2つに分けている。
 *
 *   編集モード(鉛筆)  : この画面だけ。既定はオフ。APIには何も送らない
 *   完全ロック(南京錠): サーバーに保存する全利用者共有の状態。編集APIが423になる
 *
 * ここで守りたいのは次の2点で、どちらも取り違えると実害が出る。
 *   - 画面を閉じただけでAIが止まらないこと(止まると、AIに任せている作業が進まなくなる)
 *   - 完全ロックはAIにも効くこと(効かないと「固めたはず」が固まっていない)
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const PROJECT = `ロック2種E2E ${STAMP}`;

test.describe.serial("プロジェクトの止め方(実ブラウザ)", () => {
	let projectId;

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: PROJECT}})).json()).id;
		await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件"}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	const open = async (page) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
	};

	// 既定が編集モードだと、別ウィンドウのボタン等を押すつもりで行の↑↓に触りやすい
	test("開いた直後は表示モードで、編集の操作が出ていない", async ({page}) => {
		await open(page);
		await expect(page.locator("#sideBar")).toBeHidden();
		await expect(page.locator("#projectEditingBadge")).toBeHidden();
		await expect(page.locator("#projectAddRootFolderButton")).toBeHidden();

		await page.locator(".treeFolderRow").first().hover();
		await expect(page.locator(".treeRowActions").first()).toBeHidden();
	});

	test("トグルを押すと編集の操作が出て、もう一度押すと引っ込む", async ({page}) => {
		await open(page);
		const toggle = page.locator("#projectEditToggleButton");
		const badge = page.locator("#projectEditingBadge");
		// 記号はトグル(つまみの位置で入/切が読める)。何の入/切かは、入にしたときだけ出す
		// バッジで伝える。切のときにも文字を出すと、狭いツリー欄で名前を常時削ることになる
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(badge).toBeHidden();

		await toggle.click();
		await expect(page.locator("#sideBar")).toBeVisible();
		await expect(page.locator("#projectAddRootFolderButton")).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(toggle).toHaveClass(/editModeOn/);
		await expect(badge).toHaveText("編集中");
		// 記号が増えてもプロジェクト名が読める(ボタン側をまとめて次の行へ送っている)
		expect(await page.locator("#projectTreeTitle").evaluate((el) => el.clientWidth),
			"編集モードでプロジェクト名が潰れている").toBeGreaterThan(100);

		await toggle.click();
		await expect(page.locator("#sideBar")).toBeHidden();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(toggle).not.toHaveClass(/editModeOn/);
		await expect(badge).toBeHidden();
	});

	// これがこの分割の目的そのもの
	test("画面を表示モードにしても、APIキー(AI)からは編集できる", async ({page, request}) => {
		await open(page);
		await expect(page.locator("#sideBar")).toBeHidden();

		const res = await request.post(`api/projects/${projectId}/folders`, {
			headers: rw, data: {name: `AIが足した章 ${STAMP}`}
		});
		expect(res.status(), "表示モードにしただけでAIの編集が止まっている").toBe(200);

		// 画面にも出てくる(SSEで追随する)
		await expect(page.locator(".treeFolderRow", {hasText: `AIが足した章 ${STAMP}`})).toBeVisible({timeout: 10000});
	});

	test("別のプロジェクトへ移ると、編集モードは閉じる", async ({page, request}) => {
		const other = `ロック2種-別 ${STAMP}`;
		await request.post("api/projects", {headers: rw, data: {name: other}});

		await open(page);
		await page.click("#projectEditToggleButton");
		await expect(page.locator("#sideBar")).toBeVisible();

		await page.click(`.projectTab:has-text("${other}")`);
		await expect(page.locator("#projectTreeTitle")).toHaveText(other);
		await expect(page.locator("#sideBar")).toBeHidden();
	});

	test.describe("完全ロック", () => {
		test.afterAll(async ({request}) => {
			await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		});

		test("南京錠を押すと、APIキー(AI)からの編集も423になる", async ({page, request}) => {
			await open(page);
			const before = await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: `施錠前 ${STAMP}`}});
			expect(before.status()).toBe(200);

			await page.click("#projectFullLockButton");
			await expect(page.locator("#projectFullLockButton")).toHaveClass(/fullLockOn/);

			const after = await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: `施錠後 ${STAMP}`}});
			expect(after.status(), "完全ロックがAIに効いていない").toBe(423);
		});

		// 押せても何も通らないので、押せないことで先に分かるようにする
		test("完全ロック中は、編集モードへ切り替えられない", async ({page}) => {
			await open(page);
			await expect(page.locator("#projectFullLockButton")).toHaveClass(/fullLockOn/);
			await expect(page.locator("#projectEditToggleButton")).toBeDisabled();
			await expect(page.locator("#sideBar")).toBeHidden();
		});

		test("南京錠をもう一度押すと元に戻る", async ({page, request}) => {
			await open(page);
			await page.click("#projectFullLockButton");
			await expect(page.locator("#projectFullLockButton")).not.toHaveClass(/fullLockOn/);
			await expect(page.locator("#projectEditToggleButton")).toBeEnabled();

			const res = await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: `解錠後 ${STAMP}`}});
			expect(res.status()).toBe(200);
		});

		// 掛けたのに編集の操作が残っていると、押しても423で弾かれるだけになる
		test("編集モード中に完全ロックすると、編集の操作が引っ込む", async ({page}) => {
			await open(page);
			await page.click("#projectEditToggleButton");
			await expect(page.locator("#sideBar")).toBeVisible();

			await page.click("#projectFullLockButton");
			await expect(page.locator("#sideBar")).toBeHidden();
			await expect(page.locator("#projectEditToggleButton")).toBeDisabled();
			await expect(page.locator("#projectEditingBadge"), "止めたのに編集中のままに見える").toBeHidden();
		});
	});
});
