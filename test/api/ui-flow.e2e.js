/*!
 * ui-flow.e2e.js : 主要UIフロー(アップロード→検索→タグ付け→プレビュー→APIキー取得・動作)を
 *                  実ブラウザ(Chromium)で通しで検証するE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * OIDCを省略したテストサーバ(serve.js)には対話的ログインが無いため、serve.jsが払い出した
 * 管理者(owner)のログイン済みセッションcookie(.auth-keys.jsonのsessionCookie)をブラウザへ
 * 注入してから操作する。認証は有効なままなので、UI操作の裏で実際のrequireAuth/requireWrite/
 * requireAdminやAPIキー認証がそのまま働く(APIキーの「動作」まで本物で検証できる)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`(playwright.config.jsのe2eプロジェクト)。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
// このスペックで作成する文書名(検索・プレビュー・タグ付けの対象)。実行ごとに一意にする
const DOC_NAME = `e2e-flow-${Date.now()}.html`;
const DOC_HTML = "<!DOCTYPE html><html><head><title>e2e</title></head><body><h1>E2E本文サンプル</h1></body></html>";
const TAG_NAME = `e2eタグ${Date.now()}`;

test.describe.serial("主要UIフロー(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		// 管理者のログイン済みセッションを注入する(OIDCを経由せずログイン状態を再現)
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("アップロード→検索→タグ付け→プレビュー→APIキー取得・動作", async ({page, request}) => {
		await test.step("ログイン済みで管理者としてアプリが開く", async () => {
			await page.goto("./");
			// 認証OK時のみ表示される要素(アップロード領域・APIキー管理)が出ることでログイン済みを確認
			await expect(page.locator("#uploadDropZone")).toBeVisible();
			await expect(page.locator("#apiKeyManageLink")).toBeVisible();
		});

		await test.step("ファイルをアップロードできる", async () => {
			// 隠しfile input(display:none)へ直接ファイルを渡すとchangeハンドラでアップロードされる
			await page.setInputFiles("#uploadfile", {name: DOC_NAME, mimeType: "text/html", buffer: Buffer.from(DOC_HTML)});
			// アップロード完了後、一覧に該当文書が現れる
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
		});

		await test.step("検索で見つかる(ファイル名の部分一致)", async () => {
			await page.fill("#filterInput", DOC_NAME.slice(0, 12));
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
			// 検索欄を戻す(後続でタグ検索を行うため)
			await page.fill("#filterInput", "");
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
		});

		await test.step("プレビューが表示される", async () => {
			await page.locator("#documentList li", {hasText: DOC_NAME}).click();
			await expect(page.locator("#previewTitle")).toHaveText(DOC_NAME);
			const frame = page.locator("#previewFrame");
			await expect(frame).toBeVisible();
			await expect(frame).toHaveAttribute("src", /api\/documents\/.+\/file$/);
		});

		await test.step("タグを付けられる", async () => {
			await page.locator("#previewTagEditButton").click();
			await expect(page.locator("#tagEditOverlay")).toBeVisible();
			await page.fill("#tagEditInput", TAG_NAME);
			await page.press("#tagEditInput", "Enter");
			await expect(page.locator("#tagEditChips", {hasText: TAG_NAME})).toBeVisible();
			await page.locator("#tagSaveButton").click();
			await expect(page.locator("#tagEditOverlay")).toBeHidden();
			// 付けたタグで検索してヒットすること(タグ検索の確認も兼ねる)
			await page.fill("#filterInput", TAG_NAME);
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
			await page.fill("#filterInput", "");
		});

		await test.step("APIキーを発行でき、そのキーで実際にAPIが動作する", async () => {
			await page.locator("#apiKeyManageLink").click();
			await expect(page.locator("#apiKeyOverlay")).toBeVisible();
			await page.selectOption("#apiKeyRoleInput", "readwrite");
			await page.locator("#apiKeyCreateButton").click();
			// 発行直後にだけ表示される平文キーを取得する
			const rawKey = (await page.locator(".apiKeyValue").textContent())?.trim();
			expect(rawKey).toMatch(/^dm_/);
			// 一覧にも1件現れる
			await expect(page.locator("#apiKeyList li").first()).toBeVisible();

			// 取得した平文キーで実際にAPIを叩けること(認証有効なので本物の検証になる)
			const apiRes = await request.get("api/documents", {headers: {Authorization: `Bearer ${rawKey}`}});
			expect(apiRes.status()).toBe(200);
			expect(Array.isArray(await apiRes.json())).toBe(true);
		});

		await test.step("後始末(作成した文書をアーカイブ)", async () => {
			// UI操作の副作用を残さないよう、readwriteキーでアーカイブしておく
			const list = await (await request.get("api/documents", {headers: {Authorization: `Bearer ${keys.readwrite}`}})).json();
			const created = list.find((d) => d.entryFile === DOC_NAME);
			if (created) {
				await request.delete(`api/documents/${created.id}`, {headers: {Authorization: `Bearer ${keys.readwrite}`}});
			}
		});
	});

	// .drawio(実体)とプレビュー画像(svg)を同時に選択→フロントのペア判定で previewfile として
	// 送信→一覧表示・DRAWIOバッジ・svgプレビュー・.drawio実体のダウンロードまでを実ブラウザで通す
	test(".drawio+プレビュー画像の同時アップロードとプレビュー表示", async ({page, request}) => {
		const drawioName = `e2e-${Date.now()}.drawio`;
		const svgName = `e2e-${Date.now()}.svg`;
		const drawioXml = `<mxfile><diagram name="E2E構成図" id="p1"><mxGraphModel><root>`
			+ `<mxCell id="2" value="E2Eドローアイオーラベル" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#e8590c"/></svg>`;

		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();

		await test.step("2ファイル選択で.drawioを実体・svgをプレビューとして送信できる", async () => {
			await page.setInputFiles("#uploadfile", [
				{name: drawioName, mimeType: "application/xml", buffer: Buffer.from(drawioXml)},
				{name: svgName, mimeType: "image/svg+xml", buffer: Buffer.from(svg)}
			]);
			const li = page.locator("#documentList li", {hasText: drawioName});
			await expect(li).toBeVisible();
			// 拡張子バッジが DRAWIO になる
			await expect(li.locator(".docTag")).toHaveText("DRAWIO");
		});

		await test.step("svgプレビューが表示され、ダウンロードは.drawio実体を指す", async () => {
			await page.locator("#documentList li", {hasText: drawioName}).click();
			await expect(page.locator("#previewTitle")).toHaveText(drawioName);
			const frame = page.locator("#previewFrame");
			await expect(frame).toBeVisible();
			await expect(frame).toHaveAttribute("src", /api\/documents\/.+\/file$/);
			// ダウンロードリンクは元ファイル(.drawio)を返す ?download=1
			await expect(page.locator("#downloadLink")).toHaveAttribute("href", /api\/documents\/.+\/file\?download=1$/);
		});

		await test.step("XMLラベルが全文検索でヒットする", async () => {
			await page.fill("#filterInput", "E2Eドローアイオーラベル");
			await expect(page.locator("#documentList li", {hasText: drawioName})).toBeVisible();
			await page.fill("#filterInput", "");
		});

		await test.step("後始末(作成した文書をアーカイブ)", async () => {
			const list = await (await request.get("api/documents", {headers: {Authorization: `Bearer ${keys.readwrite}`}})).json();
			const created = list.find((d) => d.entryFile === drawioName);
			if (created) {
				await request.delete(`api/documents/${created.id}`, {headers: {Authorization: `Bearer ${keys.readwrite}`}});
			}
		});
	});
});
