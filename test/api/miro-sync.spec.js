/*!
 * miro-sync.spec.js : プロジェクトの資料を Miro のボードへ並べ、出しっぱなしのあいだ変更を反映する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro には代わりのサーバー(miro-stub.js)を使い、置かれた項目(種類・位置・枠・題名)を直接見て確かめる。
 * PDF への変換は、変換サービスの代わり(converter-stub.js)が最小の PDF を返す。
 *
 * 確かめること:
 *   - 連動を始めると、プロジェクトの枠を作り、フォルダごとの見出しを付けて資料を並べる
 *   - 形式ごとの出し方(PDF・画像・HTML/Markdown/draw.io は PDF に・出せない形式は理由つきで出さない)
 *   - 新しい版は、人が動かした位置・大きさのまま中身だけ差し替える
 *   - Miro で消されたものは勝手に戻さない・増えた資料は下に足す・外れた/アーカイブされた資料は見出しで知らせる
 *   - 出す/出さないを資料ごとに選べる・連動をやめられる(ボードに残す/資料を消す)
 *   - Miro の一時的な失敗はやり直す
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");
const {CLIENT_ID, CLIENT_SECRET} = require("./miro-stub.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
const STUB_URL = `http://127.0.0.1:${process.env.MIRO_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 20}`;
const BOARD = "uXjVStubBoard1=";
const STAMP = Date.now();

const control = async (request, body) => (await request.post(`${STUB_URL}/__control`, {data: body})).json();
const boardItems = async (request) => (await (await request.get(`${STUB_URL}/__items`)).json()).filter((i) => i.boardId === BOARD);

// 最小の PDF(縦長の A4)と PNG
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/yWWk2QAAAABJRU5ErkJggg==", "base64");

const upload = async (request, name, buffer, previousId) => {
	const multipart = {uploadfile: {name, mimeType: "application/octet-stream", buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf-8")}};
	if (previousId) multipart.previousId = previousId;
	const res = await request.post("api/documents", {headers: rw, multipart});
	expect(res.status(), name).toBe(200);
	return res.json();
};

const connectMiro = async (request) => {
	await request.put("api/miro/credentials", {headers: admin, data: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET}});
	const start = await request.get("api/miro/connect", {headers: admin, maxRedirects: 0});
	const back = await request.get(start.headers().location, {maxRedirects: 0});
	await request.get(back.headers().location, {headers: admin, maxRedirects: 0});
	expect((await request.put("api/miro/settings", {headers: admin, data: {boardId: BOARD}})).status()).toBe(200);
};

/** 裏で動く同期が終わるのを待って、状態を返す */
const settled = async (request, projectId) => {
	let status;
	await expect.poll(async () => {
		status = await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();
		return status.syncing;
	}, {timeout: 15000}).toBe(false);
	return status;
};
/** 変更の通知からの反映(少しまとめてから動く)を待つ */
const waitFor = async (request, projectId, predicate) => {
	let status;
	await expect.poll(async () => {
		status = await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();
		return !status.syncing && predicate(status);
	}, {timeout: 15000}).toBe(true);
	return status;
};
const itemOf = (status, documentId) => status.items.find((i) => i.documentId === documentId);

