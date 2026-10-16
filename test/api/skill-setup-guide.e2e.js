/*!
 * skill-setup-guide.e2e.js : Skillの登録手順(APIキーをチャットに貼らない)と、関連するSkill(Backlog)の配布
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 以前の登録依頼文は「APIキーはこのあと私に確認してから保存して」と、エージェントにキーを尋ねさせていた。
 * チャットに貼られたキーは、会話の記録やログなど利用者の手を離れた場所に残る。いまは、
 * エージェントが示すコマンドを利用者が実行し、出てきた入力欄にキーを貼る(画面には表示されない)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();

test.describe("Skillの登録手順と、関連するSkill(実ブラウザ)", () => {
	test.beforeEach(async ({context, page}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("./");
		await page.locator("#apiKeyManageLink").click();
		await expect(page.locator("#apiKeyOverlay")).toBeVisible();
	});

	// この変更の要
	test("登録依頼文は、エージェントにAPIキーを尋ねさせず、利用者が実行するコマンドを示させる", async ({page}) => {
		await page.locator("#claudeSkillBox summary").click();
		await page.locator("#claudeSkillCopyPromptButton").click();
		const prompt = await page.evaluate(() => navigator.clipboard.readText());
		expect(prompt).toContain("APIキーは私に尋ねないでください");
		expect(prompt).toContain(`setup --base-url ${new URL("./", page.url()).href}`);
		expect(prompt).toContain("あなたは実行しないでください");
		// 以前の「キーを確認してから保存して」は残っていない
		expect(prompt).not.toContain("APIキーはこのあと私に確認してから");
	});

	test("手順には、入力欄にキーを貼ることと、チャットに貼らないことが書いてある", async ({page}) => {
		await page.locator("#claudeSkillBox summary").click();
		const steps = page.locator("#claudeSkillSteps");
		await expect(steps).toContainText("入力欄が出たら");
		await expect(steps).toContainText("APIキーはチャットに貼らないでください");
		// 自分で登録したい人向けのコマンドも出る(展開先に合わせたパス)
		await expect(page.locator("#claudeSkillManual")).toContainText("~/.claude/skills/document-manager/scripts/dm_client.py setup --base-url");
	});

	test("関連するSkillとして、BacklogのSkillをダウンロードできる", async ({page}) => {
		await page.locator("#relatedSkillBox summary").click();
		await expect(page.locator("#relatedSkillBox")).toContainText("Backlog");
		const downloadPromise = page.waitForEvent("download");
		await page.locator("#backlogSkillDownloadLink").click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("backlog-skill.zip");
		const zip = require("node:fs").readFileSync(await download.path());
		expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(zip.includes(Buffer.from("backlog/SKILL.md"))).toBe(true);
	});

	test("Backlogの登録依頼文も、キーを尋ねさせない。Backlogのキーであることが分かる", async ({page}) => {
		await page.locator("#relatedSkillBox summary").click();
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
		await page.locator("#claudeSkillBox summary").click();
		await page.locator("#relatedSkillBox summary").click();
		const expectedDirs = {claude: "~/.claude/skills", codex: "~/.agents/skills", antigravity: "~/.gemini/config/skills"};
		for (const [agent, dir] of Object.entries(expectedDirs)) {
			await page.locator(`#claudeSkillBox .skillAgentTab[data-agent="${agent}"]`).click();
			await expect(page.locator("#backlogSkillSteps")).toContainText(`${dir}/backlog/`);
			await expect(page.locator("#backlogSkillManual")).toContainText(`-d ${dir}/`);
		}
	});
});
