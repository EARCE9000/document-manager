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
		await request.post(`api/projects/${project.id}/folders`, {headers: rw, data: {name: "資料"}});
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	const leftEdges = (page) => page.evaluate(() => {
		const rect = (id) => {
			const el = document.getElementById(id);
			const box = el.getBoundingClientRect();
			return {id, left: Math.round(box.left), visible: box.width > 0};
		};
		return ["sideBar", "projectTreePane", "previewArea"].map(rect);
	});

	test("編集中は 検索 → フォルダ構成 → プレビュー の順に並ぶ", async ({page}) => {
		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
		await expect(page.locator("#sideBar")).toBeVisible();

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
		const after = (await leftEdges(page)).find((b) => b.id === "sideBar").left;

		expect(after, `切り替えで検索欄が ${before}px → ${after}px へ動いた`).toBe(before);
	});

	// 施錠すると編集モードが解ける。そのときは一覧を出さず、ツリーとプレビューだけになる
	test("編集中でなければ、フォルダ構成とプレビューだけになる", async ({page, request}) => {
		const projects = await (await request.get("api/projects", {headers: rw})).json();
		const target = projects.find((p) => p.name === PROJECT);
		await request.post(`api/projects/${target.id}/lock`, {headers: rw});

		await page.goto("./");
		await page.click("#menuProjectsLink");
		await page.click(`.projectTab:has-text("${PROJECT}")`);
		await expect(page.locator("#projectTreePane")).toBeVisible();
		await expect(page.locator("#sideBar")).toBeHidden();

		const order = (await leftEdges(page)).filter((b) => b.visible).sort((a, b) => a.left - b.left).map((b) => b.id);
		expect(order).toEqual(["projectTreePane", "previewArea"]);

		await request.post(`api/projects/${target.id}/unlock`, {headers: rw});
	});
});
