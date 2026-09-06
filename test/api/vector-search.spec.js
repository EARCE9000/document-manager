/*!
 * vector-search.spec.js : 意味検索(ベクトル検索)APIのテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * AI(Claude Desktop等)がAPIキーで意味検索を利用する経路を検証する。
 *  - 未認証は401
 *  - Weaviate未設定なら503(機能無効)
 *  - Weaviate有効なら、アップロード文書を索引完了後に意味検索で発見できる
 *    (本文に無い語でヒットすることでセマンティック検索であることを確認する)
 *
 * WEAVIATE_URL がテストサーバに渡っているかで挙動を出し分ける。未設定時はE2Eをスキップする。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
const weaviateEnabled = !!process.env.WEAVIATE_URL;

test.describe("意味検索(ベクトル検索)API", () => {
	test("未認証は401", async ({request}) => {
		const res = await request.get("api/documents/search/vector?q=test");
		expect(res.status()).toBe(401);
	});

	test("Weaviate未設定時は503(機能無効)", async ({request}) => {
		test.skip(weaviateEnabled, "Weaviate有効のためこのケースは対象外");
		const res = await request.get("api/documents/search/vector?q=test", {headers: ro});
		expect(res.status()).toBe(503);
	});

	test("Weaviate有効時: アップロード文書を意味検索で発見できる", async ({request}) => {
		test.skip(!weaviateEnabled, "WEAVIATE_URL未設定のためスキップ");
		test.setTimeout(120000); // 埋め込み計算・索引付けに時間がかかるため延長

		// 本文には「動物」という語を含めない(後で「動物」で意味検索してヒットさせる)
		const up = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "ペット.txt", mimeType: "text/plain", buffer: Buffer.from("犬と猫はペットとして人気があります。多くの家庭で飼われています。")}}
		});
		expect(up.status()).toBe(200);
		const docId = (await up.json()).id;

		// 索引付け(バックグラウンド・非同期)が完了(status=ok)するまで待つ
		await expect.poll(async () => {
			const s = await request.get("api/documents/vector-index/status", {headers: rw});
			if (s.status() !== 200) return `http_${s.status()}`;
			const row = (await s.json()).documents.find((d) => d.id === docId);
			return row ? row.status : "not_listed";
		}, {timeout: 90000, intervals: [1000, 2000, 3000, 5000]}).toBe("ok");

		// 本文に無い語「動物」で意味検索 → ベクトル的に近い当該文書がヒットする
		const res = await request.get(`api/documents/search/vector?q=${encodeURIComponent("動物")}`, {headers: ro});
		expect(res.status()).toBe(200);
		const hits = await res.json();
		expect(Array.isArray(hits)).toBe(true);
		expect(hits.some((h) => h.id === docId)).toBe(true);
	});
});
