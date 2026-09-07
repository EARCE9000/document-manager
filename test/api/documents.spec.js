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
		// txtはスクリプトを実行しないためCSP対象外(プレビュー等のUXに影響させない)
		expect(full.headers()["content-security-policy"]).toBeFalsy();

		const partial = await request.get(`api/documents/${documentId}/file`, {headers: {...rw, Range: "bytes=0-3"}});
		expect(partial.status()).toBe(206);
		expect(partial.headers()["content-range"]).toBeTruthy();
	});

	// 保存型XSS対策: アップロードされたhtml/htm/svgは変換されずinline配信されるため、
	// 配信時にscript-src 'none'等のCSPを付けてスクリプト実行を無効化している(server.js参照)。
	// スクリプトを実行し得る形式にはCSPが付くこと・txt等の非実行形式には付かないこと(上記)を
	// 併せて検証し、防御の有無とスコープ(UX非影響)の両方を回帰から守る
	test("html/svg等のスクリプト実行可能形式にはCSP(script-src 'none')が付与される", async ({request}) => {
		const uploaded = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "xss-test.html", mimeType: "text/html", buffer: Buffer.from("<html><body><script>document.title='xss'</script>hello</body></html>")}}
		});
		expect(uploaded.status()).toBe(200);
		const htmlId = (await uploaded.json()).id;

		const res = await request.get(`api/documents/${htmlId}/file`, {headers: rw});
		expect(res.status()).toBe(200);
		const csp = res.headers()["content-security-policy"];
		expect(csp).toBeTruthy();
		expect(csp).toContain("script-src 'none'");

		// このテストで作成した文書は後続の一覧・件数に影響させないようアーカイブしておく
		await request.delete(`api/documents/${htmlId}`, {headers: rw});
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
