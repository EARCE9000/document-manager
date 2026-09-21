/*!
 * versions.spec.js : 新しい版としてのアップロード(旧版との紐付け)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * previousId付きアップロードで、旧版のアーカイブ・タグとプロジェクト配置(フォルダ・並び順)の
 * 引き継ぎ・版履歴(versions)・異常系(404/409)を検証する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const uploadText = (request, name, body, previousId) => request.post("api/documents", {
	headers: rw,
	multipart: {
		uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body)},
		...(previousId == null ? {} : {previousId})
	}
});

test.describe.serial("版の紐付け", () => {
	let projectId;
	let folderId;
	let v1Id;
	let v2Id;
	let siblingId;

	test.beforeAll(async ({request}) => {
		v1Id = (await (await uploadText(request, "仕様書_v1.txt", "version one")).json()).id;
		siblingId = (await (await uploadText(request, "別文書.txt", "sibling")).json()).id;
		await request.put(`api/documents/${v1Id}/tags`, {headers: rw, data: {tags: ["仕様", "顧客A"]}});

		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: "版テストPJ"}})).json()).id;
		folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "設計"}})).json()).id;
		// フォルダ内の並び: v1 → sibling の順
		await request.put(`api/projects/${projectId}/documents/${v1Id}`, {headers: rw, data: {folderId}});
		await request.put(`api/projects/${projectId}/documents/${siblingId}`, {headers: rw, data: {folderId}});
	});

	test("存在しない previousId は404で、新しい文書は登録されない", async ({request}) => {
		const before = (await (await request.get("api/documents", {headers: rw})).json()).length;
		const res = await uploadText(request, "仕様書_v2.txt", "x", "no-such-id");
		expect(res.status()).toBe(404);
		const after = (await (await request.get("api/documents", {headers: rw})).json()).length;
		expect(after).toBe(before);
	});

	test("readonlyキーでは新しい版をアップロードできない(403)", async ({request}) => {
		const res = await request.post("api/documents", {
			headers: ro,
			multipart: {uploadfile: {name: "仕様書_v2.txt", mimeType: "text/plain", buffer: Buffer.from("x")}, previousId: v1Id}
		});
		expect(res.status()).toBe(403);
	});

	test("previousId付きでアップロードすると旧版と紐付き、タグが引き継がれる", async ({request}) => {
		const res = await uploadText(request, "仕様書_v2.txt", "version two", v1Id);
		expect(res.status()).toBe(200);
		const body = await res.json();
		v2Id = body.id;
		expect(body.previousId).toBe(v1Id);
		expect(body.nextId).toBeNull();
		expect(body.tags).toEqual(["仕様", "顧客A"]);
	});

	test("旧版はアーカイブされ、新版を nextId として参照できる", async ({request}) => {
		const list = await (await request.get("api/documents", {headers: rw})).json();
		expect(list.some((d) => d.id === v1Id)).toBe(false);
		expect(list.find((d) => d.id === v2Id).previousId).toBe(v1Id);

		const trash = await (await request.get("api/documents/trash", {headers: rw})).json();
		expect(trash.find((d) => d.id === v1Id).nextId).toBe(v2Id);

		const old = await (await request.get(`api/documents/${v1Id}`, {headers: ro})).json();
		expect(old.archived).toBe(true);
		expect(old.nextId).toBe(v2Id);
		expect(old.tags).toEqual(["仕様", "顧客A"]); // 旧版のタグはそのまま残る
	});

	test("プロジェクトの配置(フォルダ・並び順)が新版へ引き継がれる", async ({request}) => {
		const tree = await (await request.get(`api/projects/${projectId}/tree`, {headers: rw})).json();
		const inFolder = tree.documents
			.filter((d) => d.folderId === folderId)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((d) => d.documentId);
		expect(inFolder).toEqual([v2Id, siblingId]);
	});

	test("既に新しい版がある旧版を指定すると409", async ({request}) => {
		const res = await uploadText(request, "仕様書_v2b.txt", "branch", v1Id);
		expect(res.status()).toBe(409);
		expect((await res.json()).nextId).toBe(v2Id);
	});

	test("版履歴はどの版から引いても古い順に同じ並びで返る", async ({request}) => {
		const v3 = await (await uploadText(request, "仕様書_v3.txt", "version three", v2Id)).json();
		for (const id of [v1Id, v2Id, v3.id]) {
			const versions = await (await request.get(`api/documents/${id}/versions`, {headers: ro})).json();
			expect(versions.map((v) => v.id)).toEqual([v1Id, v2Id, v3.id]);
			expect(versions.map((v) => v.archived)).toEqual([true, true, false]);
		}
	});

	test("紐付けの無い文書の版履歴は自分自身のみ", async ({request}) => {
		const versions = await (await request.get(`api/documents/${siblingId}/versions`, {headers: rw})).json();
		expect(versions.map((v) => v.id)).toEqual([siblingId]);
	});

	test("存在しない文書は404", async ({request}) => {
		expect((await request.get("api/documents/no-such-id", {headers: rw})).status()).toBe(404);
		expect((await request.get("api/documents/no-such-id/versions", {headers: rw})).status()).toBe(404);
	});

	test("操作履歴に旧版の置換が記録される", async ({request}) => {
		const history = await (await request.get("api/history", {headers: rw})).json();
		expect(history.some((h) => h.action === "supersede" && h.documentId === v1Id)).toBe(true);
	});
});
