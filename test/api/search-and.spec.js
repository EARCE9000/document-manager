/*!
 * search-and.spec.js : スペース区切りのAND検索
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 「setup md」と打って rpi_python_setup.md を出したい。以前は入力全体を1つの語として
 * 扱っていたため、"setup md" という並びを探しに行って0件になっていた。
 *
 * 全角スペースも区切りにする。日本語入力のままスペースを打つと全角になるため、
 * 半角だけを見ていると「見つからない」が起きる。
 *
 * 語ごとの当たり判定は ファイル名 / 本文 / メモ / タグ のいずれか(OR)、語と語はAND。
 * 本文とファイル名はFTS5(trigram)で引くが、trigramは3文字ないと索引を引けないため
 * それより短い語はLIKEに落ちる。どちらの経路でも結果が同じであることを確かめる。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const STAMP = Date.now();
const SETUP = `rpi_python_setup_${STAMP}.md`;
const OTHER = `other_setup_${STAMP}.md`;
const TAGGED = `請求書_${STAMP}.txt`;

const search = async (request, q) => {
	const res = await request.get(`api/documents?q=${encodeURIComponent(q)}`, {headers: ro});
    expect(res.status()).toBe(200);
	return (await res.json()).map((d) => d.entryFile);
};

test.describe.serial("スペース区切りのAND検索", () => {
	test.beforeAll(async ({request}) => {
		const upload = async (name, body) => (await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body)}}
		})).json()).id;

		await upload(SETUP, "Raspberry Pi の環境構築手順です。apt で入れます。");
		await upload(OTHER, "こちらには構築の話は書いていません。");
		const taggedId = await upload(TAGGED, "本文には年が入っていない請求の控えです。");
		await request.put(`api/documents/${taggedId}/tags`, {headers: rw, data: {tags: ["2026年度", "経理"]}});
	});

	test("すべての語を含むものだけが出る", async ({request}) => {
		// 1語なら従来どおり
		expect(await search(request, `setup_${STAMP}`)).toEqual(expect.arrayContaining([SETUP, OTHER]));

		// 2語にすると絞り込まれる
		const both = await search(request, `rpi setup_${STAMP}`);
		expect(both).toContain(SETUP);
		expect(both, "片方しか含まないものまで出ている").not.toContain(OTHER);
	});

	test("元の困りごと: 「setup md」でファイル名が見つかる", async ({request}) => {
		const found = await search(request, `setup_${STAMP} md`);
		expect(found, "語の並びとして探しに行っている").toContain(SETUP);
	});

	test("全角スペースでも区切られる", async ({request}) => {
		const zenkaku = await search(request, `rpi　setup_${STAMP}`);
		expect(zenkaku, "全角スペースが区切りとして扱われていない").toContain(SETUP);
		expect(zenkaku).not.toContain(OTHER);
	});

	test("語の順番は問わない", async ({request}) => {
		const forward = await search(request, `rpi setup_${STAMP}`);
		const backward = await search(request, `setup_${STAMP} rpi`);
		expect(backward.sort()).toEqual(forward.sort());
	});

	test("前後や間に余分なスペースがあっても同じ", async ({request}) => {
		const plain = await search(request, `rpi setup_${STAMP}`);
		expect(await search(request, `  rpi 　 setup_${STAMP}  `)).toEqual(plain);
	});

	test("含まない語を混ぜると0件になる", async ({request}) => {
		expect(await search(request, `rpi setup_${STAMP} 存在しない語${STAMP}`)).toEqual([]);
	});

	// ファイル名・本文・メモ・タグにまたがって指定できることが、AND検索の使いどころ
	test("語ごとに当たる場所が違ってもよい(ファイル名とタグ)", async ({request}) => {
		const found = await search(request, `請求書_${STAMP} 2026年度`);
		expect(found, "ファイル名とタグにまたがる指定ができていない").toContain(TAGGED);
	});

	test("本文とタグにまたがる指定もできる", async ({request}) => {
		expect(await search(request, "請求の控え 経理")).toContain(TAGGED);
	});

	// trigramは3文字ないと索引を引けない。短い語だけLIKEに落として結果を揃えている
	test("3文字未満の語が混ざっても、同じように絞り込まれる", async ({request}) => {
		const found = await search(request, `setup_${STAMP} pi`);
		expect(found, "短い語が無視されている").toContain(SETUP);
		expect(found, "短い語で絞り込めていない").not.toContain(OTHER);
	});

	test("アーカイブ済みの検索でも同じように効く", async ({request}) => {
		const list = await (await request.get(`api/documents?q=${encodeURIComponent(OTHER)}`, {headers: ro})).json();
		await request.delete(`api/documents/${list[0].id}`, {headers: rw});

		const res = await request.get(`api/documents/archived?q=${encodeURIComponent(`setup_${STAMP} other`)}`, {headers: rw});
		expect(res.status()).toBe(200);
		const names = (await res.json()).map((d) => d.entryFile);
		expect(names).toContain(OTHER);
		expect(names, "アーカイブ側で絞り込めていない").not.toContain(SETUP);
	});
});
