/*!
 * miro-layout-report.spec.js : 十字で書き出したらどうなるかの報告(layout-report)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro には触らず、プロジェクトの資料・フォルダ・タグだけから出せること(書き出していなくても出せる)を確かめる。
 * 細かい振り分けは test/miro-layout.test.js で見る。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
const STAMP = Date.now();

const upload = async (request, name, tags) => {
	const id = (await (await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(name)}}
	})).json()).id;
	if (tags) expect((await request.put(`api/documents/${id}/tags`, {headers: rw, data: {tags}})).status()).toBe(200);
	return id;
};

test.describe.serial("Miro の十字の報告", () => {
	let projectId;
	const ids = {};

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `並べ方の報告 ${STAMP}`}})).json()).id;
		const folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "設計"}})).json()).id;
		ids.design = await upload(request, `基本設計書-${STAMP}.md`, ["工程:基本設計"]);
		ids.api = await upload(request, `API一覧-${STAMP}.md`);
		ids.plan = await upload(request, `計画書-${STAMP}.md`, ["区分:管理", "工程:基本設計"]);
		ids.memo = await upload(request, `メモ-${STAMP}.txt`, ["工程:設計"]);
		await request.put(`api/projects/${projectId}/documents/${ids.design}`, {headers: rw, data: {folderId}});
		await request.put(`api/projects/${projectId}/documents/${ids.api}`, {headers: rw, data: {folderId}});
		await request.put(`api/projects/${projectId}/documents/${ids.plan}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${projectId}/documents/${ids.memo}`, {headers: rw, data: {folderId: null}});
	});

	test("タグ・推定・表に無い値・使われなかったタグを返す(読み取りの鍵で、書き出していなくても出せる)", async ({request}) => {
		const res = await request.get(`api/projects/${projectId}/miro/layout-report`, {headers: ro});
		expect(res.status()).toBe(200);
		const report = await res.json();
		expect(report.layout).toBe("cross");
		expect(report.summary.total).toBe(4);
		expect(report.summary.areas).toMatchObject({upper_left: 2, upper_right: 1, unclassified: 1});
		const byId = Object.fromEntries(report.placements.map((p) => [p.documentId, p]));
		expect(byId[ids.design]).toMatchObject({area: "upper_left", slot: "工程:基本設計", basis: "tag"});
		expect(byId[ids.api]).toMatchObject({area: "upper_left", slot: "工程:詳細設計", basis: "inferred", inferredTags: ["工程:詳細設計"], matchedWords: ["API"]});
		expect(report.unclassified).toEqual([expect.objectContaining({documentId: ids.memo, reason: "unknown_value"})]);
		expect(report.unknownValues[0]).toMatchObject({documentId: ids.memo, tag: "工程:設計"});
		expect(report.unknownValues[0].candidates).toEqual(expect.arrayContaining(["工程:基本設計", "工程:詳細設計"]));
		expect(report.overriddenTags).toEqual([expect.objectContaining({documentId: ids.plan, used: "区分:管理", ignored: ["工程:基本設計"]})]);
		expect(report.summary.unclassifiedRatio).toBe(0.25);
	});

	test("書き出す資料に絞れる(documentIds)。プロジェクトに無い資料・無いプロジェクトは 404", async ({request}) => {
		const report = await (await request.get(`api/projects/${projectId}/miro/layout-report?documentIds=${ids.plan},${ids.design}`, {headers: ro})).json();
		expect(report.summary.total).toBe(2);
		expect(report.placements.map((p) => p.documentId).sort()).toEqual([ids.plan, ids.design].sort());
		expect((await request.get(`api/projects/${projectId}/miro/layout-report?documentIds=no-such-doc`, {headers: ro})).status()).toBe(404);
		expect((await request.get("api/projects/no-such-project/miro/layout-report", {headers: ro})).status()).toBe(404);
	});
});

test("十字の振り分けで使う共通のタグを、決まった順で返す(機能: は入れない)", async ({request}) => {
	const res = await request.get("api/miro/layout-tags", {headers: ro});
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body.tags.slice(0, 3)).toEqual(["区分:管理", "区分:会議", "工程:要件定義"]);
	expect(body.tags).toContain("段階:実施後");
	expect(body.tags.at(-1)).toBe("会議:臨時");
	expect(body.tags.some((t) => t.startsWith("機能:"))).toBe(false);
	expect(body.values["対象外"]).toContain("運用");
});
