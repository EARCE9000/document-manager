/*!
 * work-guides.spec.js : 作業の手引き(AI が作業を始める前に読む、資料の目次)の API
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * - 読むのは誰でも(閲覧のみの APIキーでも)。書くのは管理者だけ(AI が従う指示になるため)
 * - 全体共通と、プロジェクトごとの 2 段
 * - 中のリンク(共有の URL)は、新しい版を上げると自動で最新の版を指す
 * - 保存の前に、ありもしない URL・アーカイブ済み・版を固定した URL を見分けられる
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const ro = {Authorization: `Bearer ${keys.readonly}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const admin = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(keys.sessionCookie)}`};

const uploadText = async (request, name, body, previousId) => {
	const res = await request.post("api/documents", {
		headers: rw,
		multipart: {
			uploadfile: {name, mimeType: "text/markdown", buffer: Buffer.from(body)},
			...(previousId == null ? {} : {previousId})
		}
	});
	expect(res.status()).toBe(200);
	return res.json();
};
const aliasOf = async (request, id) => (await (await request.post(`api/documents/${id}/alias`, {headers: rw})).json()).alias;
const saveGuide = (request, scope, markdown) => request.put(`api/admin/work-guides/${encodeURIComponent(scope)}`, {headers: admin, data: {markdown}});

test.describe.serial("作業の手引き", () => {
	let rule;
	let ruleAlias;
	let project;

	test.beforeAll(async ({request}) => {
		rule = await uploadText(request, `コーディング規約-${Date.now()}.md`, "# コーディング規約\n\n- 変数名は英語");
		ruleAlias = await aliasOf(request, rule.id);
		project = await (await request.post("api/projects", {headers: rw, data: {name: `手引きの試験 ${Date.now()}`}})).json();
	});

	test.afterAll(async ({request}) => {
		await saveGuide(request, "global", "");
	});

	test("まだ書いていなければ、どちらも null", async ({request}) => {
		await saveGuide(request, "global", "");
		const res = await request.get(`api/work-guides?project=${project.id}`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(await res.json()).toEqual({global: null, project: {id: project.id, name: project.name, guide: null}});
	});

	test("書けるのは管理者だけ。APIキー(編集可でも)では書けない", async ({request}) => {
		expect((await request.put("api/admin/work-guides/global", {headers: rw, data: {markdown: "# 乗っ取り"}})).status()).toBe(403);
		expect((await request.put("api/admin/work-guides/global", {headers: ro, data: {markdown: "# 乗っ取り"}})).status()).toBe(403);
		expect((await request.post("api/admin/work-guides/check", {headers: rw, data: {markdown: ""}})).status()).toBe(403);
		expect((await request.get("api/admin/work-guides", {headers: rw})).status()).toBe(403);
		expect((await request.get("api/work-guides", {headers: ro})).status()).toBe(200);
		expect((await request.get("api/work-guides")).status()).toBe(401);
	});

	test("全体とプロジェクトの手引きを、閲覧のみのキーで読める。リンクはいまの文書を指す", async ({request}) => {
		const globalMarkdown = `## 開発するとき\n- 標準化のルール: [コーディング規約](https://dm.example.com/api/documents/alias/${ruleAlias}/viewer)\n`;
		const saved = await saveGuide(request, "global", globalMarkdown);
		expect(saved.status()).toBe(200);
		expect(await saved.json()).toMatchObject({scope: "global", name: "全体共通", status: "saved"});
		expect((await saveGuide(request, project.id, "## この案件の用語\n- 受注 = オーダー\n")).status()).toBe(200);

		const body = await (await request.get(`api/work-guides?project=${project.id}`, {headers: ro})).json();
		expect(body.global).toMatchObject({markdown: globalMarkdown, updatedBy: keys.owner});
		expect(body.global.links).toEqual([expect.objectContaining({
			kind: "alias", alias: ruleAlias, documentId: rule.id, entryFile: rule.entryFile, label: "コーディング規約", problem: null
		})]);
		expect(body.project).toMatchObject({id: project.id, name: project.name, guide: {markdown: "## この案件の用語\n- 受注 = オーダー\n", links: []}});

		// プロジェクトを指定しなければ全体だけ。知らないプロジェクトは 404
		expect((await (await request.get("api/work-guides", {headers: ro})).json()).project).toBeNull();
		expect((await request.get("api/work-guides?project=nope", {headers: ro})).status()).toBe(404);
	});

	test("資料を新しい版で上げ直すと、手引きを直さなくても新しい版を指す", async ({request}) => {
		const next = await uploadText(request, rule.entryFile, "# コーディング規約\n\n- 変数名は英語\n- 関数は短く", rule.id);
		const links = (await (await request.get("api/work-guides", {headers: ro})).json()).global.links;
		expect(links[0]).toMatchObject({alias: ruleAlias, documentId: next.id, problem: null});
		rule = next;
	});

	test("保存の前に、リンクを確かめられる(無い・アーカイブ済み・版を固定)", async ({request}) => {
		const archived = await uploadText(request, `古い規程-${Date.now()}.md`, "# 古い規程");
		const archivedAlias = await aliasOf(request, archived.id);
		expect((await request.delete(`api/documents/${archived.id}`, {headers: rw})).status()).toBeLessThan(300);

		const markdown = [
			`- [ある](api/documents/alias/${ruleAlias}/viewer)`,
			"- [ありもしない](https://dm.example.com/api/documents/alias/0123456789ab/viewer)",
			`- [アーカイブ済み](./api/documents/alias/${archivedAlias}/viewer)`,
			`- 版を固定: https://dm.example.com/api/documents/${rule.id}/viewer`,
			"- [関係の無いURL](https://example.com/)"
		].join("\n");
		const res = await request.post("api/admin/work-guides/check", {headers: admin, data: {markdown}});
		expect(res.status()).toBe(200);
		const problems = (await res.json()).links.map((link) => [link.label, link.problem]);
		expect(problems).toEqual([["ある", null], ["ありもしない", "not_found"], ["アーカイブ済み", "archived"], [null, "fixed_version"]]);
	});

	test("空で保存すると消える。長すぎるものと、知らない置き場所は断る", async ({request}) => {
		expect((await saveGuide(request, project.id, "   \n")).status()).toBe(200);
		expect((await (await request.get(`api/work-guides?project=${project.id}`, {headers: ro})).json()).project.guide).toBeNull();

		expect((await saveGuide(request, "global", "あ".repeat(20001))).status()).toBe(413);
		expect((await saveGuide(request, "no-such-project", "# x")).status()).toBe(404);
		expect((await request.put("api/admin/work-guides/global", {headers: admin, data: {}})).status()).toBe(400);
	});

	test("管理の画面の一覧に、書いてある置き場所が出る。変更は監査ログに残る", async ({request}) => {
		expect((await saveGuide(request, project.id, "## 試験\n")).status()).toBe(200);
		const list = await (await request.get("api/admin/work-guides", {headers: admin})).json();
		expect(list.maxLength).toBe(20000);
		expect(list.global).toMatchObject({updatedBy: keys.owner});
		expect(list.projects.find((p) => p.id === project.id)).toMatchObject({name: project.name, archived: false, guide: {length: "## 試験\n".length}});

		const audit = await (await request.get(`api/admin/audit?action=work_guide&target=${encodeURIComponent(project.name)}`, {headers: admin})).json();
		expect(audit.entries.length).toBeGreaterThanOrEqual(2);
		expect(audit.entries[0]).toMatchObject({user: keys.owner, action: "work_guide", target: project.name, result: "success", via: "screen"});
	});

	test("プロジェクトを消すと、その手引きも消える", async ({request}) => {
		expect((await request.delete(`api/projects/${project.id}`, {headers: rw})).status()).toBe(204);
		expect((await request.get(`api/admin/work-guides/${project.id}`, {headers: admin})).status()).toBe(404);
		const list = await (await request.get("api/admin/work-guides", {headers: admin})).json();
		expect(list.projects.some((p) => p.id === project.id)).toBe(false);
	});
});
