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
		await page.locator("#claudeSkillCopyPromptButton").click();
		const prompt = await page.evaluate(() => navigator.clipboard.readText());
		expect(prompt).toContain("APIキーは私に尋ねないでください");
		expect(prompt).toContain(`setup --base-url ${new URL("./", page.url()).href}`);
		expect(prompt).toContain("あなたは実行しないでください");
		// 以前の「キーを確認してから保存して」は残っていない
		expect(prompt).not.toContain("APIキーはこのあと私に確認してから");
	});

	test("手順には、入力欄にキーを貼ることと、チャットに貼らないことが書いてある", async ({page}) => {
		const steps = page.locator("#claudeSkillSteps");
		await expect(steps).toContainText("入力欄が出たら");
		await expect(steps).toContainText("APIキーはチャットに貼らないでください");
		// 自分で登録したい人向けのコマンドも出る(展開先に合わせたパス)
		await expect(page.locator("#claudeSkillManual")).toContainText("~/.claude/skills/document-manager/scripts/dm_client.py setup --base-url");
	});

	test("関連するSkillとして、BacklogのSkillをダウンロードできる", async ({page}) => {
		await expect(page.locator("#toolCardBacklog")).toContainText("Backlog");
		const downloadPromise = page.waitForEvent("download");
		await page.locator("#backlogSkillDownloadLink").click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("backlog-skill.zip");
		const zip = require("node:fs").readFileSync(await download.path());
		expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(zip.includes(Buffer.from("backlog/SKILL.md"))).toBe(true);
	});

	test("Backlogの登録依頼文も、キーを尋ねさせない。Backlogのキーであることが分かる", async ({page}) => {
		await page.locator("#backlogSkillCopyPromptButton").click();
		const prompt = await page.evaluate(() => navigator.clipboard.readText());
		expect(prompt).toContain("backlog-skill.zip");
		expect(prompt).toContain("APIキーは私に尋ねないでください");
		expect(prompt).toContain("backlog_client.py の setup --space");
		// Document Manager のキーと取り違えないこと
		await expect(page.locator("#backlogSkillSteps")).toContainText("Document Manager のAPIキーとは別のもの");
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
