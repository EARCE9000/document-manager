/*!
 * search-index.spec.js : 全文検索インデックスの制御(本文の保存上限・アーカイブの索引除外)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 1万件規模でのDB肥大を防ぐための2つの制御を検証する:
 *   - 本文は CONTENT_TEXT_MAX_CHARS(テストでは5000文字)までを検索対象として保存する
 *   - アーカイブ(論理削除)された文書は全文検索の索引から外し、復元時に入れ直す
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const upload = async (request, name, body) => (await (await request.post("api/documents", {
	headers: rw,
	multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body)}}
})).json());

const search = async (request, q, path = "api/documents") =>
	(await (await request.get(`${path}?q=${encodeURIComponent(q)}`, {headers: rw})).json());

test.describe.serial("全文検索インデックスの制御", () => {
	test("本文が上限を超えると、超過分は検索対象にならない(ファイル自体は影響なし)", async ({request}) => {
		const head = `先頭マーカー${Date.now()}`;
		const tail = `末尾マーカー${Date.now()}`;
		const name = `上限テスト_${Date.now()}.txt`;
		const body = `${head}\n${"あ".repeat(6000)}\n${tail}`;
		const doc = await upload(request, name, body);

		expect(doc.contentTruncated).toBe(true);
		expect(doc.contentTextMaxChars).toBe(5000);

		// 先頭は検索できるが、上限を超えた末尾は検索対象外
		expect((await search(request, head)).some((d) => d.id === doc.id)).toBe(true);
		expect((await search(request, tail)).some((d) => d.id === doc.id)).toBe(false);
		// ファイル名では見つかり、実体は切り詰められていない(全文をそのまま返す)
		expect((await search(request, "上限テスト")).some((d) => d.id === doc.id)).toBe(true);
		const file = await request.get(`api/documents/${doc.id}/file?download=1`, {headers: rw});
		expect((await file.body()).length).toBe(Buffer.byteLength(body));
	});

	test("上限以下の文書は切り詰めない", async ({request}) => {
		const doc = await upload(request, `上限内_${Date.now()}.txt`, "短い本文です");
		expect(doc.contentTruncated).toBe(false);
	});

	test("アーカイブすると本文検索の対象から外れ、アーカイブ側では本文で検索できる", async ({request}) => {
		const word = `索引除外マーカー${Date.now()}`;
		const doc = await upload(request, `索引テスト_${Date.now()}.txt`, `本文に${word}を含む`);
		expect((await search(request, word)).some((d) => d.id === doc.id)).toBe(true);

		expect((await request.delete(`api/documents/${doc.id}`, {headers: rw})).status()).toBe(204);
		// 通常の一覧からは消え、アーカイブ側では本文で見つかる(索引を使わない検索に切り替わる)
		expect((await search(request, word)).some((d) => d.id === doc.id)).toBe(false);
		expect((await search(request, word, "api/documents/archived")).some((d) => d.id === doc.id)).toBe(true);

		// 復元すると索引へ戻り、再び本文で検索できる
		expect((await request.post(`api/documents/${doc.id}/restore`, {headers: rw})).status()).toBe(200);
		expect((await search(request, word)).some((d) => d.id === doc.id)).toBe(true);
		// 復元を繰り返しても索引が二重にならない(検索結果が1件のまま)
		await request.delete(`api/documents/${doc.id}`, {headers: rw});
		await request.post(`api/documents/${doc.id}/restore`, {headers: rw});
		expect((await search(request, word)).filter((d) => d.id === doc.id).length).toBe(1);
	});

	test("新しい版のアップロードでアーカイブされた旧版も索引から外れる", async ({request}) => {
		const word = `旧版マーカー${Date.now()}`;
		const name = `版と索引_${Date.now()}.txt`;
		const v1 = await upload(request, name, `旧版の本文 ${word}`);
		expect((await search(request, word)).some((d) => d.id === v1.id)).toBe(true);

		const v2 = await (await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from("新版の本文")}, previousId: v1.id}
		})).json();
		expect(v2.previousId).toBe(v1.id);
		expect((await search(request, word)).some((d) => d.id === v1.id)).toBe(false);
		expect((await search(request, word, "api/documents/archived")).some((d) => d.id === v1.id)).toBe(true);
	});

	test("後から紐づけてアーカイブされた旧版も索引から外れる", async ({request}) => {
		const word = `後追いマーカー${Date.now()}`;
		const older = await upload(request, `後追い旧_${Date.now()}.txt`, `古い本文 ${word}`);
		const newer = await upload(request, `後追い新_${Date.now()}.txt`, "新しい本文");
		expect((await request.put(`api/documents/${newer.id}/previous`, {headers: rw, data: {previousId: older.id}})).status()).toBe(200);
		expect((await search(request, word)).some((d) => d.id === older.id)).toBe(false);
		expect((await search(request, word, "api/documents/archived")).some((d) => d.id === older.id)).toBe(true);
	});
});
