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

// プロジェクトの説明(空でもよい。Miro の十字のレイアウトの中心のカードに出す)
test.describe.serial("プロジェクトの説明", () => {
	let projectId;

	test("作成のときに説明を付けられ、一覧・1 件の取得に載る", async ({request}) => {
		const res = await request.post("api/projects", {headers: rw, data: {name: `説明つき${Date.now()}`, description: "  受注管理の再構築\r\n2026 年度  "}});
		expect(res.status()).toBe(200);
		const project = await res.json();
		projectId = project.id;
		expect(project.description).toBe("受注管理の再構築\n2026 年度");
		const list = await (await request.get("api/projects", {headers: ro})).json();
		expect(list.find((p) => p.id === projectId).description).toBe("受注管理の再構築\n2026 年度");
	});

	test("説明だけ・名前だけを変えられ、空文字で消せる。どちらも無ければ 400、長すぎれば 400", async ({request}) => {
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		let res = await request.put(`api/projects/${projectId}`, {headers: rw, data: {description: "説明を変えた"}});
		expect(res.status()).toBe(200);
		const changed = await res.json();
		expect(changed.description).toBe("説明を変えた");
		res = await request.put(`api/projects/${projectId}`, {headers: rw, data: {name: `名前を変えた${Date.now()}`}});
		expect((await res.json()).description, "名前だけ変えても説明は残る").toBe("説明を変えた");
		res = await request.put(`api/projects/${projectId}`, {headers: rw, data: {description: "   "}});
		expect((await res.json()).description).toBeNull();
		expect((await request.put(`api/projects/${projectId}`, {headers: rw, data: {}})).status()).toBe(400);
		expect((await request.put(`api/projects/${projectId}`, {headers: rw, data: {description: "あ".repeat(2001)}})).status()).toBe(400);
		expect((await request.put(`api/projects/${projectId}`, {headers: ro, data: {description: "x"}})).status()).toBe(403);
	});

	test("説明の無いプロジェクトは description が null", async ({request}) => {
		const project = await (await request.post("api/projects", {headers: rw, data: {name: `説明なし${Date.now()}`}})).json();
		expect(project.description).toBeNull();
	});
});
