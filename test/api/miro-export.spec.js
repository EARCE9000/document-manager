/*!
 * miro-export.spec.js : プロジェクトの資料を Miro のボードに書き出す(目印を基準に、毎回新しいフレーム)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro には代わりのサーバー(miro-stub.js)を使い、置かれた項目(種類・位置・枠・題名)を直接見て確かめる。
 * PDF への変換は、変換サービスの代わり(converter-stub.js)が最小の PDF を返す。
 *
 * 確かめること(書き出しはプロジェクトに縛られない。プロジェクトを渡すのは、資料を全部出すときと十字の概要カードのため):
 *   - 目印(付箋の [DM]名前・向き・メモ)を読む・置く。目印もリンクも無ければ書き出さない
 *   - 目印の向きに新しいフレームを作り、頼んだ資料だけを読む順に並べる。フレームの名前は「タイトル [日時]」
 *   - 同じ目印に何度書き出しても、前のフレームには触らず、重ならない所に出す。ほかの付箋とも重ねない
 *   - 資料を変えても、頼まれるまでボードは変わらない(自動では書き出さない)
 *   - リンク・空いている所・向きごとの組・十字(斜め 4 つと概要カード)
 *   - 書き出したあとの手直し(地図・動かす・まとめて当てる)は書き出しごと。省くと頼んだ人の最後の書き出し
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
const framesOf = async (request) => (await boardItems(request)).filter((i) => i.type === "frame");
const childrenOf = async (request, frameId) => (await boardItems(request)).filter((i) => i.parent?.id === frameId);
const boxOf = (item) => ({left: item.position.x - item.geometry.width / 2, right: item.position.x + item.geometry.width / 2,
	top: item.position.y - item.geometry.height / 2, bottom: item.position.y + item.geometry.height / 2});
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

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

const newProject = async (request, name) => {
	const project = await (await request.post("api/projects", {headers: rw, data: {name}})).json();
	await request.post(`api/projects/${project.id}/unlock`, {headers: rw});
	return project.id;
};
const addToProject = async (request, projectId, doc, folderId = null) => {
	expect((await request.put(`api/projects/${projectId}/documents/${doc.id}`, {headers: rw, data: {folderId}})).status()).toBe(200);
};

/** 書き出しを頼み、終わるのを待って記録を返す */
const exportAndWait = async (request, projectId, body) => {
	const res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, ...body}});
	expect(res.status(), JSON.stringify(await res.json().catch(() => null))).toBe(202);
	const started = await res.json();
	let record;
	await expect.poll(async () => {
		record = await (await request.get(`api/miro/exports/${started.id}`, {headers: rw})).json();
		return record.state;
	}, {timeout: 15000}).not.toBe("running");
	return record;
};
const titleOf = (frame) => frame.data.title;
const STAMP_PATTERN = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/;

