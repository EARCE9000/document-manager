/*!
 * projects.spec.js : プロジェクト単位の管理のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクト作成→一覧→文書の配置→ツリー確認→アーカイブ/削除を、readwriteキーで検証する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

test.describe.serial("プロジェクト管理", () => {
	let projectId;
	let documentId;

	test.beforeAll(async ({request}) => {
		// 配置用の文書を1つ用意する
		const res = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "proj-doc.txt", mimeType: "text/plain", buffer: Buffer.from("project document body")}}
		});
		documentId = (await res.json()).id;
	});

	test("readonlyキーではプロジェクト作成できない(403)", async ({request}) => {
		const res = await request.post("api/projects", {headers: ro, data: {name: "denied"}});
		expect(res.status()).toBe(403);
	});

	test("readwriteキーでプロジェクトを作成できる", async ({request}) => {
		const res = await request.post("api/projects", {headers: rw, data: {name: "  テストPJ  "}});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.id).toBeTruthy();
		expect(body.name).toBe("テストPJ"); // trimされる
		projectId = body.id;
	});

	test("一覧に作成したプロジェクトが含まれる", async ({request}) => {
		const list = await (await request.get("api/projects", {headers: rw})).json();
		expect(list.some((p) => p.id === projectId)).toBe(true);
	});

	test("プロジェクト直下に文書を配置してツリーに反映される", async ({request}) => {
		const place = await request.put(`api/projects/${projectId}/documents/${documentId}`, {headers: rw, data: {folderId: null}});
		expect(place.ok()).toBe(true);

		const tree = await (await request.get(`api/projects/${projectId}/tree`, {headers: rw})).json();
		expect(tree.documents.some((d) => d.documentId === documentId)).toBe(true);
	});

	test("アーカイブ→アーカイブ一覧に現れる", async ({request}) => {
		const res = await request.post(`api/projects/${projectId}/archive`, {headers: rw});
		expect(res.ok()).toBe(true);
		const archived = await (await request.get("api/projects/archived", {headers: rw})).json();
		expect(archived.some((p) => p.id === projectId)).toBe(true);
	});

	test("プロジェクトを削除できる(文書自体は残る)", async ({request}) => {
		const del = await request.delete(`api/projects/${projectId}`, {headers: rw});
		expect(del.status()).toBe(204);

		const list = await (await request.get("api/projects", {headers: rw})).json();
		expect(list.some((p) => p.id === projectId)).toBe(false);

		// プロジェクト削除後も文書一覧には残っている
		const docs = await (await request.get("api/documents", {headers: rw})).json();
		expect(docs.some((d) => d.id === documentId)).toBe(true);
	});
});
