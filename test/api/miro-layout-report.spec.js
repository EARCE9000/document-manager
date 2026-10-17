/*!
 * miro-layout-report.spec.js : 並べ方の型で並べたらどうなるかの報告(layout-report)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro には触らず、プロジェクトの資料・フォルダ・タグだけから出せること(連動していなくても出せる)を確かめる。
 * 型ごとの細かい振り分けは test/miro-layout.test.js で見る。
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

test.describe.serial("Miro の並べ方の報告", () => {
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

	test("十字型: タグ・推定・表に無い値・使われなかったタグを返す(読み取りの鍵で、連動していなくても出せる)", async ({request}) => {
		const res = await request.get(`api/projects/${projectId}/miro/layout-report?layout=quadrant-cross`, {headers: ro});
		expect(res.status()).toBe(200);
		const report = await res.json();
		expect(report.layout).toBe("quadrant-cross");
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

	test("型を省略するとフォルダ列型。フォルダに入っていない資料は「その他」列", async ({request}) => {
		const report = await (await request.get(`api/projects/${projectId}/miro/layout-report`, {headers: ro})).json();
		expect(report.layout).toBe("folder-columns");
		expect(report.summary.areas).toEqual({"設計": 2, "その他": 2});
		expect(report.notes.map((n) => n.kind)).toEqual(["no_folder", "no_folder"]);
		expect(report.unclassified).toBeUndefined();
	});

	test("知らない型は 400、無いプロジェクトは 404", async ({request}) => {
		expect((await request.get(`api/projects/${projectId}/miro/layout-report?layout=kanban`, {headers: ro})).status()).toBe(400);
		expect((await request.get("api/projects/no-such-project/miro/layout-report", {headers: ro})).status()).toBe(404);
	});
});
