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
		await control(request, {moveItem: {id: before.id, x: 1400, y: 1100}});
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		await settled(request, projectId);

		const v2 = await upload(request, `仕様書${STAMP}.pdf`, Buffer.concat([PDF, Buffer.from("% v2\n")]), docs.pdf.id);
		const status = await waitFor(request, projectId, (s) => itemOf(s, v2.id)?.state === "placed");
		const after = (await boardItems(request)).find((i) => i.id === before.id);
		expect(after, "別の項目として作り直している").toBeTruthy();
		expect(after.replacedAt).toBeTruthy();
		expect(after.position).toMatchObject({x: 1400, y: 1100});
		expect(after.geometry.width, "差し替えで元の大きさに戻っている").toBe(360);
		expect(status.counts.placed).toBe(5);
		docs.pdf = v2;
	});

	test("増えた資料は、その列(フォルダ列型の「その他」)の後ろに足し、前に置いた資料は動かさない。枠の上の端は動かさない", async ({request}) => {
		const before = await boardItems(request);
		const frameBefore = before.find((i) => i.type === "frame");
		const positionsBefore = new Map(before.filter((i) => i.type === "document" || i.type === "image").map((i) => [i.id, i.position]));
		const added = await upload(request, `テスト計画${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${projectId}/documents/${added.id}`, {headers: rw, data: {folderId: null}});
		await waitFor(request, projectId, (s) => itemOf(s, added.id)?.state === "placed");
		const items = await boardItems(request);
		const placed = items.find((i) => i.data?.title === `テスト計画${STAMP}.pdf`);
		const others = items.filter((i) => (i.type === "document" || i.type === "image") && i.id !== placed.id);
		for (const other of others) expect(other.position, "前に置いた資料が動いた").toMatchObject(positionsBefore.get(other.id));
		// 同じ列(x が同じ・右隣)の資料より後ろ(下、または同じ段の右)
		const column = others.filter((i) => Math.abs(i.position.x - placed.position.x) <= 420 && i.position.x !== 1400);
		for (const other of column) {
			expect(placed.position.y > other.position.y || (placed.position.y === other.position.y && placed.position.x > other.position.x), "後ろに足していない").toBe(true);
		}
		const frameAfter = items.find((i) => i.type === "frame");
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

test.describe.serial("Miro のボードの上で資料を動かす", () => {
	let projectId;
	let otherProjectId;
	const docs = {};
	const caption = (items, title) => items.find((i) => i.type === "text" && i.data.content.includes(title));
	const file = (items, title) => items.find((i) => (i.type === "document" || i.type === "image") && i.data?.title === title);

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `移動${STAMP}`}})).json()).id;
		otherProjectId = (await (await request.post("api/projects", {headers: rw, data: {name: `移動先${STAMP}`}})).json()).id;
		for (const id of [projectId, otherProjectId]) await request.post(`api/projects/${id}/unlock`, {headers: rw});
		for (const key of ["a", "b", "c"]) {
			docs[key] = await upload(request, `資料${key.toUpperCase()}${STAMP}.pdf`, PDF);
			await request.put(`api/projects/${projectId}/documents/${docs[key].id}`, {headers: rw, data: {folderId: null}});
		}
		const other = await upload(request, `別の資料${STAMP}.pdf`, PDF);
		await request.put(`api/projects/${otherProjectId}/documents/${other.id}`, {headers: rw, data: {folderId: null}});
		await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		await request.post(`api/projects/${otherProjectId}/miro`, {headers: rw});
		await settled(request, projectId);
		await settled(request, otherProjectId);
	});

	test.afterAll(async ({request}) => {
		for (const id of [projectId, otherProjectId]) await request.delete(`api/projects/${id}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("ほかの資料の右・下へ動かせる。見出しも一緒に動く", async ({request}) => {
		const move = (doc, body) => request.patch(`api/projects/${projectId}/miro/items/${doc.id}`, {headers: rw, data: body});
		expect((await move(docs.b, {x: 3000, y: 3000})).status()).toBe(200);
		expect((await move(docs.b, {nextTo: docs.a.id, side: "right"})).status()).toBe(200);
		expect((await move(docs.c, {nextTo: docs.a.id, side: "below"})).status()).toBe(200);
		const items = await boardItems(request);
		const a = file(items, `資料A${STAMP}.pdf`);
		const b = file(items, `資料B${STAMP}.pdf`);
		const c = file(items, `資料C${STAMP}.pdf`);
		expect(b.position.x).toBeCloseTo(a.position.x + (a.geometry.width + b.geometry.width) / 2 + 60, 3);
		expect(b.position.y).toBeCloseTo(a.position.y, 3);
		expect(c.position.x).toBeCloseTo(a.position.x, 3);
		// 下に置くときは、上の資料の見出しの分も空ける
		expect(c.position.y).toBeCloseTo(a.position.y + a.geometry.height / 2 + 80 + 60 + c.geometry.height / 2, 3);
		const captionB = caption(items, `資料B${STAMP}.pdf`);
		expect(captionB.position.x).toBeCloseTo(b.position.x, 3);
		expect(captionB.position.y).toBeCloseTo(b.position.y + b.geometry.height / 2 + 40, 3);
		// 状態にも新しい位置が載る(AI が次の指示を組み立てるときに使う)
		const status = await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();
		expect(itemOf(status, docs.b.id).position.x).toBeCloseTo(b.position.x, 3);
	});

	test("動かした資料に新しい版が出ても、その場所のまま差し替える", async ({request}) => {
		const before = file(await boardItems(request), `資料B${STAMP}.pdf`);
		const v2 = await upload(request, `資料B${STAMP}.pdf`, Buffer.concat([PDF, Buffer.from("% v2\n")]), docs.b.id);
		await waitFor(request, projectId, (s) => itemOf(s, v2.id)?.state === "placed");
		const after = (await boardItems(request)).find((i) => i.id === before.id);
		expect(after.position).toMatchObject({x: before.position.x, y: before.position.y});
		docs.b = v2;
	});

	test("ほかのプロジェクトの枠へ移せる", async ({request}) => {
		const res = await request.patch(`api/projects/${projectId}/miro/items/${docs.c.id}`, {headers: rw, data: {project: otherProjectId}});
		expect(res.status()).toBe(200);
		const items = await boardItems(request);
		const frames = items.filter((i) => i.type === "frame");
		const otherFrame = frames.find((f) => f.data.title === `移動先${STAMP}`);
		expect(file(items, `資料C${STAMP}.pdf`).parent.id).toBe(otherFrame.id);
		expect(caption(items, `資料C${STAMP}.pdf`).parent.id).toBe(otherFrame.id);
	});

	test("正しくない指示は断る", async ({request}) => {
		const move = (doc, body) => request.patch(`api/projects/${projectId}/miro/items/${doc.id}`, {headers: rw, data: body});
		expect((await move(docs.a, {})).status()).toBe(400);
		expect((await move(docs.a, {nextTo: docs.b.id, side: "diagonal"})).status()).toBe(400);
		expect((await move(docs.a, {nextTo: docs.a.id})).status()).toBe(400);
		expect((await move(docs.a, {project: "not-linked"})).status()).toBe(409);
		const stray = await upload(request, `出ていない${STAMP}.pdf`, PDF);
		expect((await move(stray, {x: 1, y: 1})).status()).toBe(404);
		expect((await request.patch(`api/projects/${projectId}/miro/items/${docs.a.id}`, {headers: ro, data: {x: 1, y: 1}})).status()).toBe(403);
	});

	test("フォルダ列型で並べ直すと、枠の外へ出した資料も戻り、列の中に 2 枚ずつ揃う", async ({request}) => {
		const res = await request.post(`api/projects/${projectId}/miro/arrange`, {headers: rw});
		expect(res.status()).toBe(200);
		expect((await res.json()).moved).toBe(3);
		const items = await boardItems(request);
		const frame = items.find((i) => i.type === "frame" && i.data.title === `移動${STAMP}`);
		const placed = ["A", "B", "C"].map((k) => file(items, `資料${k}${STAMP}.pdf`));
		for (const item of placed) expect(item.parent.id).toBe(frame.id);
		// フォルダに入っていない資料は「その他」の列に、おしながき順で 2 枚ずつ折り返す
		const [a, b, c] = placed;
		expect(b.position.x - a.position.x).toBeCloseTo(360 + 60, 3);
		expect(b.position.y).toBeCloseTo(a.position.y, 3);
		expect(c.position.x).toBeCloseTo(a.position.x, 3);
		expect(c.position.y).toBeGreaterThan(a.position.y);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("■ その他"))).toBe(true);
	});
});

// 並べ方は指示を出す側(人や AI)が決め、Document Manager はそのまま置く(十字型・フォルダ列型・時系列型など)
test.describe.serial("Miro の枠にレイアウトをまとめて当てる", () => {
	let projectId;
	const docs = {};
	const file = (items, title) => items.find((i) => (i.type === "document" || i.type === "image") && i.data?.title === title);
	const caption = (items, title) => items.find((i) => i.type === "text" && i.data.content.includes(title));
	const layout = (body) => request.post(`api/projects/${projectId}/miro/layout`, {headers: rw, data: body});
	let request;

	test.beforeAll(async ({playwright}) => {
		request = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `レイアウト${STAMP}`}})).json()).id;
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		const folder = await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "設計"}})).json();
		for (const key of ["req", "design", "test"]) {
			docs[key] = await upload(request, `L-${key}${STAMP}.pdf`, PDF);
			await request.put(`api/projects/${projectId}/documents/${docs[key].id}`, {headers: rw, data: {folderId: key === "design" ? folder.id : null}});
		}
		await request.post(`api/projects/${projectId}/miro`, {headers: rw});
		await settled(request, projectId);
	});

	test.afterAll(async () => {
		await request.delete(`api/projects/${projectId}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
		await request.dispose();
	});

	test("資料の位置と色・見出しの文字・図形をまとめて当て、はみ出す分は枠を広げる(左上は動かさない)", async () => {
		const before = (await boardItems(request)).find((i) => i.type === "frame");
		const status = await (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();
		expect(status.frame).toMatchObject({width: before.geometry.width, height: before.geometry.height});

		const res = await layout({
			items: [
				{documentId: docs.req.id, x: 300, y: 400, color: "#fde68a"},
				{documentId: docs.design.id, x: 800, y: 400},
				{documentId: docs.test.id, x: 300, y: 3000, color: "#bfdbfe"}
			],
			labels: [{text: "左上: 要件定義〜設計", x: 600, y: 100, width: 1000, fontSize: 48}],
			shapes: [
				{x: 1500, y: 1600, width: 8, height: 3000, fillColor: "#333333"},
				{x: 3500, y: 800, width: 2000, height: 1200, fillColor: "#e0f2fe", fillOpacity: 0.2}
			]
		});
		expect(res.status()).toBe(200);
		const result = await res.json();
		expect(result).toMatchObject({moved: 3, labels: 1, shapes: 2});

		const items = await boardItems(request);
		const frame = items.find((i) => i.id === before.id);
		// 右端(図形の 3500 + 1000)・下端(資料の 3000 + 高さ/2 + 見出し)が収まるまで広がる
		expect(frame.geometry.width).toBeGreaterThanOrEqual(4500);
		expect(frame.geometry.height).toBeGreaterThan(3000);
		expect(frame.position.x - frame.geometry.width / 2).toBeCloseTo(before.position.x - before.geometry.width / 2, 3);
		expect(frame.position.y - frame.geometry.height / 2).toBeCloseTo(before.position.y - before.geometry.height / 2, 3);

		const req = file(items, `L-req${STAMP}.pdf`);
		expect(req.position).toMatchObject({x: 300, y: 400});
		expect(caption(items, `L-req${STAMP}.pdf`).style).toMatchObject({fillColor: "#fde68a"});
		// 色を指定しなかった資料の見出しは、塗らない
		expect(caption(items, `L-design${STAMP}.pdf`).style?.fillColor).toBeUndefined();
		const label = items.find((i) => i.type === "text" && i.data.content.includes("左上: 要件定義〜設計"));
		expect(label.parent.id).toBe(frame.id);
		expect(label.style).toMatchObject({fontSize: "48"});
		const shapes = items.filter((i) => i.type === "shape");
		expect(shapes).toHaveLength(2);
		expect(shapes.find((i) => i.geometry.width === 2000).style).toMatchObject({fillColor: "#e0f2fe", fillOpacity: "0.2"});
		// 初めて並べたときのフォルダの見出しは片付けて、指示どおりのものだけにする
		expect(items.some((i) => i.type === "text" && i.data.content.includes("■ 設計"))).toBe(false);
	});

	test("当て直すと、前の見出しの文字と図形を片付けてから置く(残すこともできる)", async () => {
		await layout({labels: [{text: "右上: 管理系", x: 600, y: 100}]});
		let items = await boardItems(request);
		expect(items.filter((i) => i.type === "shape")).toHaveLength(0);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("左上: 要件定義〜設計"))).toBe(false);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("右上: 管理系"))).toBe(true);

		await layout({labels: [{text: "左下: テスト〜リリース", x: 600, y: 2000}], keepDecorations: true});
		items = await boardItems(request);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("右上: 管理系"))).toBe(true);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("左下: テスト〜リリース"))).toBe(true);
	});

	test("色は null で外せる。新しい版が出ても、当てた位置のまま差し替える", async () => {
		await layout({items: [{documentId: docs.req.id, x: 300, y: 400, color: null}], keepDecorations: true});
		let items = await boardItems(request);
		expect(caption(items, `L-req${STAMP}.pdf`).style).toMatchObject({fillOpacity: "0"});

		const v2 = await upload(request, `L-req${STAMP}.pdf`, Buffer.concat([PDF, Buffer.from("% v2\n")]), docs.req.id);
		await waitFor(request, projectId, (s) => itemOf(s, v2.id)?.state === "placed");
		items = await boardItems(request);
		expect(file(items, `L-req${STAMP}.pdf`).position).toMatchObject({x: 300, y: 400});
	});

	test("正しくないところがあれば、何も動かさずに理由の一覧を返す", async () => {
		const before = file(await boardItems(request), `L-design${STAMP}.pdf`).position;
		const stray = await upload(request, `出ていない${STAMP}.pdf`, PDF);
		const res = await layout({
			items: [{documentId: docs.design.id, x: 5, y: 5}, {documentId: stray.id, x: 1, y: 1}, {documentId: docs.test.id, x: -1, y: "abc"}],
			labels: [{text: "", x: 0, y: 0}],
			shapes: [{shape: "unknown", x: 0, y: 0, width: 10, height: 10, fillColor: "red"}]
		});
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("何も動かしていません");
		const details = body.details.join("\n");
		expect(details).toContain(stray.id);
		expect(details).toContain("items[2].x");
		expect(details).toContain("items[2].y");
		expect(details).toContain("labels[0].text");
		expect(details).toContain("shapes[0].shape");
		expect(details).toContain("shapes[0].fillColor");
		expect(file(await boardItems(request), `L-design${STAMP}.pdf`).position, "一部だけ動いている").toEqual(before);

		expect((await layout({})).status()).toBe(400);
		expect((await layout({items: [{documentId: docs.req.id, x: 1, y: 1}, {documentId: docs.req.id, x: 2, y: 2}]})).status()).toBe(400);
		expect((await request.post(`api/projects/${projectId}/miro/layout`, {headers: ro, data: {frame: {width: 5000, height: 5000}}})).status()).toBe(403);
	});

	test("1件ずつ位置を指定して動かすときも、はみ出したら枠を広げる", async () => {
		const before = (await boardItems(request)).find((i) => i.type === "frame");
		const res = await request.patch(`api/projects/${projectId}/miro/items/${docs.design.id}`, {headers: rw, data: {x: before.geometry.width + 1000, y: 300}});
		expect(res.status()).toBe(200);
		const after = (await boardItems(request)).find((i) => i.type === "frame");
		expect(after.geometry.width).toBeGreaterThan(before.geometry.width + 1000);
		expect((await request.patch(`api/projects/${projectId}/miro/items/${docs.design.id}`, {headers: rw, data: {x: -10, y: 300}})).status()).toBe(400);
	});
});

