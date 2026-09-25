/*!
 * admin-pane.e2e.js : 管理ペイン(ページ切替+タブ)のE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * これまでモーダルだったアクセス許可ユーザー管理を、タブを持つページへ移した
 * (docs/admin-screen.md 参照)。ペインの出し入れと、移設した機能がそのまま動くことを確かめる。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const TEST_EMAIL = `e2e-admin-${Date.now()}@example.com`;

test.describe.serial("管理ペイン(実ブラウザ)", () => {
	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});

	// 入口は歯車1つ。ボタンを隠すのは見た目の話で、本当の境界はサーバー側のrequireAdmin
	// (それはAPIテストで確認している)。ここでは画面の出し分けを見る
	test("管理ボタンは管理を示すラベルを持つ", async ({page}) => {
		const button = page.locator("#allowedUsersManageLink");
		await expect(button).toBeVisible();
		await expect(button).toHaveAttribute("aria-label", "管理");
		await expect(button).toHaveAttribute("title", /管理/);
	});

	test("adminでなければ入口が出ず、管理ペインも開かない", async ({page}) => {
		// 管理者以外のログイン状態を作る(テストサーバーが払い出すセッションは管理者のみのため、
		// 認証情報の応答だけ差し替える)
		await page.route("**/api/check_access_token", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({user_identifier: "member@example.com", isAdmin: false, role: "readwrite", vectorSearchEnabled: false})
			});
		});
		await page.reload();
		await expect(page.locator("#uploadDropZone")).toBeVisible();

		await expect(page.locator("#allowedUsersManageLink")).toBeHidden();
		// 入口を通らずに開こうとしても、中身が何も取れない空のペインは見せない
		await page.evaluate(() => window.setView && window.setView("admin"));
		await expect(page.locator("#adminPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();
	});

	test("管理ボタンでページが切り替わり、文書一覧は隠れる", async ({page}) => {
		await expect(page.locator("#adminPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();

		await page.click("#allowedUsersManageLink");

		await expect(page.locator("#adminPane")).toBeVisible();
		// モーダルではなくページなので、文書一覧とプレビューは隠れる
		await expect(page.locator("#sideBar")).toBeHidden();
		await expect(page.locator("#previewArea")).toBeHidden();
		await expect(page.locator("#adminPaneHeaderRow h2")).toHaveText("管理");
	});

	test("戻るボタンで文書一覧へ戻れる", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await expect(page.locator("#adminPane")).toBeVisible();

		await page.click("#adminBackButton");

		await expect(page.locator("#adminPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();
	});

	test("タブが表示され、選択中のタブの内容だけが出る", async ({page}) => {
		await page.click("#allowedUsersManageLink");

		const tabs = page.locator(".adminTab");
		await expect(tabs).toHaveText(["アクセス許可ユーザー", "サーバー", "データベース", "変換サービス"]);
		await expect(tabs.first()).toHaveClass(/active/);

		// 選択中のパネルだけが見える
		await expect(page.locator("#allowedUserTable")).toBeVisible();
		await expect(page.locator("#serverStatusList")).toBeHidden();

		await page.click('.adminTab[data-tab="server"]');
		await expect(page.locator("#serverStatusList")).toBeVisible();
		await expect(page.locator("#allowedUserTable")).toBeHidden();
	});

	test("サーバータブに版と起動時刻が出る", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="server"]');

		const list = page.locator("#serverStatusList");
		await expect(list).toContainText("起動時刻");
		await expect(list).toContainText("稼働時間");
		await expect(list).toContainText("DBバックエンド");
		await expect(list).toContainText("sqlite");
		// 使用中のDBファイルが分かる(スキーマ移行後は旧ファイルも並ぶ)
		await expect(page.locator("#serverDbFilesWrap")).toContainText(".sqlite");
		await expect(page.locator("#serverDbFilesWrap")).toContainText("使用中");
	});

	test("データベースタブ: 開いただけでは検査せず、ボタンで確認できる", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="database"]');

		// 起動時の結果がまだ無い環境では「未確認」。検査は開いただけでは走らない
		const result = page.locator("#dbIntegrityResult");
		await expect(result).toBeVisible();

		await page.click("#dbIntegrityQuickButton");
		await expect(result.locator(".adminStatus")).toHaveText("問題なし");
		await expect(result).toContainText("簡易(索引の整合検査を省く)");
		await expect(result).toContainText("問題の件数");
	});

	// 照合は「消さない」ことが設計の要。画面の言葉と操作もそれに合わせている
	test("DBと実ファイルの照合が実行でき、削除の操作は置かれていない", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="database"]');

		await page.click("#reconcileScanButton");
		const result = page.locator("#reconcileResult");
		await expect(result.locator(".adminStatus")).toBeVisible();
		await expect(result).toContainText("実ファイルだけある");
		await expect(result).toContainText("DBにあるのにファイルが無い");
		// 欠損側は報告だけで、消す手段を出さない
		await expect(result).toContainText("記録は残したままにします");
		await expect(result.locator("button", {hasText: "削除"})).toHaveCount(0);
	});

	// 変換サービスは別コンテナで、落ちていてもアプリは動き続ける。
	// 「未設定」と「落ちている」は別物なので、画面でも区別できる必要がある
	test("変換サービスタブに状態と失敗一覧が出る", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="convert"]');

		const status = page.locator("#convertHealthResult .adminStatus");
		await expect(status).toBeVisible();
		// テスト環境はスタブへ接続しているため正常。いずれにせよ3状態のどれかが出る
		await expect(status).toHaveText(/正常|到達できません|未設定/);

		await expect(page.locator("#convertFailedWrap")).toBeVisible();
	});

	test("厳密確認は確認ダイアログを経てから実行される", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await page.click('.adminTab[data-tab="database"]');

		await page.click("#dbIntegrityFullButton");
		// サーバーが止まることを必ず知らせてから実行する
		await expect(page.locator("#confirmOverlay")).toBeVisible();
		await expect(page.locator("#confirmOverlay")).toContainText("サーバーの他の処理が止まります");
		await page.click("#confirmYesButton");

		await expect(page.locator("#dbIntegrityResult")).toContainText("厳密(索引と表の整合まで検査)");
	});

	test("移設したアクセス許可ユーザーの追加・ロール変更・削除がそのまま動く", async ({page}) => {
		await page.click("#allowedUsersManageLink");
		await expect(page.locator("#allowedUserTable")).toBeVisible();

		await test.step("追加できる", async () => {
			await page.fill("#allowedUserEmailInput", TEST_EMAIL);
			await page.selectOption("#allowedUserRoleInput", "readonly");
			await page.click("#allowedUserAddButton");
			await expect(page.locator("#allowedUserList", {hasText: TEST_EMAIL})).toBeVisible();
			// 入力欄は空に戻る
			await expect(page.locator("#allowedUserEmailInput")).toHaveValue("");
		});

		const row = page.locator("#allowedUserList tr", {hasText: TEST_EMAIL});

		await test.step("ロールを変更できる", async () => {
			await row.locator("select.allowedUserRoleSelect").selectOption("readwrite");
			// 一覧は再読み込みされる。変更後の値が残っていることを確認する
			await expect(page.locator("#allowedUserList tr", {hasText: TEST_EMAIL}).locator("select")).toHaveValue("readwrite");
		});

		await test.step("削除は確認ダイアログを経てから実行される", async () => {
			await row.locator("button.allowedUserRemoveButton").click();
			// 確認ダイアログは管理ペインの上に出る(モーダルの入れ子ではなくなった)
			await expect(page.locator("#confirmOverlay")).toBeVisible();
			await page.click("#confirmYesButton");
			await expect(page.locator("#allowedUserList tr", {hasText: TEST_EMAIL})).toHaveCount(0);
		});
	});
});