test.describe.serial("プロジェクトの資料を Miro に出す", () => {
	let projectId;
	const docs = {};

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		await connectMiro(request);

		const project = await (await request.post("api/projects", {headers: rw, data: {name: `Miro連動${STAMP}`}})).json();
		projectId = project.id;
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		const folder = await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件定義"}})).json();

		docs.pdf = await upload(request, `仕様書${STAMP}.pdf`, PDF);
		docs.png = await upload(request, `画面${STAMP}.png`, PNG);
		docs.html = await upload(request, `概要${STAMP}.html`, "<!DOCTYPE html><html><body><h1>概要</h1></body></html>");
		docs.md = await upload(request, `議事録${STAMP}.md`, "# 議事録\n\n本文\n");
		docs.drawio = await upload(request, `構成図${STAMP}.drawio`, '<mxfile><diagram id="p" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
		docs.txt = await upload(request, `メモ${STAMP}.txt`, "テキスト");
		for (const [key, doc] of Object.entries(docs)) {
			const folderId = key === "html" || key === "md" ? folder.id : null;
			expect((await request.put(`api/projects/${projectId}/documents/${doc.id}`, {headers: rw, data: {folderId}})).status(), key).toBe(200);
		}
	});

	test.afterAll(async ({request}) => {
		await request.delete(`api/projects/${projectId}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("連動していないうちは、出せる状態かどうかだけが分かる", async ({request}) => {
		const status = await (await request.get(`api/projects/${projectId}/miro`, {headers: ro})).json();
		expect(status).toMatchObject({available: true, linked: false, state: null});
	});

	test("連動を始めると、プロジェクトの枠を作り、形式ごとに出し方を変えて並べる", async ({request}) => {
		const res = await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		expect(res.status()).toBe(202);
		const status = await settled(request, projectId);
		expect(status).toMatchObject({linked: true, lastError: null});
		expect(status.frameUrl).toContain("moveToWidget=");
		expect(status.counts).toMatchObject({placed: 5, skipped: 1});

		const items = await boardItems(request);
		const frame = items.find((i) => i.type === "frame");
		expect(frame.data.title).toBe(`Miro連動${STAMP}`);
		// PDF はそのまま、HTML・Markdown・draw.io は PDF にして資料として、PNG は画像として
		const files = items.filter((i) => i.type === "document" || i.type === "image");
		expect(files.filter((i) => i.type === "document").map((i) => i.data.title).sort())
			.toEqual([`仕様書${STAMP}.pdf`, `構成図${STAMP}.drawio`, `概要${STAMP}.html`, `議事録${STAMP}.md`].sort());
		expect(files.filter((i) => i.type === "image").map((i) => i.data.title)).toEqual([`画面${STAMP}.png`]);
		for (const file of files) {
			expect(file.parent?.id, "枠の中に置いている").toBe(frame.id);
			expect(file.contentType).toBe(file.type === "image" ? "image/png" : "application/pdf");
			expect(file.geometry.width).toBe(360);
		}
		// テキストは出さず、理由を残す
		expect(itemOf(status, docs.txt.id)).toMatchObject({state: "skipped"});
		expect(itemOf(status, docs.txt.id).reason).toContain("出せない形式");

		// 資料ごとの見出し(名前・Document Manager で開くリンク)と、フォルダの見出し
		const texts = items.filter((i) => i.type === "text").map((i) => i.data.content);
		const caption = texts.find((t) => t.includes(`仕様書${STAMP}.pdf`));
		expect(caption).toContain(`/api/documents/alias/${docs.pdf.alias}/viewer`);
		expect(caption).toContain("Document Manager で開く");
		expect(texts.some((t) => t.includes("■ 要件定義"))).toBe(true);
		// 資料と見出しはグループにまとめる(人が動かすと一緒に動く)
		expect(items.filter((i) => i.type === "group")).toHaveLength(5);
	});

	test("新しい版は、人が動かした位置と大きさのまま、同じ項目の中身だけを差し替える", async ({request}) => {
		const before = (await boardItems(request)).find((i) => i.data?.title === `仕様書${STAMP}.pdf`);
		// Miro で人が動かした・大きさを変えた
		await control(request, {moveItem: {id: before.id, x: 2000, y: 1500}});
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		await settled(request, projectId);

		const v2 = await upload(request, `仕様書${STAMP}.pdf`, Buffer.concat([PDF, Buffer.from("% v2\n")]), docs.pdf.id);
		const status = await waitFor(request, projectId, (s) => itemOf(s, v2.id)?.state === "placed");
		const after = (await boardItems(request)).find((i) => i.id === before.id);
		expect(after, "別の項目として作り直している").toBeTruthy();
		expect(after.replacedAt).toBeTruthy();
		expect(after.position).toMatchObject({x: 2000, y: 1500});
		expect(after.geometry.width, "差し替えで元の大きさに戻っている").toBe(360);
		expect(status.counts.placed).toBe(5);
		docs.pdf = v2;
	});

	test("増えた資料は、並んでいるものの下に足し、枠を下へ伸ばす", async ({request}) => {
		const frameBefore = (await boardItems(request)).find((i) => i.type === "frame");
		const added = await upload(request, `テスト計画${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${projectId}/documents/${added.id}`, {headers: rw, data: {folderId: null}});
		await waitFor(request, projectId, (s) => itemOf(s, added.id)?.state === "placed");
		const items = await boardItems(request);
		const placed = items.find((i) => i.data?.title === `テスト計画${STAMP}.pdf`);
		const others = items.filter((i) => (i.type === "document" || i.type === "image") && i.id !== placed.id && i.position.x !== 2000);
		expect(placed.position.y, "下に足していない").toBeGreaterThan(Math.max(...others.map((i) => i.position.y)));
		const frameAfter = items.find((i) => i.type === "frame");
		expect(frameAfter.geometry.height).toBeGreaterThan(frameBefore.geometry.height);
		// 枠の上の端は動かさない(中心を、伸ばした分の半分だけ下げる)
		expect(frameAfter.position.y - frameAfter.geometry.height / 2).toBeCloseTo(frameBefore.position.y - frameBefore.geometry.height / 2, 3);
		docs.added = added;
	});

	test("Miro で消された資料は「外された」とみなし、勝手に戻さない", async ({request}) => {
		const item = (await boardItems(request)).find((i) => i.data?.title === `画面${STAMP}.png`);
		await control(request, {deleteItem: item.id});
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		let status = await settled(request, projectId);
		expect(itemOf(status, docs.png.id)).toMatchObject({state: "removed"});
		// 見出しも一緒に片付ける
		expect((await boardItems(request)).some((i) => i.type === "text" && i.data.content.includes(`画面${STAMP}.png`))).toBe(false);
		// 新しい版が出ても戻さない
		const v2 = await upload(request, `画面${STAMP}.png`, PNG, docs.png.id);
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		status = await settled(request, projectId);
		expect((await boardItems(request)).some((i) => i.data?.title === `画面${STAMP}.png`)).toBe(false);
		docs.png = v2;
		// 「出す」を選べば、もう一度出す
		await request.put(`api/projects/${projectId}/miro/documents/${v2.id}`, {headers: rw, data: {publish: true}});
		status = await waitFor(request, projectId, (s) => itemOf(s, v2.id)?.state === "placed");
		expect((await boardItems(request)).some((i) => i.data?.title === `画面${STAMP}.png`)).toBe(true);
	});

	test("資料ごとに「出さない」を選ぶと、ボードから消す", async ({request}) => {
		await request.put(`api/projects/${projectId}/miro/documents/${docs.md.id}`, {headers: rw, data: {publish: false}});
		const status = await settled(request, projectId);
		expect(itemOf(status, docs.md.id)).toMatchObject({state: "excluded"});
		expect((await boardItems(request)).some((i) => i.data?.title === `議事録${STAMP}.md` || i.data?.content?.includes(`議事録${STAMP}.md`))).toBe(false);
	});

	test("アーカイブした資料・プロジェクトから外した資料は、ボードからは消さずに見出しで知らせる", async ({request}) => {
		await request.delete(`api/documents/${docs.html.id}`, {headers: rw});
		await request.delete(`api/projects/${projectId}/documents/${docs.drawio.id}`, {headers: rw});
		const status = await waitFor(request, projectId, (s) => itemOf(s, docs.html.id)?.state === "detached" && s.items.filter((i) => i.state === "detached").length === 2);
		expect(itemOf(status, docs.html.id).reason).toContain("アーカイブ");
		const texts = (await boardItems(request)).filter((i) => i.type === "text").map((i) => i.data.content);
		expect(texts.find((t) => t.includes(`概要${STAMP}.html`))).toContain("アーカイブされた資料です");
		expect(texts.find((t) => t.includes(`構成図${STAMP}.drawio`))).toContain("このプロジェクトから外れた資料です");
		// 資料そのものは残っている(周りの付箋が宙に浮かないように)
		expect((await boardItems(request)).some((i) => i.data?.title === `概要${STAMP}.html`)).toBe(true);
	});

	test("Miro の一時的な失敗はやり直し、それでも断られたら次の同期でもう一度試す", async ({request}) => {
		// 1回だけの失敗は、その場でやり直して置ける
		await control(request, {failUploads: 1});
		const once = await upload(request, `手順書${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${projectId}/documents/${once.id}`, {headers: rw, data: {folderId: null}});
		await waitFor(request, projectId, (s) => itemOf(s, once.id)?.state === "placed");

		// やり直しても断られ続けたら「失敗」として残し、次の同期で置き直す
		await control(request, {failUploads: 10});
		const failing = await upload(request, `設計書${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${projectId}/documents/${failing.id}`, {headers: rw, data: {folderId: null}});
		await waitFor(request, projectId, (s) => itemOf(s, failing.id)?.state === "failed");
		await control(request, {failUploads: 0});
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		await waitFor(request, projectId, (s) => itemOf(s, failing.id)?.state === "placed");
	});

	test("閲覧だけの権限では、状態は見られるが連動の操作はできない。ログインしていなければ見られない", async ({request, playwright}) => {
		expect((await request.get(`api/projects/${projectId}/miro`, {headers: ro})).status()).toBe(200);
		expect((await request.post(`api/projects/${projectId}/miro`, {headers: ro})).status()).toBe(403);
		expect((await request.post(`api/projects/${projectId}/miro/sync`, {headers: ro})).status()).toBe(403);
		expect((await request.delete(`api/projects/${projectId}/miro`, {headers: ro})).status()).toBe(403);
		expect((await request.put(`api/projects/${projectId}/miro/documents/${docs.pdf.id}`, {headers: ro, data: {publish: false}})).status()).toBe(403);
		const anonymous = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		try {
			expect((await anonymous.get(`api/projects/${projectId}/miro`)).status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});

	test("連動をやめると、ボードはそのまま残して更新だけ止める", async ({request}) => {
		expect((await request.delete(`api/projects/${projectId}/miro`, {headers: rw})).status()).toBe(204);
		const countBefore = (await boardItems(request)).length;
		const status = await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();
		expect(status).toMatchObject({linked: false, state: "stopped"});
		// 止めたあとの変更は反映しない
		const after = await upload(request, `後から${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${projectId}/documents/${after.id}`, {headers: rw, data: {folderId: null}});
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect((await boardItems(request)).length).toBe(countBefore);
	});

	test("連動し直すと続きから反映し、やめるときに資料も消せる(付箋・枠は残す)", async ({request}) => {
		await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		await settled(request, projectId);
		expect((await boardItems(request)).filter((i) => i.type === "frame"), "枠を作り直している").toHaveLength(1);
		expect((await boardItems(request)).some((i) => i.data?.title === `後から${STAMP}.pdf`)).toBe(true);

		expect((await request.delete(`api/projects/${projectId}/miro?removeDocuments=1`, {headers: rw})).status()).toBe(204);
		const items = await boardItems(request);
		expect(items.filter((i) => i.type === "document" || i.type === "image")).toHaveLength(0);
		expect(items.filter((i) => i.type === "frame")).toHaveLength(1);
		// フォルダの見出しも片付ける(残すと、連動し直したときに二重になる)
		expect(items.filter((i) => i.type === "text" && i.data.content.includes("■"))).toHaveLength(0);
	});

	test("Miro で枠が消されたら、連動を止めて理由を出す。連動し直すと新しい枠に並べる", async ({request}) => {
		await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		await settled(request, projectId);
		const frame = (await boardItems(request)).find((i) => i.type === "frame");
		await control(request, {deleteItem: frame.id});
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		const stopped = await waitFor(request, projectId, (s) => s.state === "stopped");
		expect(stopped.lastError).toContain("枠が消された");

		await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		const relinked = await settled(request, projectId);
		expect(relinked.linked).toBe(true);
		const frames = (await boardItems(request)).filter((i) => i.type === "frame");
		expect(frames.some((f) => f.id !== frame.id)).toBe(true);
		// フォルダの見出しは二重にならない(前の枠のものを引きずらない)。
		// ここでは「要件定義」の資料はアーカイブ済み・出さない設定なので、見出しも置かれない
		const headers = (await boardItems(request)).filter((i) => i.type === "text" && i.data.content.includes("■"));
		expect(headers.length).toBeLessThanOrEqual(1);
	});

	test("Miro と連携していなければ、連動は始められない", async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		const res = await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		expect(res.status()).toBe(409);
		expect((await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json()).available).toBe(false);
	});
});
