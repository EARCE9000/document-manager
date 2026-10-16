/*!
 * skill-setup-guide.e2e.js : Skillの登録手順(APIキーをチャットに貼らない)と、関連するSkill(Backlog)の配布
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 以前の登録依頼文は「APIキーはこのあと私に確認してから保存して」と、エージェントにキーを尋ねさせていた。
 * チャットに貼られたキーは、会話の記録やログなど利用者の手を離れた場所に残る。いまは、
 * エージェントが示すコマンドを利用者が実行し、出てきた入力欄にキーを貼る(画面には表示されない)。
 *
 * Skill の配布は「APIキー管理」の中から、独立した「ツール」のページへ移した(Document Manager 以外の
 * サービス用も配るようになり、キーの画面に置く理由がなくなったため)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

// 依頼文は、取得用のURLを発行してからコピーする(非同期)。コピーし終わるまで待って読む
const copiedPrompt = async (page, buttonSelector, marker = "Skillとして登録してください") => {
	await page.evaluate(() => navigator.clipboard.writeText(""));
	await page.locator(buttonSelector).click();
	await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain(marker);
	return page.evaluate(() => navigator.clipboard.readText());
};

test.describe("ツールのページ: Skillの登録手順と配布(実ブラウザ)", () => {
	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("./");
		await page.locator("#menuToolsLink").click();
		await expect(page.locator("#toolsPane")).toBeVisible();
	});

	// この変更の要
	test("登録依頼文は、エージェントにAPIキーを尋ねさせず、利用者が実行するコマンドを示させる", async ({page}) => {
		const prompt = await copiedPrompt(page, "#claudeSkillCopyPromptButton");
		expect(prompt).toContain("APIキーは私に尋ねないでください");
		expect(prompt).toContain(`setup --base-url ${new URL("./", page.url()).href}`);
		expect(prompt).toContain("あなたは実行しないでください");
		// 以前の「キーを確認してから保存して」は残っていない
		expect(prompt).not.toContain("APIキーはこのあと私に確認してから");
	});

	test("手順には、入力欄にキーを貼ることと、チャットに貼らないことが書いてある", async ({page}) => {
		const steps = page.locator("#claudeSkillSteps");
		await expect(steps).toContainText("入力欄が出たら");
		// 依頼文を貼るのが先。キーは入力欄が出てから発行し、そのまま貼る(手元に控えておく時間を作らない)
		const items = await steps.locator("li").allTextContents();
		expect(items[0]).toContain("登録依頼文をコピー");
		expect(items[1]).toContain("APIキーを発行");
		await expect(steps).toContainText("APIキーはチャットに貼らないでください");
		// 自分で登録したい人向けのコマンドも出る(展開先に合わせたパス)
		await expect(page.locator("#claudeSkillManual")).toContainText("~/.claude/skills/document-manager/scripts/dm_client.py setup --base-url");
	});

	test("関連するSkillとして、BacklogのSkillをダウンロードできる", async ({page}) => {
		await expect(page.locator("#toolCardBacklog")).toContainText("Backlog");
		await page.locator("#toolCardBacklog .toolSteps summary").click();
		const downloadPromise = page.waitForEvent("download");
		await page.locator("#backlogSkillDownloadLink").click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("backlog-skill.zip");
		const zip = require("node:fs").readFileSync(await download.path());
		expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(zip.includes(Buffer.from("backlog/SKILL.md"))).toBe(true);
	});

	test("Backlogの登録依頼文も、キーを尋ねさせない。Backlogのキーであることが分かる", async ({page}) => {
		const prompt = await copiedPrompt(page, "#backlogSkillCopyPromptButton");
		expect(prompt).toContain("backlog-skill.zip");
		expect(prompt).toContain("APIキーは私に尋ねないでください");
		expect(prompt).toContain("backlog_client.py の setup --space");
		// Document Manager のキーと取り違えないこと
		await expect(page.locator("#backlogSkillSteps")).toContainText("Document Manager のAPIキーとは別のもの");
	});

	// ZIPを保存して添付する手間をなくす。依頼文に入ったURLから、AIがキー無しで取れること
	test("依頼文には、ZIPを取ってくるためのURLが入り、そのURLはログイン無しで取れる", async ({page, browser}) => {
		for (const [button, fileName] of [["#claudeSkillCopyPromptButton", "document-manager-skill.zip"], ["#backlogSkillCopyPromptButton", "backlog-skill.zip"]]) {
			const prompt = await copiedPrompt(page, button);
			expect(prompt).toContain(`次のURLから ${fileName} をダウンロードして`);
			expect(prompt).toContain("30分で使えなくなります");
			const url = prompt.match(/https?:\/\/\S+\/api\/skill-downloads\/\S+/)[0];
			expect(url.endsWith(`/${fileName}`)).toBe(true);

			// ログインしていないブラウザ(=AIエージェントの立場)から取れる
			const context = await browser.newContext();
			try {
				const res = await context.request.get(url);
				expect(res.status(), fileName).toBe(200);
				expect((await res.body()).subarray(0, 2).toString("latin1")).toBe("PK");
			} finally {
				await context.close();
			}
		}
	});

	test("押すたびに新しいURLになる(押した時点から期限が始まる)", async ({page}) => {
		const first = await copiedPrompt(page, "#backlogSkillCopyPromptButton");
		await page.waitForTimeout(1100);
		const second = await copiedPrompt(page, "#backlogSkillCopyPromptButton");
		const urlOf = (text) => text.match(/\/api\/skill-downloads\/\S+/)[0];
		expect(urlOf(second)).not.toBe(urlOf(first));
	});

	test("URLを発行できないときは、ZIPを添付してもらう依頼文に戻し、ZIPの保存場所へ案内する", async ({page}) => {
		await page.route("**/api/skills/*/download-link", (route) => route.fulfill({status: 500, json: {error: "x"}}));
		const dialogMessage = new Promise((resolve) => {
			page.once("dialog", async (dialog) => {
				resolve(dialog.message());
				await dialog.accept();
			});
		});
		const prompt = await copiedPrompt(page, "#backlogSkillCopyPromptButton");
		expect(prompt).toContain("添付した backlog-skill.zip を");
		expect(prompt).not.toContain("skill-downloads");
		expect(await dialogMessage).toContain("SkillのZIPをダウンロード");
		// 行き止まりにしない: ZIPの保存場所が開いて見えている
		await expect(page.locator("#backlogSkillDownloadLink")).toBeVisible();
	});

	// ふだんの手順は「依頼文をコピーして貼る」だけ。ZIPの保存は手順の中の逃げ道として置く
	test("カードの前面にはZIPのダウンロードを置かず、手順の中の「自分で渡す場合」に置く", async ({page}) => {
		for (const card of ["#toolCardDocumentManager", "#toolCardBacklog"]) {
			await expect(page.locator(`${card} .claudeSkillActions a[download]`)).toHaveCount(0);
			await expect(page.locator(`${card} .toolSteps a[download]`)).toHaveCount(1);
			await expect(page.locator(`${card} .toolSteps`)).toContainText("ZIPを自分で渡す場合");
		}
	});

	// どのエージェント向けかは、上のSkill案内のタブで選ぶ(2か所で選ばせない)
	test("エージェントのタブを切り替えると、Backlogの手順の展開先も切り替わる", async ({page}) => {
		const expectedDirs = {claude: "~/.claude/skills", codex: "~/.agents/skills", antigravity: "~/.gemini/config/skills"};
		for (const [agent, dir] of Object.entries(expectedDirs)) {
			await page.locator(`#toolsPane .skillAgentTab[data-agent="${agent}"]`).click();
			await expect(page.locator("#backlogSkillSteps")).toContainText(`${dir}/backlog/`);
			await expect(page.locator("#backlogSkillManual")).toContainText(`-d ${dir}/`);
		}
	});

	test("メニューの「ツール」で開き、文書一覧とプレビューは隠れる", async ({page}) => {
		await expect(page.locator("#menuToolsLink")).toHaveClass(/active/);
		await expect(page.locator("#sideBar")).toBeHidden();
		await expect(page.locator("#previewArea")).toBeHidden();
		// 文書一覧へ戻れる
		await page.locator("#menuDocumentsLink").click();
		await expect(page.locator("#toolsPane")).toBeHidden();
		await expect(page.locator("#sideBar")).toBeVisible();
	});

	// 手元のものが古くないかを見比べられるように
	test("カードの見出しの横に、配っているSkillの版が出る", async ({page, request}) => {
		const {skills} = await (await request.get("api/skills", {headers: {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`}})).json();
		const versionOf = (name) => skills.find((skill) => skill.name === name).version;
		await expect(page.locator("#toolCardDocumentManager .toolVersion")).toHaveText(`v${versionOf("document-manager")}`);
		await expect(page.locator("#toolCardBacklog .toolVersion")).toHaveText(`v${versionOf("backlog")}`);
	});

	test("Document Manager のカードから、APIキーの発行画面を開ける", async ({page}) => {
		await page.locator("#toolsOpenApiKeyButton").click();
		await expect(page.locator("#apiKeyOverlay")).toBeVisible();
		await expect(page.locator("#apiKeyCreateButton")).toBeVisible();
	});

	test("APIキー管理からは Skill の欄が無くなり、ツールへ案内する", async ({page}) => {
		await page.locator("#menuDocumentsLink").click();
		await page.locator("#apiKeyManageLink").click();
		await expect(page.locator("#apiKeyOverlay")).toBeVisible();
		await expect(page.locator("#apiKeyModalBox #claudeSkillDownloadLink")).toHaveCount(0);
		await page.locator("#apiKeyGoToolsButton").click();
		await expect(page.locator("#apiKeyOverlay")).toBeHidden();
		await expect(page.locator("#toolsPane")).toBeVisible();
	});

	// Skill は閲覧だけの権限でも使える(検索・ダウンロードはできるため)。入口を隠さない
	test("閲覧だけの権限でも、ツールのメニューが出る", async ({page}) => {
		await page.route("**/api/check_access_token", async (route) => {
			const res = await route.fetch();
			await route.fulfill({response: res, json: {...(await res.json()), isAdmin: false, role: "readonly"}});
		});
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeHidden();
		await expect(page.locator("#menuToolsLink")).toBeVisible();
		// 閲覧だけの権限で隠れるベクトル索引・アーカイブの代わりに、右寄せの起点になる
		await expect(page.locator("#menuVectorIndexLink")).toBeHidden();
		await page.locator("#menuToolsLink").click();
		await expect(page.locator("#toolsPane")).toBeVisible();
	});
});
