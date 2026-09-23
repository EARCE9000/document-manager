/*!
 * office-render.spec.js : Office文書の体裁つき表示(PDF変換)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 変換そのもの(LibreOfficeの挙動)は converter/test/smoke.js が実物に対して確かめる。
 * ここで確かめるのはアプリ側の振る舞い: 変換を起動するか、結果を保存・記録するか、
 * 失敗しても他の機能に影響しないか、再実行できるか。
 * 変換サービスにはテスト用スタブ(converter-stub.js)を使う。
 */

const fs = require("node:fs");
const path = require("node:path");
const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const fixture = (name) => fs.readFileSync(path.join(__dirname, "..", "fixtures", "office", name));

// スタブの接続先(serve.jsが同じポートで起動している)
const STUB_URL = process.env.CONVERTER_STUB_URL || `http://127.0.0.1:${process.env.CONVERTER_STUB_PORT || 18096}`;
const setStubMode = async (request, control) =>
	(await request.post(`${STUB_URL}/__control`, {data: control})).json();
const stubRequests = async (request) => (await request.get(`${STUB_URL}/__requests`)).json();

const OFFICE_TYPES = {
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

const upload = async (request, name, fixtureName) => {
	const extension = path.extname(name).toLowerCase();
	const res = await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType: OFFICE_TYPES[extension] || "application/octet-stream", buffer: fixture(fixtureName)}}
	});
	expect(res.status()).toBe(200);
	return res.json();
};

// 変換は裏で走るため、状態が確定するまで待つ
const waitForRenderStatus = async (request, id, expected, timeoutMs = 15000) => {
	const until = Date.now() + timeoutMs;
	let status = null;
	while (Date.now() < until) {
		const doc = await (await request.get(`api/documents/${id}`, {headers: rw})).json();
		status = doc.renderStatus;
		if (status === expected) return doc;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`renderStatus が ${expected} になりませんでした(最後の値: ${status})`);
};