test.describe.serial("Miro に書き出す", () => {
	let projectId;
	const docs = {};

	test.beforeAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
		projectId = await newProject(request, `Miro書き出し${STAMP}`);
		const folder = await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件定義"}})).json();
		docs.pdf = await upload(request, `仕様書${STAMP}.pdf`, PDF);
		docs.png = await upload(request, `画面${STAMP}.png`, PNG);
		docs.html = await upload(request, `概要${STAMP}.html`, "<!DOCTYPE html><html><body><h1>概要</h1></body></html>");
		docs.md = await upload(request, `議事録${STAMP}.md`, "# 議事録\n\n本文\n");
		docs.txt = await upload(request, `メモ${STAMP}.txt`, "テキスト");
		for (const [key, doc] of Object.entries(docs)) await addToProject(request, projectId, doc, key === "html" ? folder.id : null);
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("Miro と連携していなければ、目印も書き出しも 409", async ({request}) => {
		expect((await request.get("api/miro/anchors", {headers: rw})).status()).toBe(409);
		const res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, free: true}});
		expect(res.status()).toBe(409);
		expect((await res.json()).code).toBe("not_connected");
		const status = await (await request.get("api/miro/exports", {headers: ro})).json();
		expect(status).toMatchObject({available: false, exporting: false});
		await connectMiro(request);
	});

	test("目印もリンクも無ければ、何も書き出さずに 409(anchor_required)", async ({request}) => {
		const res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, documentIds: [docs.pdf.id]}});
		expect(res.status()).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("anchor_required");
		expect(body.error).toContain("[DM]");
		expect(await framesOf(request)).toHaveLength(0);
	});

	test("目印の付箋を置ける([DM]名前・向き・メモ)。一覧に名前・向き・メモ・リンクが出る", async ({request}) => {
		const res = await request.post("api/miro/anchors", {headers: rw, data: {name: "設計書", direction: "右側", note: "基本設計書と画面設計"}});
		expect(res.status()).toBe(201);
		const placed = await res.json();
		expect(placed).toMatchObject({name: "設計書", direction: "right", directionName: "右", note: "基本設計書と画面設計"});
		expect(placed.url).toContain(`moveToWidget=${placed.id}`);
		const sticky = (await boardItems(request)).find((i) => i.id === placed.id);
		expect(sticky.type).toBe("sticky_note");
		expect(sticky.data.content).toBe("<p>[DM]設計書</p><p>(右)</p><p>基本設計書と画面設計</p>");
		const list = await (await request.get("api/miro/anchors", {headers: ro})).json();
		expect(list.anchors).toEqual([expect.objectContaining({id: placed.id, name: "設計書", direction: "right", note: "基本設計書と画面設計", problem: null})]);
		// 書き込みの権限が無ければ置けない。名前が無い・向きが読めないものは断る
		expect((await request.post("api/miro/anchors", {headers: ro, data: {name: "x"}})).status()).toBe(403);
		expect((await request.post("api/miro/anchors", {headers: rw, data: {name: " "}})).status()).toBe(400);
		expect((await request.post("api/miro/anchors", {headers: rw, data: {name: "x", direction: "ななめ"}})).status()).toBe(400);
	});

	test("目印の右に新しいフレームを作り、頼んだ資料だけを読む順に並べる。出せない形式は理由を残す", async ({request}) => {
		const anchor = (await boardItems(request)).find((i) => i.type === "sticky_note");
		const record = await exportAndWait(request, projectId, {anchor: "設計書", documentIds: [docs.pdf.id, docs.png.id, docs.html.id, docs.txt.id]});
		expect(record).toMatchObject({state: "done", title: "設計書", anchor: {kind: "marker", name: "設計書"}, counts: {placed: 3, skipped: 1, failed: 0}, error: null});
		expect(record.documents.find((d) => d.documentId === docs.txt.id)).toMatchObject({state: "skipped"});
		expect(record.documents.find((d) => d.documentId === docs.txt.id).reason).toContain("出せない形式");

		const frames = await framesOf(request);
		expect(frames).toHaveLength(1);
		const frame = frames[0];
		expect(titleOf(frame)).toMatch(new RegExp(`^設計書 ${STAMP_PATTERN.source}`));
		expect(record.frames).toEqual([expect.objectContaining({frameId: frame.id, direction: "right", title: titleOf(frame)})]);
		expect(record.frames[0].url).toContain(`moveToWidget=${frame.id}`);
		// 目印の右(間を空ける)・上の端をそろえる
		expect(boxOf(frame).left).toBeGreaterThan(boxOf(anchor).right);
		expect(Math.abs(boxOf(frame).top - boxOf(anchor).top)).toBeLessThanOrEqual(1);
		// 中は読む順(左から右)。PDF はそのまま、HTML は PDF にして、PNG は画像として
		const files = (await childrenOf(request, frame.id)).filter((i) => i.type === "document" || i.type === "image");
		expect(files.sort((a, b) => a.position.x - b.position.x).map((i) => i.data.title)).toEqual([`仕様書${STAMP}.pdf`, `画面${STAMP}.png`, `概要${STAMP}.html`]);
		expect(files.find((i) => i.data.title === `画面${STAMP}.png`).type).toBe("image");
		for (const file of files) {
			// 上の端は枠の上から 80(代わりの Miro は中身の縦横比を A4 縦とみなすので、A4 縦の PDF で見る)
			if (file.data.title === `仕様書${STAMP}.pdf`) expect(Math.abs(file.position.y - file.geometry.height / 2 - 80)).toBeLessThanOrEqual(1);
			expect(file.geometry.width).toBe(360);
		}
		// 資料ごとの見出し(名前・Document Manager で開くリンク)を付け、資料とグループにする
		const caption = (await childrenOf(request, frame.id)).find((i) => i.type === "text" && i.data.content.includes(`仕様書${STAMP}.pdf`));
		expect(caption.data.content).toContain(`/api/documents/alias/${docs.pdf.alias}/viewer`);
		expect((await boardItems(request)).filter((i) => i.type === "group")).toHaveLength(3);
	});

	test("資料を変えても、頼まれるまでボードは変わらない(自動では書き出さない)", async ({request}) => {
		const before = await boardItems(request);
		const v2 = await upload(request, `仕様書${STAMP}.pdf`, Buffer.concat([PDF, Buffer.from("% v2\n")]), docs.pdf.id);
		await addToProject(request, projectId, await upload(request, `後から${STAMP}.pdf`, PDF));
		await request.delete(`api/projects/${projectId}/documents/${docs.png.id}`, {headers: rw});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const after = await boardItems(request);
		expect(after.length).toBe(before.length);
		expect(after.some((i) => i.replacedAt)).toBe(false);
		docs.pdfOld = docs.pdf;
		docs.pdf = v2;
	});

	test("同じ目印にもう一度書き出すと、前のフレームはそのままで、その右に新しいフレームを作る。古い版の ID でもいまの版を出す", async ({request}) => {
		const [first] = await framesOf(request);
		const firstChildren = await childrenOf(request, first.id);
		const record = await exportAndWait(request, projectId, {anchor: "設計書", documentIds: [docs.md.id, docs.pdfOld.id]});
		expect(record.state).toBe("done");
		const frames = await framesOf(request);
		expect(frames).toHaveLength(2);
		const second = frames.find((f) => f.id !== first.id);
		expect(boxOf(second).left).toBeGreaterThan(boxOf(first).right);
		expect(overlaps(boxOf(first), boxOf(second))).toBe(false);
		// 前のフレームの中は変わっていない
		expect(await childrenOf(request, first.id)).toEqual(firstChildren);
		const titles = (await childrenOf(request, second.id)).filter((i) => i.type === "document").map((i) => i.data.title);
		expect(titles).toEqual([`議事録${STAMP}.md`, `仕様書${STAMP}.pdf`]);
		expect(record.documents.find((d) => d.title === `仕様書${STAMP}.pdf`).documentId).toBe(docs.pdf.id);
	});

	test("人が Miro で書いた目印も読む(全角のかっこ・向きの書き方)。向きどおりに出し、ほかの付箋とは重ねない", async ({request}) => {
		await control(request, {addItem: {id: "9100000000000000001", type: "sticky_note", x: 0, y: 4000, width: 300, height: 300, content: "<p>［ＤＭ］定例</p><p>（下へ）</p><p>議事録を出す</p>"}});
		// 目印のすぐ下に、人が書いた付箋がある
		await control(request, {addItem: {id: "9100000000000000002", type: "sticky_note", x: 100, y: 4500, width: 400, height: 300, content: "<p>メモ</p>"}});
		const list = await (await request.get("api/miro/anchors", {headers: ro})).json();
		expect(list.anchors.find((a) => a.id === "9100000000000000001")).toMatchObject({name: "定例", direction: "down", note: "議事録を出す", problem: null});
		const record = await exportAndWait(request, projectId, {anchor: "定例", documentIds: [docs.md.id]});
		const frame = (await framesOf(request)).find((f) => f.id === record.frames[0].frameId);
		expect(record.frames[0].direction).toBe("down");
		expect(boxOf(frame).left).toBeCloseTo(-150, 3);
		expect(boxOf(frame).top).toBeGreaterThan(4150);
		const memo = (await boardItems(request)).find((i) => i.id === "9100000000000000002");
		expect(overlaps(boxOf(frame), boxOf(memo)), "人の付箋に重ねない").toBe(false);
		expect(boxOf(frame).top).toBeGreaterThan(boxOf(memo).bottom);
	});

	test("斜め: 同じ目印に出すたびに 右 → 上 → 右上 のマスへ。付箋の側の端でそろえ、上の段は下の段のフレームの上に積む。消したフレームのマスは空く", async ({request}) => {
		// ボードのほかのものから離れた所に、右上の目印(200 × 200。中心 (-20000, -20000))
		await control(request, {addItem: {id: "9150000000000000001", type: "sticky_note", x: -20000, y: -20000, width: 200, height: 200, content: "<p>[DM]右上の試し</p><p>(右上)</p>"}});
		const anchor = {left: -20100, right: -19900, top: -20100, bottom: -19900};
		const exportOne = async (doc) => {
			const record = await exportAndWait(request, null, {anchor: "右上の試し", documentIds: [doc.id]});
			expect(record.state).toBe("done");
			const frame = (await framesOf(request)).find((f) => f.id === record.frames[0].frameId);
			return {record, cell: record.frames[0].cell, box: boxOf(frame)};
		};
		const first = await exportOne(docs.md);
		const second = await exportOne(docs.png);
		const third = await exportOne(docs.pdf);
		expect([first.cell, second.cell, third.cell]).toEqual([[1, 0], [0, 1], [1, 1]]);
		// 右: 下の端を付箋の下の端に。上: 左の端を付箋の左の端に、下の段(右のフレーム)の上に。右上: 上と同じ段で、上のフレームの右
		expect(first.box.left).toBeCloseTo(anchor.right + 120, 3);
		expect(first.box.bottom).toBeCloseTo(anchor.bottom, 3);
		expect(second.box.left).toBeCloseTo(anchor.left, 3);
		expect(second.box.bottom).toBeCloseTo(Math.min(anchor.top, first.box.top) - 120, 3);
		expect(third.box.left).toBeCloseTo(second.box.right + 120, 3);
		expect(third.box.bottom).toBeCloseTo(second.box.bottom, 3);
		// 上のフレームを Miro で消すと、次はそのマスに出す
		await control(request, {deleteItem: second.record.frames[0].frameId});
		const again = await exportOne(docs.png);
		expect(again.cell).toEqual([0, 1]);
		expect(again.box.left).toBeCloseTo(anchor.left, 3);
	});

	test("向きは頼みで変えられる。目印の向きが読めないときは、向きを言われなければ断る", async ({request}) => {
		await control(request, {addItem: {id: "9100000000000000003", type: "sticky_note", x: -3000, y: 0, width: 300, height: 300, content: "<p>[DM]読めない</p><p>(ななめ)</p>"}});
		const list = await (await request.get("api/miro/anchors", {headers: ro})).json();
		expect(list.anchors.find((a) => a.name === "読めない").problem).toContain("向き");
		const res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, anchor: "読めない", documentIds: [docs.md.id]}});
		expect(res.status()).toBe(400);
		expect((await res.json()).code).toBe("anchor_unreadable");
		const record = await exportAndWait(request, projectId, {anchor: "読めない", direction: "左", documentIds: [docs.md.id]});
		const frame = (await framesOf(request)).find((f) => f.id === record.frames[0].frameId);
		expect(boxOf(frame).right).toBeLessThan(-3150);
	});

	test("無い目印は 404(ボードの目印の名前付き)、同じ名前が 2 つあれば 409", async ({request}) => {
		let res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, anchor: "無い目印", documentIds: [docs.md.id]}});
		expect(res.status()).toBe(404);
		let body = await res.json();
		expect(body.code).toBe("anchor_not_found");
		expect(body.anchors).toEqual(expect.arrayContaining(["設計書", "定例"]));
		await control(request, {addItem: {id: "9100000000000000004", type: "shape", x: -6000, y: 0, width: 300, height: 200, content: "<p>[dm] 設計書</p>"}});
		res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, anchor: "設計書", documentIds: [docs.md.id]}});
		expect(res.status()).toBe(409);
		body = await res.json();
		expect(body.code).toBe("anchor_ambiguous");
		expect(body.anchors).toHaveLength(2);
		await control(request, {deleteItem: "9100000000000000004"});
	});

	test("付箋・図形のリンクでも指せる。ほかのボードのリンク・正しくないリンクは断る", async ({request}) => {
		await control(request, {addItem: {id: "9100000000000000005", type: "shape", x: 0, y: -5000, width: 200, height: 200, content: "<p>ここ</p>"}});
		const record = await exportAndWait(request, projectId, {anchorUrl: `https://miro.com/app/board/${encodeURIComponent(BOARD)}/?moveToWidget=9100000000000000005&cot=14`, direction: "上", documentIds: [docs.md.id]});
		expect(record.anchor.kind).toBe("link");
		// 目印でないものを指したときのタイトルはプロジェクト名
		expect(record.frames[0].title).toMatch(new RegExp(`^Miro書き出し${STAMP} `));
		const frame = (await framesOf(request)).find((f) => f.id === record.frames[0].frameId);
		expect(boxOf(frame).bottom).toBeLessThan(-5100);
		expect(boxOf(frame).left).toBeCloseTo(-100, 3);
		expect((await request.post("api/miro/exports", {headers: rw, data: {project: projectId, anchorUrl: "https://miro.com/app/board/uXjVOther=/?moveToWidget=1", documentIds: [docs.md.id]}})).status()).toBe(400);
		expect((await request.post("api/miro/exports", {headers: rw, data: {project: projectId, anchorUrl: "https://example.com/", documentIds: [docs.md.id]}})).status()).toBe(400);
	});

	test("空いている所(free): ボードの中身の右に出す。向きごとの組で、1 回に複数のフレームを出せる", async ({request}) => {
		const right = Math.max(...(await boardItems(request)).filter((i) => i.parent == null && i.geometry && i.type !== "group").map((i) => boxOf(i).right));
		const record = await exportAndWait(request, projectId, {free: true, title: "打ち合わせ", groups: [
			{documentIds: [docs.pdf.id], direction: "right", title: "仕様"},
			{documentIds: [docs.md.id, docs.html.id], direction: "down"}
		]});
		expect(record.frames.map((f) => f.title.replace(STAMP_PATTERN, "").trim())).toEqual(["仕様", "打ち合わせ"]);
		const created = (await framesOf(request)).filter((f) => record.frames.some((r) => r.frameId === f.id));
		for (const frame of created) expect(boxOf(frame).left).toBeGreaterThan(right);
		expect(overlaps(boxOf(created[0]), boxOf(created[1]))).toBe(false);
		// 同じ資料を 2 つの組に入れる・組と documentIds を一緒に使う・資料の無い組は断る
		for (const data of [
			{free: true, groups: [{documentIds: [docs.md.id]}, {documentIds: [docs.md.id]}]},
			{free: true, documentIds: [docs.md.id], groups: [{documentIds: [docs.pdf.id]}]},
			{free: true, groups: [{documentIds: []}]},
			{free: true, anchor: "設計書", documentIds: [docs.md.id]},
			{free: true, documentIds: ["no-such-document"]},
			{free: true, direction: "ななめ"}
		]) {
			const res = await request.post("api/miro/exports", {headers: rw, data: {project: projectId, ...data}});
			expect(res.status(), JSON.stringify(data)).toBe(400);
			expect((await res.json()).details.length).toBeGreaterThan(0);
		}
	});

	test("履歴: 新しい順に、プロジェクト・目印・フレーム・件数が残る(資料ごとの結果は 1 件ずつの記録で)", async ({request}) => {
		const status = await (await request.get("api/miro/exports", {headers: ro})).json();
		expect(status).toMatchObject({available: true, exporting: false});
		expect(status.exports.length).toBeGreaterThanOrEqual(6);
		expect(status.exports[0]).toMatchObject({anchor: {kind: "free"}, project: {id: projectId, name: `Miro書き出し${STAMP}`}});
		expect(status.exports[0].documents).toBeUndefined();
		const first = status.exports.filter((e) => e.anchor.name === "設計書").at(-1);
		expect(first).toMatchObject({counts: {placed: 3, skipped: 1}});
		expect((await (await request.get(`api/miro/exports/${first.id}`, {headers: ro})).json()).documents).toHaveLength(4);
		expect((await request.get("api/miro/exports/no-such-export", {headers: ro})).status()).toBe(404);
		expect(status.directions.map((d) => d.id)).toContain("cross");
	});

	test("閲覧だけの権限では書き出せない。ログインしていなければ見られない", async ({request, playwright}) => {
		expect((await request.post("api/miro/exports", {headers: ro, data: {project: projectId, free: true}})).status()).toBe(403);
		const anonymous = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		try {
			expect((await anonymous.get("api/miro/exports")).status()).toBe(401);
			expect((await anonymous.get("api/miro/anchors")).status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});
});

