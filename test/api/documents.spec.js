/*!
 * documents.spec.js : 文書のアップロード/一覧/タグ/メモ/アーカイブ(論理削除)/復元のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * readwriteキーで実際のルートを一通り叩き、副作用(DB・ストレージ)込みで検証する。
 * 直列(serial)で実行し、アップロードした文書IDを後続テストで使い回す。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

test.describe.serial("文書ライフサイクル", () => {
	let documentId;

	test("readonlyキーではアップロードできない(403)", async ({request}) => {
		const res = await request.post("api/documents", {
			headers: ro,
			multipart: {uploadfile: {name: "denied.txt", mimeType: "text/plain", buffer: Buffer.from("denied")}}
		});
		expect(res.status()).toBe(403);
	});

	test("readwriteキーで .txt をアップロードできる(200)", async ({request}) => {
		const res = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "テスト文書.txt", mimeType: "text/plain", buffer: Buffer.from("これは全文検索用のテスト本文です rangetest")}}
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.id).toBeTruthy();
		expect(body.entryFile).toBe("テスト文書.txt");
		documentId = body.id;
	});

	test("拡張子が許可外だと400", async ({request}) => {
		const res = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "bad.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x")}}
		});
		expect(res.status()).toBe(400);
	});

	test("一覧にアップロードした文書が含まれる", async ({request}) => {
		const res = await request.get("api/documents", {headers: rw});
		expect(res.status()).toBe(200);
		const list = await res.json();
		expect(list.some((d) => d.id === documentId)).toBe(true);
	});

	test("タグを更新できる", async ({request}) => {
		const res = await request.put(`api/documents/${documentId}/tags`, {headers: rw, data: {tags: ["設計", "要件", "設計"]}});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.tags).toEqual(["設計", "要件"]); // PUT応答は入力順から重複を除去したもの

		const listRes = await request.get("api/documents", {headers: rw});
		const doc = (await listRes.json()).find((d) => d.id === documentId);
		// 一覧のtagsはSQL側で ORDER BY tag のためソート順で返る。順序非依存で比較する
		expect([...doc.tags].sort()).toEqual(["設計", "要件"].sort());
	});

	test("メモを更新できる", async ({request}) => {
		const res = await request.put(`api/documents/${documentId}/memo`, {headers: rw, data: {memo: "テストメモ"}});
		expect(res.status()).toBe(200);
		expect((await res.json()).memo).toBe("テストメモ");
	});

	test("ファイル本体を取得できる(Range無し=200、Range指定=206)", async ({request}) => {
		const full = await request.get(`api/documents/${documentId}/file`, {headers: rw});
		expect(full.status()).toBe(200);

		const partial = await request.get(`api/documents/${documentId}/file`, {headers: {...rw, Range: "bytes=0-3"}});
		expect(partial.status()).toBe(206);
		expect(partial.headers()["content-range"]).toBeTruthy();
	});

	test("アーカイブ(論理削除)すると一覧から消え、ゴミ箱に現れる", async ({request}) => {
		const del = await request.delete(`api/documents/${documentId}`, {headers: rw});
		expect(del.status()).toBe(204);

		const list = await (await request.get("api/documents", {headers: rw})).json();
		expect(list.some((d) => d.id === documentId)).toBe(false);

		const trash = await (await request.get("api/documents/trash", {headers: rw})).json();
		expect(trash.some((d) => d.id === documentId)).toBe(true);
	});

	test("復元すると再び一覧に現れる", async ({request}) => {
		const res = await request.post(`api/documents/${documentId}/restore`, {headers: rw});
		expect(res.status()).toBe(200);

		const list = await (await request.get("api/documents", {headers: rw})).json();
		expect(list.some((d) => d.id === documentId)).toBe(true);
	});
});
