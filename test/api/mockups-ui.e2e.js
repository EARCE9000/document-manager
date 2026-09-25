/*!
 * mockups-ui.e2e.js : モックアップ管理の画面を実ブラウザ(Chromium)で通しで検証するE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 画面から ZIPをアップロード → 一覧に出る → 別ウィンドウで開く → 検索 → メモ・改名 →
 * 新しい版で置き換え → 過去の版で辿る → アーカイブ・復元 まで通す。
 *
 * 「別ウィンドウで開く」は必ず入口(`/view`)から開く必要がある(引換券つきのURLへ転送される)。
 * 画面が直接ファイルのURLを組み立ててしまうと券が無く401になるため、開いた先のウィンドウで
 * 中身が本当に描画されるところまで確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const zlib = require("zlib");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

/* ---- テスト用のZIPを組み立てる(他のモックアップのテストと同じ手法) ---- */
const buildZip = (entries) => {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const {name, data} of entries) {
		const nameBuf = Buffer.from(name, "utf-8");
		const payload = zlib.deflateRawSync(data, {level: 9});
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + payload.length;
	}
	const localPart = Buffer.concat(locals);
	const centralPart = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
};

const t = (value) => Buffer.from(value, "utf-8");

// JSがDOMを組み立てる作りにしておく。開いた先で中身が出れば、券つきの配信が通っている証拠になる
const site = (label) => buildZip([
	{name: "index.html", data: t('<html><head><meta charset="utf-8">'
		+ '<link rel="stylesheet" href="./assets/style.css"></head>'
		+ '<body><div id="app">まだ描画されていません</div>'
		+ '<script src="./app.js"></script></body></html>')},
	{name: "app.js", data: t(`document.getElementById("app").textContent = "${label}";`)},
	{name: "assets/style.css", data: t("#app { color: rgb(0, 128, 0); }")}
]);

const NAME_V1 = `E2E画面モックアップ ${Date.now()}`;
const NAME_V2 = `${NAME_V1} v2`;
const RENAMED = `${NAME_V1} 改名後`;

const card = (page, name) => page.locator(".mockupCard", {hasText: name});