test.describe.serial("十字で書き出す", () => {
	let projectId;
	const docs = {};

	test.beforeAll(async ({request}) => {
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = await newProject(request, `十字${STAMP}`);
		await request.put(`api/projects/${projectId}`, {headers: rw, data: {description: "受注管理の作り直し"}});
		for (const [key, name, tags] of [
			["req", `要件定義書${STAMP}.pdf`, ["工程:要件定義"]],
			["test", `結合テスト${STAMP}.pdf`, ["工程:結合テスト"]],
			["plan", `計画書${STAMP}.pdf`, ["区分:管理"]],
			["meeting", `定例 2026-10-05 ${STAMP}.pdf`, ["会議:定例"]],
			["memo", `ざっくり${STAMP}.pdf`, []]
		]) {
			docs[key] = await upload(request, name, PDF);
			if (tags.length > 0) await request.put(`api/documents/${docs[key].id}/tags`, {headers: rw, data: {tags}});
			await addToProject(request, projectId, docs[key]);
		}
		await control(request, {addItem: {id: "9200000000000000001", type: "sticky_note", x: 0, y: 0, width: 200, height: 200, content: "<p>[DM]全体</p><p>(十字)</p>"}});
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("タグで 4 つに分け、目印の斜め 4 つのフレームに出す。目印の下に概要カード、未分類はその下", async ({request}) => {
		const record = await exportAndWait(request, projectId, {anchor: "全体"});
		expect(record.state).toBe("done");
		const byArea = Object.fromEntries(record.frames.map((f) => [f.area, f]));
		expect(Object.keys(byArea).sort()).toEqual(["lower_left", "lower_right", "unclassified", "upper_left", "upper_right"]);
		expect(byArea.upper_left.title).toMatch(new RegExp(`^全体 / 要件定義〜設計 ${STAMP_PATTERN.source}`));
		const anchor = {left: -100, right: 100, top: -100, bottom: 100};
		const frames = await framesOf(request);
		const box = (area) => boxOf(frames.find((f) => f.id === byArea[area].frameId));
		expect(box("upper_left").right).toBeLessThan(anchor.left);
		expect(box("upper_left").bottom).toBeLessThan(anchor.top);
		expect(box("upper_right").left).toBeGreaterThan(anchor.right);
		expect(box("upper_right").bottom).toBeLessThan(anchor.top);
		expect(box("lower_left").right).toBeLessThan(anchor.left);
		expect(box("lower_right").left).toBeGreaterThan(anchor.right);
		const card = (await boardItems(request)).find((i) => i.type === "text" && i.parent == null && i.data.content.includes(`十字${STAMP}`));
		expect(card.data.content).toContain("受注管理の作り直し");
		expect(card.data.content).toContain("資料 5 件");
		expect(boxOf(card).top).toBeGreaterThan(anchor.bottom);
		expect(box("lower_left").top).toBeGreaterThan(card.position.y);
		expect(box("unclassified").top).toBeGreaterThan(Math.max(box("lower_left").bottom, box("lower_right").bottom));
		// 区画ごとの資料と見出しの色
		const titlesIn = async (area) => (await childrenOf(request, byArea[area].frameId)).filter((i) => i.type === "document").map((i) => i.data.title);
		expect(await titlesIn("upper_left")).toEqual([`要件定義書${STAMP}.pdf`]);
		expect(await titlesIn("lower_right")).toEqual([`定例 2026-10-05 ${STAMP}.pdf`]);
		expect(await titlesIn("unclassified")).toEqual([`ざっくり${STAMP}.pdf`]);
		const caption = (await childrenOf(request, byArea.upper_right.frameId)).find((i) => i.type === "text");
		expect(caption.style.fillColor).toBe("#f1efe8");
	});

	test("フレームの作成は 3 回までやり直す(3 回断られても、4 回目で通れば置ける)", async ({request}) => {
		const before = (await framesOf(request)).length;
		await control(request, {failFrames: 3});
		const record = await exportAndWait(request, projectId, {anchor: "全体", documentIds: [docs.req.id]});
		expect(record).toMatchObject({state: "done", error: null, retryDocumentIds: []});
		expect(record.counts).toMatchObject({placed: 1, failed: 0});
		expect((await framesOf(request)).length).toBe(before + 1);
	});

	test("Miro がフレームの作成を断り続けても、ほかのフレームと概要カードは置き切り、そのフレームの資料だけを失敗にする。出し直せる資料の ID を返す", async ({request}) => {
		const before = (await framesOf(request)).length;
		// やり直し(3 回)まですべて断る = 最初のフレーム(左上)だけ作れない
		await control(request, {failFrames: 4});
		const record = await exportAndWait(request, projectId, {anchor: "全体", documentIds: [docs.req.id, docs.plan.id, docs.meeting.id]});
		expect(record.state).toBe("done");
		expect(record.counts).toMatchObject({placed: 2, failed: 1});
		expect(record.error).toContain("1 件を置けませんでした");
		expect(record.documents.find((d) => d.documentId === docs.req.id)).toMatchObject({state: "failed", code: "miro_unavailable", retryable: true});
		expect(record.documents.find((d) => d.documentId === docs.req.id).reason).toContain("フレーム");
		expect(record.error).toContain("出し直せます");
		expect(record.retryDocumentIds).toEqual([docs.req.id]);
		expect(record.frames.map((f) => f.area).sort()).toEqual(["lower_right", "upper_right"]);
		expect((await framesOf(request)).length).toBe(before + 2);
		const cards = (await boardItems(request)).filter((i) => i.type === "text" && i.parent == null && i.data.content.includes(`十字${STAMP}`));
		expect(cards.length).toBeGreaterThanOrEqual(2);
	});

	test("同じ目印に十字をもう一度出すと、前の十字に重ならないよう、まとめて右に出す", async ({request}) => {
		const before = await framesOf(request);
		const record = await exportAndWait(request, projectId, {anchor: "全体", documentIds: [docs.req.id, docs.plan.id]});
		const created = (await framesOf(request)).filter((f) => !before.some((b) => b.id === f.id));
		expect(created).toHaveLength(2);
		for (const frame of created) for (const old of before) expect(overlaps(boxOf(frame), boxOf(old))).toBe(false);
		expect(record.frames.map((f) => f.area).sort()).toEqual(["upper_left", "upper_right"]);
	});
});

test.describe.serial("書き出したあとの手直し(書き出しごと。省くと自分の最後の書き出し)", () => {
	let projectId;
	const docs = {};
	let record;

	test.beforeAll(async ({request}) => {
		await control(request, {reset: true});
		await connectMiro(request);
		projectId = await newProject(request, `手直し${STAMP}`);
		for (const key of ["a", "b", "c"]) {
			docs[key] = await upload(request, `${key}-${STAMP}.pdf`, PDF);
			await addToProject(request, projectId, docs[key]);
		}
		await control(request, {addItem: {id: "9300000000000000001", type: "sticky_note", x: 0, y: 0, width: 200, height: 200, content: "<p>[DM]手直し</p>"}});
		record = await exportAndWait(request, projectId, {anchor: "手直し", direction: "right"});
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("無い書き出しは 404", async ({request}) => {
		expect((await request.get("api/miro/map?exportId=no-such-export", {headers: rw})).status()).toBe(404);
		expect((await request.post("api/miro/layout", {headers: rw, data: {exportId: "no-such-export", labels: [{text: "x", x: 100, y: 100}]}})).status()).toBe(404);
	});

	test("地図: フレームごとの資料の位置・人が足したもの・空いている所", async ({request}) => {
		const frameId = record.frames[0].frameId;
		await control(request, {addItem: {id: "9300000000000000002", type: "sticky_note", parentId: frameId, x: 1200, y: 650, width: 100, height: 100, content: "<p>人のメモ</p>"}});
		const map = await (await request.get(`api/miro/map?exportId=${record.id}`, {headers: ro})).json();
		expect(map.exportId).toBe(record.id);
		expect(map.frames).toHaveLength(1);
		const frame = map.frames[0];
		expect(frame).toMatchObject({frameId, direction: "right"});
		expect(frame.documents.map((d) => d.documentId)).toEqual([docs.a.id, docs.b.id, docs.c.id]);
		expect(frame.documents[0]).toMatchObject({x: 260, left: 80, width: 360});
		expect(frame.others).toEqual([expect.objectContaining({id: "9300000000000000002", text: "人のメモ"})]);
		expect(frame.freeSpace.below.top).toBeGreaterThan(frame.documents[0].bottomWithCaption);
		expect(map.missing).toEqual([]);
	});

	test("資料を動かせる(ほかの資料の下・位置)。はみ出すときはフレームを右・下へ広げる", async ({request}) => {
		let res = await request.patch(`api/miro/items/${docs.c.id}`, {headers: rw, data: {nextTo: docs.a.id, side: "below"}});
		expect(res.status(), await res.text()).toBe(200);
		const moved = await res.json();
		expect(moved.x).toBe(260);
		const frameBefore = (await framesOf(request))[0];
		res = await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {x: 3000, y: 400}});
		expect(res.status()).toBe(200);
		const frameAfter = (await framesOf(request))[0];
		expect(frameAfter.geometry.width).toBeGreaterThan(frameBefore.geometry.width);
		expect(boxOf(frameAfter).left).toBeCloseTo(boxOf(frameBefore).left, 3);
		expect(boxOf(frameAfter).top).toBeCloseTo(boxOf(frameBefore).top, 3);
		// 見出しも一緒に動く
		const caption = (await childrenOf(request, frameAfter.id)).find((i) => i.type === "text" && i.data.content.includes(`b-${STAMP}.pdf`));
		expect(caption.position.x).toBe(3000);
		// 正しくない指示
		expect((await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {}})).status()).toBe(400);
		expect((await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {x: -5, y: 10}})).status()).toBe(400);
		expect((await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {nextTo: docs.b.id}})).status()).toBe(400);
		expect((await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {frame: "無いフレーム", x: 10, y: 10}})).status()).toBe(404);
	});

	test("まとめて当てる: 資料の位置と色・見出しの文字・図形。当て直すと前の見出しと図形を片付ける", async ({request}) => {
		const res = await request.post("api/miro/layout", {headers: rw, data: {
			items: [{documentId: docs.a.id, x: 400, y: 600, color: "#eeedfe"}],
			labels: [{text: "まとめ", x: 400, y: 120, width: 500}],
			shapes: [{shape: "rectangle", x: 400, y: 600, width: 700, height: 900, fillOpacity: 0, borderColor: "#dc2626", borderWidth: 3, borderStyle: "dashed"}]
		}});
		expect(res.status()).toBe(200);
		expect(await res.json()).toMatchObject({moved: 1, labels: 1, shapes: 1});
		const frameId = record.frames[0].frameId;
		let children = await childrenOf(request, frameId);
		expect(children.some((i) => i.type === "text" && i.data.content.includes("まとめ"))).toBe(true);
		expect(children.filter((i) => i.type === "shape")).toHaveLength(1);
		const caption = children.find((i) => i.type === "text" && i.data.content.includes(`a-${STAMP}.pdf`));
		expect(caption.style.fillColor).toBe("#eeedfe");
		await request.post("api/miro/layout", {headers: rw, data: {labels: [{text: "やり直し", x: 400, y: 120}]}});
		children = await childrenOf(request, frameId);
		expect(children.some((i) => i.type === "text" && i.data.content.includes("まとめ"))).toBe(false);
		expect(children.filter((i) => i.type === "shape")).toHaveLength(0);
		// 人の付箋はそのまま
		expect(children.some((i) => i.id === "9300000000000000002")).toBe(true);
		// 正しくないところがあれば何も当てない
		const bad = await request.post("api/miro/layout", {headers: rw, data: {items: [{documentId: "no-such", x: 1, y: 1}], labels: [{text: "", x: 1, y: 1}]}});
		expect(bad.status()).toBe(400);
		expect((await bad.json()).details.length).toBe(2);
	});

	test("新しく書き出すと、書き出しを省いた手直しは新しいフレームに。前の書き出しも ID で指せば直せる", async ({request}) => {
		const next = await exportAndWait(request, projectId, {anchor: "手直し", documentIds: [docs.a.id]});
		const map = await (await request.get("api/miro/map", {headers: rw})).json();
		expect(map.exportId).toBe(next.id);
		expect(map.frames.map((f) => f.frameId)).toEqual([next.frames[0].frameId]);
		expect((await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {x: 100, y: 100}})).status()).toBe(404);
		const old = await request.patch(`api/miro/items/${docs.b.id}`, {headers: rw, data: {exportId: record.id, x: 500, y: 300}});
		expect(old.status()).toBe(200);
		expect((await old.json()).exportId).toBe(record.id);
	});
});

