/*!
 * session-revoke.e2e.js : 管理画面からの切断と、切られた側の画面
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 切断そのもの(セッション・APIキー・引換券・SSEが止まること)は session-revoke.spec.js で
 * 確かめている。ここで見るのは画面の話。
 *
 *   管理者の側 … 切るかどうかを判断できる材料が出ていること、押し間違えにくいこと、
 *                 切断ではできないこと(パスワードが漏れている場合)が書いてあること
 *                 (管理の画面 admin.html の「セッション」のタブ。中身はデザインテンプレートの admin.js が描く)
 *   切られた側 … 画面を奪われず、黙って壊れもしないこと。「切られた」とは伝えないこと
 *
 * 切断は取り消せないので、対象は serve.js が用意した専用の利用者(e2eVictim)にしている。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const {e2eVictim} = keys.revokeTargets;

const loginAs = (context, cookie) => context.addCookies([{name: keys.sessionCookieName, value: cookie, url: BASE_URL}]);
const openSessionsTab = async (page) => {
	await page.goto("./admin.html?tab=sessions");
	await expect(page.locator(".admin_sessions .session_card").first()).toBeVisible();
};
// victim@… と e2e-victim@… のように、一部が重なる利用者を取り違えないよう、名前の全体で当てる
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const cardOf = (page, user) => page.locator(".admin_sessions .session_card").filter({has: page.locator(".session_user", {hasText: exactly(user)})});
const panel = (page) => page.locator("#tab_sessions + .tab_label + .tab_panel");

test.describe.serial("セッションの切断(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await loginAs(context, keys.sessionCookie);
	});

	test("切るかどうかを判断できる材料が、利用者ごとに出る", async ({page}) => {
		await openSessionsTab(page);

		const card = cardOf(page, e2eVictim.user);
		await expect(card).toContainText("セッション 1 件 / APIキー 1 件");
		await expect(card.locator(".session_table tbody tr")).toHaveCount(1);
		await expect(card).toContainText("203.0.113.10");
		await expect(card).toContainText("TestBrowser/1.0");
		await expect(card).toContainText("key-of-e2e-victim");
		// 画面で行を見分ける必要はあるが、セッションIDそのものは出さない
		const sid = e2eVictim.cookies[0].slice(2).split(".")[0];
		expect(await page.content()).not.toContain(sid);
	});

	test("自分のセッションと、操作中の画面が見分けられる", async ({page}) => {
		await openSessionsTab(page);
		const mine = cardOf(page, keys.owner);
		await expect(mine.locator(".session_head .status_badge", {hasText: "自分"})).toBeVisible();
		await expect(mine.locator(".session_table .status_badge", {hasText: "この画面"})).toHaveCount(1);
		// この機能を入れる前からのログインは手がかりが無い。空欄にせず「不明」と出す
		await expect(mine.locator(".session_table .null_val").first()).toHaveText("不明");
	});

	// 切断しても、IDとパスワードが漏れていればまた入られる。押す前に目に入る場所に書く
	test("切断ではできないことが書いてある", async ({page}) => {
		await openSessionsTab(page);
		const caution = panel(page).locator(".panel_note");
		await expect(caution).toBeVisible();
		await expect(caution).toContainText("パスワード");
		await expect(caution).toContainText("IdP");
		await expect(caution).toContainText("台帳から外す");
		// APIキーが戻せないことも、押す前に分かること
		await expect(caution).toContainText("元に戻せない");
	});

	test("確認を挟み、やめれば何も起きない", async ({page}) => {
		await openSessionsTab(page);
		await cardOf(page, e2eVictim.user).locator("[data-revoke]").click();
		const modal = page.locator(".modal_box");
		await expect(modal).toContainText(e2eVictim.user);
		await expect(modal).toContainText("セッション 1 件と、APIキー 1 件");
		await expect(modal).toContainText("元に戻せない");

		await page.click("[data-ans=no]");
		await page.locator(".admin_sessions [data-act=reload]").click();
		await expect(cardOf(page, e2eVictim.user), "やめたのに切断されている").toBeVisible();
	});

	// 切られた側は、これまで何も起きなかった(一覧が更新されず、操作が黙って失敗するだけ)
	test("切断すると一覧から消えて履歴に残り、切られた側は画面を奪われずに知らされる", async ({page, browser}) => {
		// 切られる側が、画面を開いて作業している
		const victimContext = await browser.newContext();
		await loginAs(victimContext, e2eVictim.cookies[0]);
		const victimPage = await victimContext.newPage();
		try {
			await victimPage.goto(BASE_URL);
			await expect(victimPage.locator("#uploadDropZone")).toBeVisible();
			await expect(victimPage.locator("#sessionExpiredBar")).toBeHidden();
			const victimUrl = victimPage.url();

			await openSessionsTab(page);
			await cardOf(page, e2eVictim.user).locator("[data-revoke]").click();
			await page.click("[data-ans=yes]");

			// 管理者の側: 一覧から消え、履歴に残る
			await expect(page.locator(".admin_sessions [data-part=msg]")).toContainText(`「${e2eVictim.user}」を切断`);
			await expect(cardOf(page, e2eVictim.user)).toHaveCount(0);
			const row = page.locator(".admin_sessions [data-part=history] tbody tr", {hasText: e2eVictim.user}).first();
			await expect(row).toContainText(keys.owner);
			await expect(row).toContainText("セッション 1、APIキー 1");
			// 操作した管理者自身は、そのまま使えている
			await expect(page.locator("#sessionExpiredBar")).toBeHidden();

			// 切られた側: 帯が出る。画面は奪わない(書きかけのものを失わせない)
			await expect(victimPage.locator("#sessionExpiredBar"), "切られたのに何も起きない").toBeVisible({timeout: 15000});
			expect(victimPage.url()).toBe(victimUrl);
			await expect(victimPage.locator("#uploadDropZone")).toBeVisible();
			// 「管理者に切られた」とは伝えない(侵入者にも同じものが見えるため)
			const text = await victimPage.locator("#sessionExpiredBar").innerText();
			expect(text).not.toMatch(/管理者|切断/);

			// 押したときだけ、ログインへ移る
			const toLogin = victimPage.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/login"), {timeout: 15000});
			await victimPage.click("#sessionExpiredLoginButton");
			await toLogin;
		} finally {
			await victimContext.close();
		}
	});
});
