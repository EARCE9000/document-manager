/*!
 * project-layout.e2e.js : プロジェクト画面の列の並びの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクトの編集中は3つの列が並ぶ。順番は
 *
 *   ファイルを探す(検索・アップロード) → 置き場所を決める(フォルダ構成) → 中身を見る(プレビュー)
 *
 * にしている。理由は2つ。
 *   1. 文書一覧から切り替えたときに検索欄の位置が動かない(前は左端にツリーが入り込んで全体がずれた)
 *   2. 一覧からツリーへ入れる操作の向き(左→右)と並びが揃う
 *
 * 並びはCSSの order で決めていてDOMの順とは違うため、見た目の左右を実際に測って確かめる。
 *
 * 編集モードは既定でオフ(表示モード)。文書一覧は編集モードのときだけ出るため、
 * 並びを見るテストでは先に鉛筆ボタンを押して開く。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const PROJECT = `並び確認 ${Date.now()}`;

test.describe.serial("プロジェクト画面の並び(実ブラウザ)", () => {
	test.beforeAll(async ({request}) => {
		const project = await (await request.post("api/projects", {headers: rw, data: {name: PROJECT}})).json();
		const parent = await (await request.post(`api/projects/${project.id}/folders`, {headers: rw, data: {name: "資料"}})).json();
		// 入れ子を作っておく(全展開/全折りたたみは深いときにこそ効く)
		await request.post(`api/projects/${project.id}/folders`, {headers: rw, data: {name: "内訳", parentFolderId: parent.id}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	// プロジェクトを開いて、編集モードにする(既定は表示モード)
	const openInEditMode = async (page, name = PROJECT) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${name}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
		await page.click("#projectEditToggleButton");
		await expect(page.locator("#sideBar")).toBeVisible();
	};

	const leftEdges = (page) => page.evaluate(() => {
		const rect = (id) => {
			const el = document.getElementById(id);
			const box = el.getBoundingClientRect();
			return {id, left: Math.round(box.left), visible: box.width > 0};
		};
		return ["sideBar", "projectTreePane", "previewArea"].map(rect);
	});

	test("編集中は 検索 → フォルダ構成 → プレビュー の順に並ぶ", async ({page}) => {
		await openInEditMode(page);

		const boxes = await leftEdges(page);
		const order = boxes.filter((b) => b.visible).sort((a, b) => a.left - b.left).map((b) => b.id);
		expect(order, `実際の並び: ${order.join(" → ")}`).toEqual(["sideBar", "projectTreePane", "previewArea"]);
	});

	test("文書一覧から切り替えても、検索欄の位置が動かない", async ({page}) => {
		await page.goto("./");
		await expect(page.locator("#sideBar")).toBeVisible();
		const before = (await leftEdges(page)).find((b) => b.id === "sideBar").left;

		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
		await page.click("#projectEditToggleButton");
		await expect(page.locator("#sideBar")).toBeVisible();
		const after = (await leftEdges(page)).find((b) => b.id === "sideBar").left;

		expect(after, `切り替えで検索欄が ${before}px → ${after}px へ動いた`).toBe(before);
	});

	// 開いた直後は表示モード。一覧を出さず、ツリーとプレビューだけになる
	test("編集中でなければ、フォルダ構成とプレビューだけになる", async ({page}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
		await expect(page.locator("#sideBar")).toBeHidden();

		const order = (await leftEdges(page)).filter((b) => b.visible).sort((a, b) => a.left - b.left).map((b) => b.id);
		expect(order).toEqual(["projectTreePane", "previewArea"]);
	});

	// 階層が深くなると1つずつ開け閉めするのが手間になる
	test("ツリーをまとめて展開・折りたたみできる", async ({page}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();

		const folderRows = page.locator(".treeFolderRow");
		// 既定は開いた状態なので、入れ子の子まで見えている
		await expect(folderRows).toHaveCount(2);

		await page.click("#projectCollapseAllButton");
		// 閉じると、直下のフォルダだけが残る
		await expect(folderRows).toHaveCount(1);
		await expect(folderRows.first().locator(".treeToggleIcon")).toHaveText("▶");

		await page.click("#projectExpandAllButton");
		await expect(folderRows).toHaveCount(2);
		await expect(folderRows.first().locator(".treeToggleIcon")).toHaveText("▼");
	});

	// 押しても意味がないときに押せると、効かないのか壊れているのか分からない
	test("フォルダが無いプロジェクトでは、展開・折りたたみは押せない", async ({page, request}) => {
		const empty = `空のPJ ${Date.now()}`;
		await request.post("api/projects", {headers: rw, data: {name: empty}});

		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${empty}")`);
		await expect(page.locator("#projectExpandAllButton")).toBeDisabled();
		await expect(page.locator("#projectCollapseAllButton")).toBeDisabled();
	});

	// 2つの列は「揃っていること」自体が意図なので、片方だけ変わったら気づけるようにする
	test("ツリーと文書一覧の幅が揃っている", async ({page}) => {
		await openInEditMode(page);

		const widths = await page.evaluate(() => ["sideBar", "projectTreePane"]
			.map((id) => Math.round(document.getElementById(id).getBoundingClientRect().width)));
		expect(widths[1], `文書一覧 ${widths[0]}px / ツリー ${widths[1]}px`).toBe(widths[0]);
	});

	// 常に出していると、ファイル名の幅を常時80pxほど奪って長い名前が読めなくなる
	test("行の操作ボタンは、マウスを乗せた行だけに出る", async ({page, request}) => {
		const name = `とても長いファイル名のサンプル_datasheet_reference_${Date.now()}.txt`;
		const doc = await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from("x")}}
		})).json();
		const projects = await (await request.get("api/projects", {headers: rw})).json();
		const target = projects.find((p) => p.name === PROJECT);
		await request.put(`api/projects/${target.id}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});

		await openInEditMode(page);
		const row = page.locator(".treeDocRow", {hasText: name.slice(0, 12)});
		await expect(row).toBeVisible();

		// 乗せる前は出ていない
		await expect(row.locator(".treeRowActions")).toBeHidden();
		// そのぶん名前が幅いっぱいを使える(行の幅とほぼ同じ)
		const widths = await row.evaluate((el) => ({
			row: el.clientWidth,
			name: el.querySelector(".treeDocName").clientWidth
		}));
		expect(widths.name, `名前 ${widths.name}px / 行 ${widths.row}px`).toBeGreaterThan(widths.row - 60);

		await row.hover();
		await expect(row.locator(".treeRowActions")).toBeVisible();
		// 乗せていない行には出ない
		const other = page.locator(".treeFolderRow", {hasText: "資料"});
		await expect(other.locator(".treeRowActions")).toBeHidden();
	});

	// 資料を開くのは読む操作なので、編集モードを開いていなくてもできる必要がある
	// (既定が表示モードになったため、ここが編集モード任せだと既定では一切開けない)
	test.describe("行から資料を別ウィンドウで開く", () => {
		const DRAWING = `別窓で開く図-${Date.now()}.drawio`;
		let drawingId;
		let drawingAlias;

		test.beforeAll(async ({request}) => {
			const xml = `<mxfile><diagram name="p1"><mxGraphModel><root>`
				+ `<mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;
			const doc = await (await request.post("api/documents", {
				headers: rw, multipart: {uploadfile: {name: DRAWING, mimeType: "application/xml", buffer: Buffer.from(xml)}}
			})).json();
			drawingId = doc.id;
			drawingAlias = doc.alias;
			const projects = await (await request.get("api/projects", {headers: rw})).json();
			const target = projects.find((p) => p.name === PROJECT);
			await request.put(`api/projects/${target.id}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});
		});

		const drawingRow = (page) => page.locator(".treeDocRow", {hasText: DRAWING.slice(0, 14)});


		test("表示モードでも出ていて、押すとその資料が別ウィンドウで開く", async ({page, context, request}) => {
			await page.goto("./");
			await page.click("#menuProjectsLink");
			await page.click(`.projectTab:has-text("${PROJECT}")`);
			// 編集モードにはしない(既定のまま)
			await expect(page.locator("#sideBar")).toBeHidden();

			const row = drawingRow(page);
			await row.hover();
			await expect(row.locator(".treeOpenWindowButton")).toBeVisible();
			// 構成を変えるボタンは出ていない
			await expect(row.locator(".treeDocUpButton")).toBeHidden();
			await expect(row.locator(".removeDocButton")).toBeHidden();

			const [win] = await Promise.all([
				context.waitForEvent("page"),
				row.locator(".treeOpenWindowButton").click()
			]);
			await win.waitForLoadState("domcontentloaded");
			// 開くのは**共有リンク(Alias)のURL**。開いた先のアドレスバーを見て貼る人がいるため、
			// 版のURLではなくこちらを出す。版のIDはURLに出てこないので、どの資料かはAliasの
			// 指す先で確かめる(.drawio は包むページ経由でビューアが描く)
			expect(win.url(), "共有リンクで開いていない").toContain(`alias=${drawingAlias}`);
			const pointed = await (await request.get(`api/documents/alias/${drawingAlias}`, {headers: rw})).json();
			expect(pointed.id, "別の資料が開いている").toBe(drawingId);
			await win.close();

			// 行そのもののクリック(プレビュー切り替え)は巻き込まない
			await expect(row).not.toHaveClass(/selected/);
		});

		test("編集モードにすると、並べ替え等と並んで出る", async ({page}) => {
			await openInEditMode(page);
			const row = drawingRow(page);
			await row.hover();
			await expect(row.locator(".treeOpenWindowButton")).toBeVisible();
			await expect(row.locator(".treeDocUpButton")).toBeVisible();
			await expect(row.locator(".removeDocButton")).toBeVisible();
		});
	});
});