test.describe.serial("プロジェクトを指定せずに書き出す", () => {
	const docs = {};

	test.beforeAll(async ({request}) => {
		await control(request, {reset: true});
		await connectMiro(request);
		for (const [key, name, tags] of [["req", `要件定義書-単独${STAMP}.pdf`, ["工程:要件定義"]], ["plan", `計画書-単独${STAMP}.pdf`, ["区分:管理"]]]) {
			docs[key] = await upload(request, name, PDF);
			await request.put(`api/documents/${docs[key].id}/tags`, {headers: rw, data: {tags}});
		}
		await control(request, {addItem: {id: "9400000000000000001", type: "sticky_note", x: 0, y: 0, width: 200, height: 200, content: "<p>[DM]単独</p>"}});
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	const exportBare = async (request, body) => {
		const res = await request.post("api/miro/exports", {headers: rw, data: body});
		expect(res.status(), JSON.stringify(await res.json().catch(() => null))).toBe(202);
		const started = await res.json();
		let record;
		await expect.poll(async () => {
			record = await (await request.get(`api/miro/exports/${started.id}`, {headers: rw})).json();
			return record.state;
		}, {timeout: 15000}).not.toBe("running");
		return record;
	};

	test("文書 ID だけで書き出せる(プロジェクトに入っていない資料も)。タイトルは目印の名前", async ({request}) => {
		const record = await exportBare(request, {anchor: "単独", documentIds: [docs.req.id, docs.plan.id]});
		expect(record).toMatchObject({state: "done", project: null, counts: {placed: 2}});
		expect(record.frames[0].title).toMatch(new RegExp(`^単独 ${STAMP_PATTERN.source}`));
	});

	test("十字でも出せる。プロジェクトが無ければ概要カードは置かない", async ({request}) => {
		const before = (await boardItems(request)).filter((i) => i.type === "text" && i.parent == null).length;
		const record = await exportBare(request, {anchor: "単独", direction: "十字", documentIds: [docs.req.id, docs.plan.id]});
		expect(record.frames.map((f) => f.area).sort()).toEqual(["upper_left", "upper_right"]);
		expect((await boardItems(request)).filter((i) => i.type === "text" && i.parent == null).length).toBe(before);
	});

	test("目印も無く空いている所に出すと、タイトルは Document Manager。資料もプロジェクトも無ければ断る", async ({request}) => {
		const record = await exportBare(request, {free: true, documentIds: [docs.plan.id]});
		expect(record.frames[0].title).toMatch(new RegExp(`^Document Manager ${STAMP_PATTERN.source}`));
		const res = await request.post("api/miro/exports", {headers: rw, data: {free: true}});
		expect(res.status()).toBe(400);
		expect((await res.json()).details[0]).toContain("project");
		expect((await request.post("api/miro/exports", {headers: rw, data: {free: true, project: "no-such-project"}})).status()).toBe(404);
	});

	test("十字の報告も文書 ID だけで出せる", async ({request}) => {
		const report = await (await request.get(`api/miro/layout-report?documentIds=${docs.req.id},${docs.plan.id}`, {headers: ro})).json();
		expect(report.summary.areas).toMatchObject({upper_left: 1, upper_right: 1});
		expect((await request.get("api/miro/layout-report", {headers: ro})).status()).toBe(400);
	});
});

test.describe.serial("フロー図を描く(箱と線。資料の代わりに、目印の向きに新しいフレームで)", () => {
	const docs = {};
	const connectorsOf = async (request) => (await (await request.get(`${STUB_URL}/__connectors`)).json()).filter((c) => c.boardId === BOARD);
	const FLOW = {
		lanes: [{key: "sales", title: "営業"}, {key: "warehouse", title: "倉庫"}],
		nodes: [
			{key: "start", text: "受注", type: "start", lane: "sales"},
			{key: "check", text: "在庫はあるか", type: "decision", lane: "warehouse"},
			{key: "ship", text: "出荷", lane: "warehouse"},
			{key: "order", text: "仕入れ", type: "subprocess", lane: "warehouse"},
			{key: "bill", text: "請求", type: "end", lane: "sales"}
		],
		edges: [
			{from: "start", to: "check"}, {from: "check", to: "ship", label: "ある"}, {from: "check", to: "order", label: "ない", style: "dashed"},
			{from: "order", to: "ship"}, {from: "ship", to: "bill"}
		]
	};

	test.beforeAll(async ({request}) => {
		await control(request, {reset: true});
		await connectMiro(request);
		docs.manual = await upload(request, `出荷手順${STAMP}.pdf`, PDF);
		docs.spec = await upload(request, `受注仕様${STAMP}.pdf`, PDF);
		await control(request, {addItem: {id: "9500000000000000001", type: "sticky_note", x: 0, y: 0, width: 200, height: 200, content: "<p>[DM]業務フロー</p><p>(下)</p>"}});
	});

	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
	});

	test("箱と線の一覧を渡すと、目印の向きに新しいフレームを作り、レーン・箱・線を描く。箱の文書 ID は Document Manager で開くリンクになる", async ({request}) => {
		const flow = {...FLOW, nodes: FLOW.nodes.map((n) => (n.key === "ship" ? {...n, documentId: docs.manual.id} : n))};
		const record = await exportAndWait(request, null, {anchor: "業務フロー", diagram: flow, title: "受注から請求まで"});
		expect(record.state).toBe("done");
		expect(record.error).toBeNull();
		expect(record.frames).toHaveLength(1);
		expect(record.frames[0].title).toMatch(new RegExp(`^受注から請求まで ${STAMP_PATTERN.source}`));
		expect(record.frames[0].direction).toBe("down");
		expect(record.documents).toEqual([expect.objectContaining({kind: "diagram", state: "placed", nodes: 5, edges: 5})]);
		expect(record).toMatchObject({retryDocumentIds: [], retryDiagrams: []});
		const frameId = record.frames[0].frameId;
		const frame = (await framesOf(request)).find((f) => f.id === frameId);
		// 目印(-100〜100)の下に出る
		expect(boxOf(frame).top).toBeGreaterThan(100);
		const shapes = (await childrenOf(request, frameId)).filter((i) => i.type === "shape");
		// レーン 2 つ(帯と見出し)+ 箱 5 つ
		expect(shapes).toHaveLength(9);
		const byText = (text) => shapes.find((s) => s.data.content.includes(text));
		expect(byText("在庫はあるか").data.shape).toBe("rhombus");
		expect(byText("営業").data.content).toContain("<strong>営業</strong>");
		expect(byText("出荷").data.content).toMatch(/<a href="[^"]+\/api\/documents\/alias\/[^"]+\/viewer">出荷<\/a>/);
		// 箱はフレームの中に収まり、重ならない
		const nodes = Object.values(record.frames[0].diagram.nodes).map((id) => shapes.find((s) => s.id === id));
		expect(nodes).toHaveLength(5);
		for (const [i, a] of nodes.entries()) {
			expect(a.position.x - a.geometry.width / 2).toBeGreaterThanOrEqual(0);
			expect(a.position.y + a.geometry.height / 2).toBeLessThanOrEqual(frame.geometry.height);
			for (const b of nodes.slice(i + 1)) expect(overlaps(boxOf(a), boxOf(b))).toBe(false);
		}
		// 線は枠の外(ボード)に置かれ、箱どうしをつなぐ。文字と点線
		const connectors = await connectorsOf(request);
		expect(connectors).toHaveLength(5);
		const ids = record.frames[0].diagram.nodes;
		const no = connectors.find((c) => c.captions[0]?.content === "ない");
		expect(no).toMatchObject({startItem: {id: ids.check}, endItem: {id: ids.order}, shape: "elbowed"});
		expect(no.style).toMatchObject({strokeStyle: "dashed", endStrokeCap: "arrow"});
		// 履歴にも出る
		const history = await (await request.get("api/miro/exports", {headers: ro})).json();
		expect(history.exports[0]).toMatchObject({id: record.id, counts: {placed: 1, failed: 0}});
	});

	test("地図: フロー図の箱は key つきで出し、人が足したもの(others)に混ぜない", async ({request}) => {
		const history = await (await request.get("api/miro/exports", {headers: ro})).json();
		const map = await (await request.get(`api/miro/map?exportId=${history.exports[0].id}`, {headers: ro})).json();
		expect(map.frames[0].diagram.nodes.map((n) => n.key)).toEqual(["start", "check", "ship", "order", "bill"]);
		expect(map.frames[0].diagram.connectors).toBe(5);
		expect(map.frames[0].others).toEqual([]);
	});

	test("資料とフロー図を 1 回で出せる(groups)。指示の誤りは何もせずに理由の一覧で断る。十字では出さない", async ({request}) => {
		const before = (await framesOf(request)).length;
		const record = await exportAndWait(request, null, {anchor: "業務フロー", groups: [
			{documentIds: [docs.spec.id], direction: "右", title: "仕様"},
			{diagram: {nodes: [{key: "a", text: "受付"}, {key: "b", text: "回答"}], edges: [{from: "a", to: "b"}]}, direction: "右下", title: "問い合わせ"}
		]});
		expect(record.state).toBe("done");
		expect(record.documents.map((d) => d.kind ?? "document")).toEqual(["document", "diagram"]);
		expect((await framesOf(request)).length).toBe(before + 2);

		const bad = await request.post("api/miro/exports", {headers: rw, data: {anchor: "業務フロー", diagram: {nodes: [{key: "a", text: "受付"}], edges: [{from: "a", to: "z"}]}}});
		expect(bad.status()).toBe(400);
		expect((await bad.json()).details).toEqual([expect.stringContaining("diagram.edges[0].to「z」")]);
		const both = await request.post("api/miro/exports", {headers: rw, data: {anchor: "業務フロー", diagram: FLOW, documentIds: [docs.spec.id]}});
		expect(both.status()).toBe(400);
		const cross = await request.post("api/miro/exports", {headers: rw, data: {anchor: "業務フロー", diagram: FLOW, direction: "十字"}});
		expect(cross.status()).toBe(400);
		expect((await cross.json()).code).toBe("diagram_direction");
		expect((await framesOf(request)).length).toBe(before + 2);
	});

	test("Miro がフレームの作成を断り続けたら、図を失敗にして、出し直せる図の名前(retryDiagrams)を返す", async ({request}) => {
		await control(request, {failFrames: 4});
		const record = await exportAndWait(request, null, {anchor: "業務フロー", diagram: FLOW, title: "断られる図"});
		expect(record.documents).toEqual([expect.objectContaining({kind: "diagram", state: "failed", code: "miro_unavailable", retryable: true})]);
		expect(record.retryDiagrams).toEqual([expect.stringMatching(/^断られる図 \[/)]);
		expect(record.retryDocumentIds).toEqual([]);
	});

	test("手直しで線を引ける: key を付けた図形・フロー図の箱どうしをつなぐ。当て直すと前の線を片付ける", async ({request}) => {
		const history = await (await request.get("api/miro/exports", {headers: ro})).json();
		const diagramExport = history.exports.find((e) => e.title === "受注から請求まで");
		const layout = {
			exportId: diagramExport.id,
			shapes: [{key: "memo", shape: "rectangle", text: "例外: 返品", x: 200, y: 200, width: 200, height: 100}],
			connectors: [{from: "memo", to: "order", label: "返品なら", style: "dotted"}, {from: "start", to: "bill", arrow: "both"}]
		};
		const res = await request.post("api/miro/layout", {headers: rw, data: layout});
		expect(res.status(), await res.text()).toBe(200);
		expect(await res.json()).toMatchObject({shapes: 1, connectors: 2});
		const all = await connectorsOf(request);
		const memoLine = all.find((c) => c.captions[0]?.content === "返品なら");
		expect(memoLine.style).toMatchObject({strokeStyle: "dotted"});
		expect(all.find((c) => c.style.startStrokeCap === "arrow")).toBeTruthy();
		// 当て直すと、前に引いた線と図形を片付けてから引く
		const again = await request.post("api/miro/layout", {headers: rw, data: {exportId: diagramExport.id, connectors: [{from: "start", to: "ship"}]}});
		expect(again.status()).toBe(200);
		const after = await connectorsOf(request);
		expect(after.find((c) => c.captions[0]?.content === "返品なら")).toBeUndefined();
		expect(after.find((c) => c.style.startStrokeCap === "arrow")).toBeUndefined();
		// 無い key は何もせずに断る
		const bad = await request.post("api/miro/layout", {headers: rw, data: {exportId: diagramExport.id, connectors: [{from: "start", to: "nai"}]}});
		expect(bad.status()).toBe(400);
		expect((await bad.json()).details).toEqual([expect.stringContaining("「nai」")]);
	});
});