test.describe.serial("モックアップ管理の画面(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("アップロード→一覧→別ウィンドウで開く→検索→メモ→改名", async ({page}) => {
		await test.step("メニューからモックアップへ切り替えられる", async () => {
			await page.goto("./");
			await expect(page.locator("#menuMockupsLink")).toBeVisible();
			await page.click("#menuMockupsLink");
			await expect(page.locator("#mockupPane")).toBeVisible();
			// 文書一覧・プレビューは引っ込む(別のコレクションなので混ぜない)
			await expect(page.locator("#sideBar")).toBeHidden();
			await expect(page.locator("#previewArea")).toBeHidden();
		});

		await test.step("ZIPをアップロードすると一覧に出る", async () => {
			await page.click("#mockupUploadOpenButton");
			await expect(page.locator("#mockupUploadOverlay")).toBeVisible();
			await page.setInputFiles("#mockupZipInput", {name: "e2e-ui.zip", mimeType: "application/zip", buffer: site("v1が描画された")});
			await page.fill("#mockupNameInput", NAME_V1);
			// アップロード直後は開いた確認をしたいので、新しいウィンドウが開く
			const [opened] = await Promise.all([
				page.context().waitForEvent("page"),
				page.click("#mockupUploadSubmitButton")
			]);
			await expect(page.locator("#mockupUploadOverlay")).toBeHidden();
			await expect(card(page, NAME_V1)).toBeVisible();

			// ここが要点。入口から開いているため引換券つきのURLになり、中のJSが動く
			await expect(opened.locator("#app")).toHaveText("v1が描画された");
			expect(opened.url(), "券つきのURLで開いている").toMatch(/\/view\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/);
			await opened.close();
		});

		await test.step("ファイル数・容量・入口が見える", async () => {
			await expect(card(page, NAME_V1).locator(".mockupCardMeta")).toContainText("3ファイル");
			await expect(card(page, NAME_V1).locator(".mockupCardMeta")).toContainText("index.html");
		});

		await test.step("カードの「開く」からも同じように開ける", async () => {
			const [opened] = await Promise.all([
				page.context().waitForEvent("page"),
				card(page, NAME_V1).locator('[data-action="open"]').first().click()
			]);
			await expect(opened.locator("#app")).toHaveText("v1が描画された");
			// 隔離されている(オリジンを持たない)
			await expect(opened.locator("#app")).toBeVisible();
			expect(await opened.evaluate(() => String(window.origin))).toBe("null");
			await opened.close();
		});

		await test.step("中のHTMLのテキストで検索できる", async () => {
			await page.fill("#mockupFilterInput", NAME_V1.slice(0, 14));
			await expect(card(page, NAME_V1)).toBeVisible();
			await page.fill("#mockupFilterInput", `存在しない語 ${Date.now()}`);
			await expect(page.locator("#mockupEmptyMessage")).toBeVisible();
			await page.fill("#mockupFilterInput", "");
			await expect(card(page, NAME_V1)).toBeVisible();
		});

		await test.step("メモを書ける", async () => {
			await card(page, NAME_V1).locator('[data-action="memo"]').click();
			await expect(page.locator("#mockupMemoOverlay")).toBeVisible();
			await page.fill("#mockupMemoInput", "ここの配色だけ見てほしい");
			await page.click("#mockupMemoSaveButton");
			await expect(page.locator("#mockupMemoOverlay")).toBeHidden();
			await expect(card(page, NAME_V1).locator(".mockupCardMemo")).toHaveText("ここの配色だけ見てほしい");
		});

		await test.step("名前を変えられる", async () => {
			await card(page, NAME_V1).locator('[data-action="rename"]').click();
			await page.fill("#promptInput", RENAMED);
			await page.click("#promptOkButton");
			await expect(card(page, RENAMED)).toBeVisible();
		});
	});

	test("新しい版で置き換えると、旧版は過去の版へ移る", async ({page}) => {
		await page.goto("./");
		await page.click("#menuMockupsLink");
		await expect(card(page, RENAMED)).toBeVisible();

		await card(page, RENAMED).locator('[data-action="revise"]').click();
		await expect(page.locator("#mockupUploadOverlay")).toBeVisible();
		// 置き換え先が分かるように出す(取り違えると旧版がアーカイブされてしまう)
		await expect(page.locator("#mockupUploadTarget")).toContainText(RENAMED);
		await page.setInputFiles("#mockupZipInput", {name: "e2e-ui-v2.zip", mimeType: "application/zip", buffer: site("v2が描画された")});
		await page.fill("#mockupNameInput", NAME_V2);
		const [opened] = await Promise.all([
			page.context().waitForEvent("page"),
			page.click("#mockupUploadSubmitButton")
		]);
		await expect(opened.locator("#app")).toHaveText("v2が描画された");
		await opened.close();

		// 現役の一覧は新版だけになる
		await expect(card(page, NAME_V2)).toBeVisible();
		await expect(card(page, RENAMED)).toHaveCount(0);

		// 版履歴からは両方辿れる
		await card(page, NAME_V2).locator('[data-action="versions"]').click();
		const versions = card(page, NAME_V2).locator(".mockupVersionList li");
		await expect(versions).toHaveCount(2);
		await expect(versions.nth(0)).toContainText(RENAMED);
		await expect(versions.nth(1)).toContainText(NAME_V2);

		// 旧版は「過去の版」で見られて、そこからも開ける
		await page.click("#mockupArchiveToggleButton");
		await expect(card(page, RENAMED)).toBeVisible();
		const [oldWindow] = await Promise.all([
			page.context().waitForEvent("page"),
			card(page, RENAMED).locator('[data-action="open"]').first().click()
		]);
		await expect(oldWindow.locator("#app")).toHaveText("v1が描画された");
		await oldWindow.close();
	});

	test("アーカイブして元に戻せる", async ({page}) => {
		await page.goto("./");
		await page.click("#menuMockupsLink");
		await card(page, NAME_V2).locator('[data-action="archive"]').click();
		await page.click("#confirmYesButton");
		await expect(card(page, NAME_V2)).toHaveCount(0);

		await page.click("#mockupArchiveToggleButton");
		await expect(card(page, NAME_V2)).toBeVisible();
		await card(page, NAME_V2).locator('[data-action="restore"]').click();
		await expect(card(page, NAME_V2)).toHaveCount(0);

		await page.click("#mockupArchiveToggleButton");
		await expect(card(page, NAME_V2)).toBeVisible();
	});

	test("壊れたZIPはモーダルの中で理由が出る(画面は壊れない)", async ({page}) => {
		await page.goto("./");
		await page.click("#menuMockupsLink");
		await page.click("#mockupUploadOpenButton");
		await page.setInputFiles("#mockupZipInput", {name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("これはZIPではありません")});
		await page.click("#mockupUploadSubmitButton");
		await expect(page.locator("#mockupUploadStatus")).toHaveClass(/error/);
		await expect(page.locator("#mockupUploadStatus")).not.toBeEmpty();
		// やり直せる(ボタンが押せないままにならない)
		await expect(page.locator("#mockupUploadSubmitButton")).toBeEnabled();
		await page.click("#mockupUploadCancelButton");
		await expect(page.locator("#mockupUploadOverlay")).toBeHidden();
	});
});