test.describe("Office文書の体裁つき表示(PDF変換)", () => {
	test("アップロードすると変換され、?render=1 でPDFを取得できる", async ({request}) => {
		const uploaded = await upload(request, `render-${Date.now()}.xlsx`, "sample.xlsx");
		// アップロードの応答を変換が待たせないこと(即座に返り、状態は未確定でよい)
		expect(["pending", "ok", null]).toContain(uploaded.renderStatus ?? null);

		const doc = await waitForRenderStatus(request, uploaded.id, "ok");
		expect(doc.renderError).toBeNull();

		const pdf = await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw});
		expect(pdf.status()).toBe(200);
		expect(pdf.headers()["content-type"]).toContain("application/pdf");
		expect((await pdf.body()).subarray(0, 4).toString("latin1")).toBe("%PDF");

		// 概要プレビュー(HTML)とダウンロード(元ファイル)は従来どおり
		const preview = await request.get(`api/documents/${uploaded.id}/file`, {headers: rw});
		expect(preview.headers()["content-type"]).toContain("text/html");
		const original = await request.get(`api/documents/${uploaded.id}/file?download=1`, {headers: rw});
		expect((await original.body()).subarray(0, 2).toString("latin1")).toBe("PK");

		await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
	});

	test("Word・PowerPointも変換される", async ({request}) => {
		for (const [name, fixtureName] of [["render.docx", "sample.docx"], ["render.pptx", "sample.pptx"]]) {
			const uploaded = await upload(request, `${Date.now()}-${name}`, fixtureName);
			await waitForRenderStatus(request, uploaded.id, "ok");
			const pdf = await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw});
			expect(pdf.status(), name).toBe(200);
			await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
		}
	});

	test("変換サービスへファイル名を渡さない(拡張子と文書IDだけ)", async ({request}) => {
		// ファイル名には患者名・施設名等が入り得るため、変換サービスには渡さない
		await setStubMode(request, {mode: "ok", reset: true});
		const name = `患者名を含む資料-${Date.now()}.xlsx`;
		const uploaded = await upload(request, name, "sample.xlsx");
		await waitForRenderStatus(request, uploaded.id, "ok");

		const received = (await stubRequests(request)).find((r) => r.documentId === uploaded.id);
		expect(received, "変換サービスが呼ばれている").toBeTruthy();
		expect(received.extension).toBe(".xlsx");
		expect(received.documentId).toBe(uploaded.id);
		// ファイル名を運ぶヘッダーが一切付いていないこと
		expect(received.headerNames).not.toContain("x-filename");
		expect(received.headerNames.join(",")).not.toMatch(/filename|disposition/i);
		expect(JSON.stringify(received)).not.toContain("患者名");

		await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
	});

	test("マクロ付きは変換に出さない(概要プレビューだけで扱う)", async ({request}) => {
		const uploaded = await upload(request, `macro-${Date.now()}.xlsm`, "sample.xlsx");
		expect(uploaded.previewFile).toBe("preview.html");
		// 少し待っても pending/ok にならない(そもそも変換に出していない)
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const doc = await (await request.get(`api/documents/${uploaded.id}`, {headers: rw})).json();
		expect(doc.renderStatus).toBeNull();
		expect((await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw})).status()).toBe(404);
		await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
	});

	test("Office以外は変換の対象外", async ({request}) => {
		const res = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: `plain-${Date.now()}.md`, mimeType: "text/markdown", buffer: Buffer.from("# 文書")}}
		});
		const doc = await res.json();
		expect(doc.renderStatus ?? null).toBeNull();
		expect((await request.get(`api/documents/${doc.id}/file?render=1`, {headers: rw})).status()).toBe(404);
		await request.delete(`api/documents/${doc.id}`, {headers: rw});
	});

	test("変換に失敗しても登録・検索・概要プレビューは使える", async ({request}) => {
		await setStubMode(request, {mode: "fail"});
		try {
			const uploaded = await upload(request, `renderfail-${Date.now()}.xlsx`, "sample.xlsx");
			const doc = await waitForRenderStatus(request, uploaded.id, "failed");
			expect(doc.renderError).toContain("HTTP 500");

			// 体裁つき表示は出せないが、他は普通に使える
			const render = await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw});
			expect(render.status()).toBe(404);
			expect((await render.json()).renderStatus).toBe("failed");
			expect(doc.previewFile).toBe("preview.html");
			const preview = await request.get(`api/documents/${uploaded.id}/file`, {headers: rw});
			expect(preview.status()).toBe(200);
			expect(await preview.text()).toContain("サンプル商事");
			const search = await (await request.get("api/documents?q=" + encodeURIComponent("サンプル商事"), {headers: rw})).json();
			expect(search.some((d) => d.id === uploaded.id)).toBe(true);

			// 復旧後に再実行すれば体裁つき表示が使えるようになる
			await setStubMode(request, {mode: "ok"});
			const retried = await request.post(`api/documents/${uploaded.id}/render/retry`, {headers: rw});
			expect((await retried.json()).renderStatus).toBe("ok");
			expect((await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw})).status()).toBe(200);

			await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
		} finally {
			await setStubMode(request, {mode: "ok"});
		}
	});

	test("変換サービスが応答しなくても、待たされるのは変換だけ", async ({request}) => {
		// 変換が遅くても、アップロードの応答・検索・概要プレビューは待たされない
		await setStubMode(request, {mode: "slow", delayMs: 4000});
		try {
			const started = Date.now();
			const uploaded = await upload(request, `slow-${Date.now()}.xlsx`, "sample.xlsx");
			const uploadMs = Date.now() - started;
			expect(uploadMs, "アップロードは変換を待たない").toBeLessThan(3000);

			const doc = await (await request.get(`api/documents/${uploaded.id}`, {headers: rw})).json();
			expect(doc.renderStatus).toBe("pending");
			expect((await request.get(`api/documents/${uploaded.id}/file`, {headers: rw})).status()).toBe(200);
			expect((await request.get(`api/documents/${uploaded.id}/file?render=1`, {headers: rw})).status()).toBe(404);

			// 遅れて完了する
			await waitForRenderStatus(request, uploaded.id, "ok");
			await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
		} finally {
			await setStubMode(request, {mode: "ok"});
		}
	});

	test("再実行APIで変換をやり直せる", async ({request}) => {
		const uploaded = await upload(request, `retry-${Date.now()}.pptx`, "sample.pptx");
		await waitForRenderStatus(request, uploaded.id, "ok");

		const retried = await request.post(`api/documents/${uploaded.id}/render/retry`, {headers: rw});
		expect(retried.status()).toBe(200);
		expect((await retried.json()).renderStatus).toBe("ok");

		// 対象外の文書では400
		const plain = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: `retry-${Date.now()}.md`, mimeType: "text/markdown", buffer: Buffer.from("# x")}}
		});
		const plainDoc = await plain.json();
		expect((await request.post(`api/documents/${plainDoc.id}/render/retry`, {headers: rw})).status()).toBe(400);

		// 存在しない文書は404
		expect((await request.post("api/documents/00000000-0000-0000-0000-000000000000/render/retry", {headers: rw})).status()).toBe(404);

		await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
		await request.delete(`api/documents/${plainDoc.id}`, {headers: rw});
	});

	test("readonlyキーでは再実行できない", async ({request}) => {
		const uploaded = await upload(request, `ro-${Date.now()}.xlsx`, "sample.xlsx");
		const res = await request.post(`api/documents/${uploaded.id}/render/retry`, {
			headers: {Authorization: `Bearer ${keys.readonly}`}
		});
		expect(res.status()).toBe(403);
		await request.delete(`api/documents/${uploaded.id}`, {headers: rw});
	});
});
