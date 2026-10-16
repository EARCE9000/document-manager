/*!
 * skill-download-link.spec.js : Skill のZIPを、AIエージェントに取ってきてもらうURL
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 「登録依頼文をコピー」を押すと、短時間だけ・そのZIPにしか使えないURLが依頼文に入る。
 * AIはまだAPIキーを持たないので、このURLだけは認証なしで取れる。そのぶん、
 * 「そのZIP以外には使えない」「書き換え・使い回しが効かない」を、ここで固める。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const session = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const issue = async (request, skill, headers = session) => request.post(`api/skills/${skill}/download-link`, {headers});

test.describe("SkillのZIPを取ってくるURL", () => {
	let anonymous;
	test.beforeAll(async ({playwright}) => {
		anonymous = await playwright.request.newContext();
	});
	test.afterAll(async () => {
		await anonymous.dispose();
	});

	test("発行したURLは、ログインもAPIキーも無しでZIPを取れる", async ({request}) => {
		for (const [skill, fileName] of [["document-manager", "document-manager-skill.zip"], ["backlog", "backlog-skill.zip"]]) {
			const res = await issue(request, skill);
			expect(res.status(), skill).toBe(200);
			const link = await res.json();
			expect(link.fileName).toBe(fileName);
			expect(link.expiresInMinutes).toBe(30);
			// 保存名にそのまま使えるよう、URLの末尾がファイル名になっている
			expect(link.url).toMatch(new RegExp(`/api/skill-downloads/[^/]+/${fileName}$`));

			const zip = await anonymous.get(link.url);
			expect(zip.status(), skill).toBe(200);
			expect(zip.headers()["content-type"]).toBe("application/zip");
			const body = await zip.body();
			expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
			expect(body.includes(Buffer.from(`${skill}/SKILL.md`))).toBe(true);
			// 使い回せる(AIがダウンロードに失敗してやり直せるように)
			expect((await anonymous.get(link.url)).status()).toBe(200);
		}
	});

	test("APIキーでも発行できる(同じZIPは、キーがあれば直接取れるため)", async ({request}) => {
		expect((await issue(request, "backlog", rw)).status()).toBe(200);
	});

	test("認証なしでは発行できない", async () => {
		expect((await anonymous.post("api/skills/backlog/download-link")).status()).toBe(401);
	});

	test("配っていないSkillのURLは発行しない", async ({request}) => {
		for (const name of ["nothing", "..", "claude-skill"]) {
			expect((await issue(request, name)).status(), name).toBe(404);
		}
	});

	// URLは、そのZIPにしか使えない
	test("ファイル名を別のSkillに書き換えても取れない", async ({request}) => {
		const link = await (await issue(request, "backlog")).json();
		const swapped = link.url.replace(/backlog-skill\.zip$/, "document-manager-skill.zip");
		expect((await anonymous.get(swapped)).status()).toBe(401);
	});

	test("券を書き換えたURL・でたらめな券では取れない", async ({request}) => {
		const link = await (await issue(request, "backlog")).json();
		const token = link.url.match(/skill-downloads\/([^/]+)\//)[1];
		const tampered = link.url.replace(token, `${token.slice(0, -2)}AA`);
		expect((await anonymous.get(tampered)).status()).toBe(401);
		expect((await anonymous.get("api/skill-downloads/not-a-token/backlog-skill.zip")).status()).toBe(401);
		// 断るときは、次に何をすればよいかを返す(AIが利用者に伝えられるように)
		expect((await (await anonymous.get(tampered)).json()).error).toContain("コピーし直して");
	});

	test("これまでの取得方法(ログインして直接取る)も、そのまま使える", async ({request}) => {
		expect((await request.get("api/claude-skill.zip", {headers: rw})).status()).toBe(200);
		expect((await request.get("api/related-skills/backlog.zip", {headers: rw})).status()).toBe(200);
	});
});