// 並べ方の型はプロジェクトごとに持つ。並べ直し(型の切り替え)の前の配置を 1 世代だけ覚え、元に戻せる(docs/miro-layouts/layout-spec.md 6 章)
test.describe.serial("Miro の並べ方の型と、元の型に戻す", () => {
	let projectId;
	const docs = {};
	const file = (items, title) => items.find((i) => (i.type === "document" || i.type === "image") && i.data?.title === title);
	const caption = (items, title) => items.find((i) => i.type === "text" && i.data.content.includes(title));
	const statusOf = async (request) => (await request.get(`api/projects/${projectId}/miro`, {headers: rw})).json();

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `型${STAMP}`}})).json()).id;
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		for (const key of ["a", "b"]) {
			docs[key] = await upload(request, `型-${key}${STAMP}.pdf`, PDF);
			await request.put(`api/projects/${projectId}/documents/${docs[key].id}`, {headers: rw, data: {folderId: null}});
		}
	});

	test.afterAll(async ({request}) => {
		await request.delete(`api/projects/${projectId}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("連動を始めるときに型を選べ、報告の既定もその型になる。知らない型は断る", async ({request}) => {
		expect((await request.post(`api/projects/${projectId}/miro`, {headers: rw, data: {layout: "kanban"}})).status()).toBe(400);
		expect((await request.post(`api/projects/${projectId}/miro`, {headers: rw, data: {layout: "timeline"}})).status()).toBe(202);
		const status = await settled(request, projectId);
		expect(status).toMatchObject({layout: "timeline", layoutName: "時系列型", undo: null});
		const report = await (await request.get(`api/projects/${projectId}/miro/layout-report`, {headers: ro})).json();
		expect(report.layout).toBe("timeline");
	});

	test("型を渡して並べ直すと、その型に切り替わり、前の型に戻せるようになる", async ({request}) => {
		// 人が並べた(ここではレイアウトを当てた)配置: 位置・見出しの色・区画の見出し
		await request.post(`api/projects/${projectId}/miro/layout`, {headers: rw, data: {
			items: [{documentId: docs.a.id, x: 3000, y: 3000, color: "#fde68a"}],
			labels: [{text: "前の区画", x: 600, y: 100}]
		}});
		expect((await request.post(`api/projects/${projectId}/miro/arrange`, {headers: rw, data: {layout: "kanban"}})).status()).toBe(400);
		const res = await request.post(`api/projects/${projectId}/miro/arrange`, {headers: rw, data: {layout: "folder-columns"}});
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({moved: 2, layout: "folder-columns", previousLayout: "timeline"});
		const items = await boardItems(request);
		expect(file(items, `型-a${STAMP}.pdf`).position.x).toBeLessThan(3000);
		expect(caption(items, `型-a${STAMP}.pdf`).style).toMatchObject({fillOpacity: "0"});
		expect(items.some((i) => i.type === "text" && i.data.content.includes("前の区画"))).toBe(false);
		const status = await statusOf(request);
		expect(status).toMatchObject({layout: "folder-columns", undo: {layout: "timeline", layoutName: "時系列型"}});
	});

	test("元の型に戻すと、型・位置・見出しの色・区画の見出しが戻る。戻せるのは 1 世代だけ", async ({request}) => {
		const res = await request.post(`api/projects/${projectId}/miro/arrange/undo`, {headers: rw});
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({layout: "timeline"});
		const items = await boardItems(request);
		expect(file(items, `型-a${STAMP}.pdf`).position).toMatchObject({x: 3000, y: 3000});
		expect(caption(items, `型-a${STAMP}.pdf`).style).toMatchObject({fillColor: "#fde68a"});
		expect(items.some((i) => i.type === "text" && i.data.content.includes("前の区画"))).toBe(true);
		expect(await statusOf(request)).toMatchObject({layout: "timeline", undo: null});
		expect((await request.post(`api/projects/${projectId}/miro/arrange/undo`, {headers: rw})).status()).toBe(409);
		expect((await request.post(`api/projects/${projectId}/miro/arrange/undo`, {headers: ro})).status()).toBe(403);
	});

	test("十字型に切り替えると、区画の見出し・十字の線・中心の概要カードを置き、資料を区画に並べる", async ({request}) => {
		const tagged = await upload(request, `型-基本設計${STAMP}.pdf`, PDF);
		await request.put(`api/documents/${tagged.id}/tags`, {headers: rw, data: {tags: ["工程:基本設計"]}});
		const plan = await upload(request, `型-計画書${STAMP}.pdf`, PDF);
		for (const d of [tagged, plan]) await request.put(`api/projects/${projectId}/documents/${d.id}`, {headers: rw, data: {folderId: null}});
		await waitFor(request, projectId, (s) => itemOf(s, plan.id)?.state === "placed" && itemOf(s, tagged.id)?.state === "placed");
		const res = await request.post(`api/projects/${projectId}/miro/arrange`, {headers: rw, data: {layout: "quadrant-cross"}});
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({moved: 4, layout: "quadrant-cross", previousLayout: "timeline"});
		const items = await boardItems(request);
		const texts = items.filter((i) => i.type === "text").map((i) => i.data.content);
		for (const title of ["左上: 要件定義〜設計", "右上: 管理系", "左下: テスト〜リリース", "右下: 会議", "未分類"]) {
			expect(texts.some((t) => t.includes(title)), title).toBe(true);
		}
		expect(texts.some((t) => t.includes(`型${STAMP} / 資料 4 件`))).toBe(true);
		expect(items.filter((i) => i.type === "shape").length).toBeGreaterThanOrEqual(2);
		// 計画書は右上(管理)、基本設計書は左上、名前から分からない資料は枠の下の未分類
		const designDoc = file(items, `型-基本設計${STAMP}.pdf`);
		const planDoc = file(items, `型-計画書${STAMP}.pdf`);
		const loose = file(items, `型-a${STAMP}.pdf`);
		expect(planDoc.position.x).toBeGreaterThan(designDoc.position.x);
		expect(loose.position.y).toBeGreaterThan(designDoc.position.y);
		expect(caption(items, `型-計画書${STAMP}.pdf`).style).toMatchObject({fillColor: "#f1efe8"});
		expect((await statusOf(request)).layout).toBe("quadrant-cross");
	});
});

// 連動のあいだ、Document Manager が置いた位置のままの資料だけを型どおりに寄せ、人が Miro で動かした資料は動かさない(layout-spec.md 5 章)
test.describe.serial("連動で並べるとき、人が動かした資料は動かさない", () => {
	let projectId;
	const docs = {};
	const file = (items, title) => items.find((i) => (i.type === "document" || i.type === "image") && i.data?.title === title);
	const tagged = async (request, name, tags) => {
		const doc = await upload(request, `${name}${STAMP}.pdf`, PDF);
		if (tags.length > 0) await request.put(`api/documents/${doc.id}/tags`, {headers: rw, data: {tags}});
		await request.put(`api/projects/${projectId}/documents/${doc.id}`, {headers: rw, data: {folderId: null}});
		return doc;
	};
	const sync = async (request) => {
		await request.post(`api/projects/${projectId}/miro/sync`, {headers: rw});
		return settled(request, projectId);
	};

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `人が動かす${STAMP}`}})).json()).id;
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
		docs.design = await tagged(request, "人-基本設計", ["工程:基本設計"]);
		docs.plan = await tagged(request, "人-計画書", []);
		docs.memo = await tagged(request, "人-メモ", []);
		await request.post(`api/projects/${projectId}/miro`, {headers: rw, data: {layout: "quadrant-cross"}});
		await settled(request, projectId);
	});

	test.afterAll(async ({request}) => {
		await request.delete(`api/projects/${projectId}/miro`, {headers: rw});
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("連動を始めたときから、選んだ型どおりに並ぶ", async ({request}) => {
		const items = await boardItems(request);
		const design = file(items, `人-基本設計${STAMP}.pdf`);
		const plan = file(items, `人-計画書${STAMP}.pdf`);
		const memo = file(items, `人-メモ${STAMP}.pdf`);
		expect(plan.position.x, "計画書(管理)は右上").toBeGreaterThan(design.position.x);
		expect(memo.position.y, "メモは枠の下の未分類").toBeGreaterThan(plan.position.y);
		expect(items.some((i) => i.type === "text" && i.data.content.includes("右上: 管理系"))).toBe(true);
		const check = await (await request.get(`api/projects/${projectId}/miro/arrange-check`, {headers: ro})).json();
		expect(check).toMatchObject({layout: "quadrant-cross", placed: 3, humanMoved: 0});
	});

	test("人が動かした資料は、タグが変わっても動かさない。置いたままの資料は型どおりに寄せる", async ({request}) => {
		const plan = file(await boardItems(request), `人-計画書${STAMP}.pdf`);
		await control(request, {moveItem: {id: plan.id, x: 500, y: 300}});
		await sync(request);
		const check = await (await request.get(`api/projects/${projectId}/miro/arrange-check`, {headers: ro})).json();
		expect(check.humanMoved).toBe(1);
		expect(check.documents[0].title).toBe(`人-計画書${STAMP}.pdf`);

		// メモに 区分:管理 を付けると右上へ寄る。人が動かした計画書はそのまま
		const memoBefore = file(await boardItems(request), `人-メモ${STAMP}.pdf`).position;
		await request.put(`api/documents/${docs.memo.id}/tags`, {headers: rw, data: {tags: ["区分:管理"]}});
		await sync(request);
		const items = await boardItems(request);
		expect(file(items, `人-計画書${STAMP}.pdf`).position).toMatchObject({x: 500, y: 300});
		const memo = file(items, `人-メモ${STAMP}.pdf`).position;
		expect(memo.y).toBeLessThan(memoBefore.y);
		expect(memo.x).toBeGreaterThan(file(items, `人-基本設計${STAMP}.pdf`).position.x);
	});

	test("型どおりの場所が人の動かした資料とぶつかる新しい資料は、枠の下に置き、「並べ直すと整います」の付箋を出す", async ({request}) => {
		// 計画書(人が動かした)を、次の管理の資料が入るはずの場所へ動かす
		const memo = file(await boardItems(request), `人-メモ${STAMP}.pdf`);
		const blocker = file(await boardItems(request), `人-計画書${STAMP}.pdf`);
		await control(request, {moveItem: {id: blocker.id, x: memo.position.x + 420, y: memo.position.y}});
		await sync(request);
		docs.wbs = await tagged(request, "人-WBS", ["区分:管理"]);
		await waitFor(request, projectId, (s) => itemOf(s, docs.wbs.id)?.state === "placed");
		const items = await boardItems(request);
		const wbs = file(items, `人-WBS${STAMP}.pdf`);
		expect(wbs.position.y, "ぶつからない枠の下に置く").toBeGreaterThan(memo.position.y + 600);
		const sticky = items.find((i) => i.type === "sticky_note");
		expect(sticky?.data?.content).toContain("並べ直すと整います");
	});

	test("並べ直すと、人が動かした資料も型どおりに戻し、付箋を片付ける", async ({request}) => {
		const res = await request.post(`api/projects/${projectId}/miro/arrange`, {headers: rw});
		expect(res.status()).toBe(200);
		const items = await boardItems(request);
		expect(items.some((i) => i.type === "sticky_note")).toBe(false);
		const check = await (await request.get(`api/projects/${projectId}/miro/arrange-check`, {headers: ro})).json();
		expect(check.humanMoved).toBe(0);
		const managed = ["人-計画書", "人-メモ", "人-WBS"].map((n) => file(items, `${n}${STAMP}.pdf`).position);
		expect(new Set(managed.map((p) => p.y)).size, "右上の格子に 1 段で並ぶ").toBe(1);
	});
});
