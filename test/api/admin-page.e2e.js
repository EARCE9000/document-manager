/*!
 * admin-page.e2e.js : 管理の画面(admin.html)の E2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 管理の画面は、共通アーキテクチャ(画面 8 章)の形にそろえた別のページ。
 * 共通のタブ(利用者 → セッション → 監査ログ → サーバー)はデザインテンプレートの admin.js が、
 * 独自のタブ(データベース・変換サービス・Miro 連携)は admin-page.js が描く。
 * ここでは、入口・タブの並び・それぞれのタブで操作できることを、実ブラウザで確かめる。
 * WebAPI の形は admin-api.spec.js、切断は session-revoke.e2e.js、Miro 連携は miro-admin.e2e.js。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const TEST_EMAIL = `e2e-admin-${Date.now()}@example.com`;

const openAdmin = async (page, tab) => {
	await page.goto(`./admin.html${tab ? `?tab=${tab}` : ""}`);
	await expect(page.locator("#adminBody")).toBeVisible();
};
const panelOf = (page, tab) => page.locator(`#tab_${tab} + .tab_label + .tab_panel`);

test.describe.serial("管理の画面(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	// 入口は右上の歯車だけ。隠すのは見た目の話で、本当の境界はサーバーの requireAdmin(admin-api.spec.js)
	test("入口は右上の歯車で、管理の画面(admin.html)へのリンク", async ({page}) => {
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		const gear = page.locator("#allowedUsersManageLink");
		await expect(gear).toHaveAttribute("aria-label", "管理");
		await expect(gear).toHaveAttribute("href", "./admin.html");
		// 文書一覧の中に管理のペインは、もう無い
		await expect(page.locator("#adminPane")).toHaveCount(0);

		await gear.click();
		await expect(page).toHaveURL(/\/admin\.html/);
		await expect(page.locator(".item_title .title")).toHaveText("管理");
		await page.click("#adminBackLink");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
	});

	test("管理者でなければ、歯車が出ず、管理の画面も中身を出さない", async ({page}) => {
		// テストサーバーが払い出すセッションは管理者なので、認証の応答だけ差し替える
		await page.route("**/api/check_access_token", (route) => route.fulfill({
			status: 200, contentType: "application/json",
			body: JSON.stringify({user_identifier: "member@example.com", isAdmin: false, role: "readwrite", vectorSearchEnabled: false})
		}));
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await expect(page.locator("#allowedUsersManageLink")).toBeHidden();

		const apiCalls = [];
		page.on("request", (request) => {
			if (/\/api\/(admin|server-status)/.test(request.url())) apiCalls.push(request.url());
		});
		await page.goto("./admin.html");
		await expect(page.locator("#adminGate")).toContainText("管理者だけ");
		await expect(page.locator("#adminBody")).toBeHidden();
		// 共通のスクリプトは読み込まない(管理の WebAPI を呼ばない)
		expect(apiCalls).toEqual([]);
	});

	test("ログインしていなければ、戻り先つきでログインの画面へ移る", async ({browser}) => {
		const context = await browser.newContext({baseURL: `${BASE_URL}/`});
		const page = await context.newPage();
		try {
			const toLogin = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/login"));
			await page.goto("./admin.html?tab=audit");
			const request = await toLogin;
			expect(new URL(request.url()).searchParams.get("next")).toBe("/admin.html?tab=audit");
		} finally {
			await context.close();
		}
	});

	test("ページはスクリプトを自分のファイルだけに絞る(CSP)", async ({request}) => {
		const res = await request.get("admin.html");
		expect(res.status()).toBe(200);
		expect(res.headers()["content-security-policy"]).toContain("script-src 'self'");
	});

	test("タブは共通の 4 つ(利用者 → セッション → 監査ログ → サーバー)、区切りの後ろに独自の 3 つ。?tab= で開ける", async ({page}) => {
		await openAdmin(page);
		await expect(page.locator(".tab_label")).toHaveText(["利用者", "セッション", "監査ログ", "サーバー", "データベース", "変換サービス", "Miro 連携"]);
		await expect(page.locator(".tab_label.custom_first")).toHaveText("データベース");
		await expect(page.locator("#tab_users")).toBeChecked();
		await expect(panelOf(page, "users")).toBeVisible();
		await expect(panelOf(page, "server")).toBeHidden();

		// 切り替えると URL に残り、再読み込みしても同じタブが開く
		await page.click("label[for=tab_server]");
		await expect(page).toHaveURL(/tab=server/);
		await page.reload();
		await expect(page.locator("#tab_server")).toBeChecked();
		await expect(panelOf(page, "server")).toBeVisible();
	});

	// 認証を切って(AUTH_DISABLED)動いているときは、どの画面でも見て分かるようにする(共通アーキテクチャ 認証 2.6)。
	// 本番で誤って有効になっていたときに、開いた人が最初に気づくための物でもある
	test("開発モードのときは、ロゴの横のしるし・ヘッダーの色・タブの題名で分かる。ふだんは出ない", async ({page}) => {
		// ふだん(認証あり。試験のサーバーは認証を有効にして動いている)
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await expect(page.locator("#devModeBadge")).toBeHidden();
		await expect(page).toHaveTitle("Document Manager");
		await openAdmin(page);
		// 管理の画面は、デザインテンプレートの部品(.dev_mode_badge・.header.dev_mode・dev_mode.js)
		await expect(page.locator(".dev_mode_badge")).toBeHidden();
		await expect(page.locator(".header")).not.toHaveClass(/dev_mode/);
		await expect(page).toHaveTitle("管理 | Document Manager");

		// 開発モード: サーバーが authDisabled: true を返す(画面はホスト名などから推測しない)
		await page.route("**/api/check_access_token", async (route) => {
			const res = await route.fetch();
			await route.fulfill({response: res, json: {...(await res.json()), user_identifier: "dev-user", authDisabled: true}});
		});
		await page.goto("./");
		await expect(page.locator("#devModeBadge")).toBeVisible();
		await expect(page.locator("#devModeBadge")).toHaveText("開発モード");
		await expect(page.locator("#topBar")).toHaveClass(/devMode/);
		await expect(page).toHaveTitle("【開発モード】Document Manager");
		await openAdmin(page);
		await expect(page.locator(".dev_mode_badge")).toBeVisible();
		await expect(page.locator(".dev_mode_badge")).toHaveText("開発モード");
		await expect(page.locator(".header")).toHaveClass(/dev_mode/);
		// しるしは題字の外(題字の文字に混ざらない)
		await expect(page.locator(".header_title")).toHaveText("Document Manager");
		await expect(page).toHaveTitle("【開発モード】管理 | Document Manager");
	});

	// 日付だけの表記だと、同じ日に何度も出したときにどれが動いているのか分からない
	test("画面右下の版は YYYYMMDD.HHMM で出る", async ({page}) => {
		await page.route("**/api/version", (route) => route.fulfill({
			status: 200, contentType: "application/json",
			body: JSON.stringify({version: "20261013.0930", build: "20261013.0930", revision: "0123456789abcdef", builtAt: "2026-10-13T00:30:00Z"})
		}));
		await page.goto("./");
		await expect(page.locator("#footerVersion")).toHaveText("Ver.20261013.0930");
	});

	test("利用者: 追加・権限の変更・削除ができ、監査ログに残る", async ({page}) => {
		await openAdmin(page, "users");
		const users = page.locator(".admin_users");
		await expect(users.locator("[data-part=count]")).toContainText("人");

		await test.step("追加できる", async () => {
			await users.locator("[data-part=email]").fill(TEST_EMAIL);
			await users.locator("[data-part=role]").selectOption("readonly");
			await users.locator("button[type=submit]").click();
			await expect(users.locator("[data-part=msg]")).toContainText(`「${TEST_EMAIL}」を追加`);
			await expect(users.locator("tr", {hasText: TEST_EMAIL})).toContainText("閲覧のみ");
		});
		const row = users.locator("tr", {hasText: TEST_EMAIL});

		await test.step("権限を変えられる", async () => {
			await row.locator("[data-edit]").click();
			await row.locator("select").selectOption("readwrite");
			await row.locator("[data-ok]").click();
			await expect(users.locator("tr", {hasText: TEST_EMAIL})).toContainText("編集可");
		});

		await test.step("自分の行には削除が無い", async () => {
			// 「追加した人」の欄にも自分が出るので、メールアドレスの欄で探す
			const mine = users.locator("tbody tr").filter({has: page.locator("td:first-child", {hasText: keys.owner})});
			await expect(mine).toHaveCount(1);
			await expect(mine.locator("[data-del]")).toHaveCount(0);
		});

		await test.step("削除は確認を挟む", async () => {
			await row.locator("[data-del]").click();
			await expect(page.locator(".modal_box")).toContainText(TEST_EMAIL);
			await page.click("[data-ans=yes]");
			await expect(users.locator("tr", {hasText: TEST_EMAIL})).toHaveCount(0);
		});

		await test.step("監査ログで、追加・変更・削除を探せる", async () => {
			await page.click("label[for=tab_audit]");
			const audit = page.locator(".admin_audit");
			await audit.locator("[data-part=target]").fill(TEST_EMAIL);
			await audit.locator("button[type=submit]").click();
			await expect(audit.locator("tbody tr")).toHaveCount(3);
			await expect(audit.locator("tbody")).toContainText("利用者の追加");
			await expect(audit.locator("tbody")).toContainText("権限の変更");
			await expect(audit.locator("tbody")).toContainText("利用者の削除");
			await expect(audit.locator("tbody tr").first()).toContainText("Success");
			await expect(audit.locator("tbody tr").first()).toContainText("画面");
		});
	});

	test("サーバー: このサーバー・接続の確認・セキュリティ設定・部品の版が出る", async ({page}) => {
		await openAdmin(page, "server");
		const server = page.locator(".admin_server");
		await expect(server.locator("[data-part=status]")).toContainText("起動日時");
		await expect(server.locator("[data-part=status]")).toContainText("sqlite");
		await expect(server.locator("[data-part=dbfiles]")).toContainText("使用中");
		const connections = server.locator("[data-part=connections]");
		await expect(connections.locator("tr", {hasText: "データベース"})).toContainText("Connected");
		await expect(connections.locator("tr", {hasText: "IdP"})).toContainText("Not set");
		// 試験では回数の上限を切っているので、赤い行で出る
		await expect(server.locator("[data-part=security] tr.row_failed", {hasText: "API の回数の上限"})).toBeVisible();
		await expect(server.locator("[data-part=components]")).toContainText("Node.js");
		await server.locator("[data-part=q]").fill("express");
		await expect(server.locator("[data-part=packages]")).toContainText("「express」を含む部品");
	});

	test("サーバー: 回数の上限を、その場で変えて、既定に戻せる", async ({page}) => {
		await openAdmin(page, "server");
		const server = page.locator(".admin_server");
		await server.locator("[data-rate=anonymous]").fill("555");
		await server.locator("[data-rate-save=anonymous]").click();
		await expect(server.locator("[data-rate-note=anonymous]")).toContainText("この画面で変更");
		await expect(server.locator("[data-rate=anonymous]")).toHaveValue("555");

		// 画面で変えた行にだけ「既定に戻す」が出て、確認を挟んで戻せる
		await expect(server.locator("[data-rate-reset=authenticated]")).toHaveCount(0);
		await server.locator("[data-rate-reset=anonymous]").click();
		await expect(page.locator(".modal_box")).toContainText("回数の上限を戻す");
		await page.click("[data-ans=yes]");
		await expect(server.locator("[data-rate=anonymous]")).toHaveValue("300");
		await expect(server.locator("[data-rate-note=anonymous]")).not.toContainText("この画面で変更");
		await expect(server.locator("[data-rate-reset=anonymous]")).toHaveCount(0);
	});

	// サーバーのタブは相手へ問い合わせる(数秒掛かることがある)。見ていないときには走らせない
	test("共通のタブは、開いたときに初めて読む(?tab= で開いたタブは、すぐ読む)", async ({page}) => {
		const calls = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (url.pathname.includes("/api/")) calls.push(url.pathname.replace(/^.*\/api\//, ""));
		});
		await openAdmin(page, "users");
		await expect(page.locator(".admin_users [data-part=count]")).toContainText("人");
		expect(calls).toContain("admin/users");
		expect(calls.filter((c) => c.startsWith("server-status") || c.startsWith("admin/audit") || c.startsWith("admin/sessions"))).toEqual([]);

		await page.click("label[for=tab_server]");
		await expect(page.locator(".admin_server [data-part=connections]")).toContainText("Connected");
		expect(calls).toContain("server-status/components");
		expect(calls.filter((c) => c.startsWith("admin/audit"))).toEqual([]);

		// ?tab= で(JS から)選んだタブも読む
		calls.length = 0;
		await openAdmin(page, "audit");
		await expect(page.locator(".admin_audit [data-part=count]")).toContainText("件");
		expect(calls.some((c) => c.startsWith("admin/audit"))).toBe(true);
		expect(calls.filter((c) => c.startsWith("server-status") || c === "admin/users")).toEqual([]);
	});

	// 機能の On/Off は、文書一覧のメニューにすぐ効かないと「効いたのか」が分からない
	test("サーバー: モックアップの機能を切り替えると、文書一覧のメニューに効く", async ({page}) => {
		await page.goto("./");
		await expect(page.locator("#menuMockupsLink")).toBeVisible();

		await openAdmin(page, "server");
		const toggle = page.locator(".admin_server tr", {hasText: "モックアップ"}).locator("input[data-feature]");
		await expect(toggle).toBeChecked();
		await toggle.evaluate((input) => input.click());
		await expect(page.locator(".admin_server tr", {hasText: "モックアップ"})).toContainText("保存済み");
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		await expect(page.locator("#menuMockupsLink")).toBeHidden();

		await openAdmin(page, "server");
		await page.locator(".admin_server tr", {hasText: "モックアップ"}).locator("input[data-feature]").evaluate((input) => input.click());
		await expect(page.locator(".admin_server tr", {hasText: "モックアップ"})).toContainText("保存済み");
		await page.goto("./");
		await expect(page.locator("#menuMockupsLink")).toBeVisible();
	});

	test("データベース: 開いただけでは検査せず、ボタンで確認できる。厳密な確認は確認を挟む", async ({page}) => {
		await openAdmin(page, "database");
		const result = page.locator("#dbIntegrityResult");
		await expect(result.locator(".status_badge")).toBeVisible();

		await page.click("#dbIntegrityQuickButton");
		await expect(result.locator(".status_badge")).toHaveText("問題なし");
		await expect(result).toContainText("簡易(索引の整合検査を省く)");
		await expect(result).toContainText("問題の件数");

		await page.click("#dbIntegrityFullButton");
		// サーバーが止まることを必ず知らせてから実行する
		await expect(page.locator(".modal_box")).toContainText("サーバーのほかの処理が止まる");
		await page.click("[data-ans=yes]");
		await expect(result).toContainText("厳密(索引と表の整合まで検査)");
	});

	// 照合は「消さない」ことが設計の要。画面の言葉と操作もそれに合わせている
	test("データベース: 実ファイルとの照合ができ、削除の操作は置かない", async ({page}) => {
		await openAdmin(page, "database");
		await page.click("#reconcileScanButton");
		const result = page.locator("#reconcileResult");
		await expect(result.locator(".status_badge").first()).toBeVisible();
		await expect(result).toContainText("実ファイルだけある");
		await expect(result).toContainText("DB にあるのにファイルが無い");
		await expect(result).toContainText("記録は残したままにする");
		await expect(result.locator("button", {hasText: "削除"})).toHaveCount(0);
	});

	// 変換サービスは別のコンテナで、落ちていてもアプリは動き続ける。「未設定」と「落ちている」を分けて出す
	test("変換サービス: 2 つの変換サービスの状態と、失敗した文書の一覧が出る", async ({page}) => {
		await openAdmin(page, "convert");
		await expect(page.locator("#convertHealthResult .status_badge")).toHaveText(/Connected|Error|Not set/);
		await expect(page.locator("#convertFailedWrap table")).toBeVisible();
		await expect(page.locator("#pdfHealthResult .status_badge")).toHaveText("Connected");
		await expect(page.locator("#pdfHealthResult")).toContainText("Chromium");
		await expect(page.locator("#pdfHealthDrawio")).toHaveText("対応");
	});
});
