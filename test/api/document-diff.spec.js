/*!
 * document-diff.spec.js : 版の差分(api/documents/:id/diff)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 1 つ前の版との差分(足した行・消した行・行の中の変わった文字)、base で選んだ版との差分、
 * 前の版が無いとき(400)、画像のように本文の無い版(比べられない)、本文が同じ版、全文の表示を確かめる。
 * 比べるのは本文(テキスト)だけ。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const upload = async (request, name, body, previousId, mimeType = "text/markdown") => {
	const res = await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType, buffer: Buffer.from(body)}, ...(previousId == null ? {} : {previousId})}
	});
	expect(res.status()).toBe(200);
	return (await res.json()).id;
};

// 1x1 の透明な PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test.describe.serial("版の差分", () => {
	const V1 = ["# 手順書", "", "1. 準備する", "2. 本文はこれです。", "3. 片付ける", ...Array.from({length: 20}, (_, i) => `行 ${i + 1}`)].join("\n");
	const V2 = ["# 手順書", "", "1. 準備する", "2. 本文はこちらです。", "2.5 確かめる", "3. 片付ける", ...Array.from({length: 20}, (_, i) => `行 ${i + 1}`)].join("\n");
	const V3 = V2.replace("行 20", "行 20(最後)");
	let v1;
	let v2;
	let v3;

	test.beforeAll(async ({request}) => {
		v1 = await upload(request, "差分の手順書.md", V1);
		v2 = await upload(request, "差分の手順書.md", V2, v1);
		v3 = await upload(request, "差分の手順書.md", V3, v2);
	});

	test("1 つ前の版との差分: 足した行・消した行と、行の中の変わった文字(閲覧のみのキーでも読める)", async ({request}) => {
		const res = await request.get(`api/documents/${v2}/diff`, {headers: ro});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({status: "changed", added: 2, removed: 1, clipped: false});
		expect(body.base).toMatchObject({id: v1, entryFile: "差分の手順書.md", source: "file", truncated: false, archived: true});
		expect(body.target).toMatchObject({id: v2, source: "file"});
		const lines = body.hunks.flatMap((h) => h.lines);
		const del = lines.find((l) => l.type === "del");
		expect(del).toMatchObject({oldNo: 4, newNo: null, text: "2. 本文はこれです。"});
		expect(del.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(["れ"]);
		const added = lines.filter((l) => l.type === "add");
		expect(added.map((l) => l.text)).toEqual(["2. 本文はこちらです。", "2.5 確かめる"]);
		expect(added[0].segments.filter((s) => s.changed).map((s) => s.text)).toEqual(["ちら"]);
		// 前後は 3 行まで(遠く離れた「行 20」などは出ない)
		expect(lines.some((l) => l.text === "行 20")).toBe(false);
	});

	test("base で選んだ版と比べられ、context=all で全文を返す", async ({request}) => {
		const body = await (await request.get(`api/documents/${v3}/diff?base=${v1}&context=all`, {headers: ro})).json();
		expect(body).toMatchObject({status: "changed", added: 3, removed: 2});
		expect(body.base.id).toBe(v1);
		const lines = body.hunks.flatMap((h) => h.lines);
		// 全文なので、変わっていない先頭の行も入る
		expect(lines[0]).toMatchObject({type: "same", oldNo: 1, newNo: 1, text: "# 手順書"});
		expect(lines.filter((l) => l.type !== "del")).toHaveLength(V3.split("\n").length);
	});

	test("前の版が無い版は 400(base を指定すれば比べられる)", async ({request}) => {
		const res = await request.get(`api/documents/${v1}/diff`, {headers: ro});
		expect(res.status()).toBe(400);
		expect((await res.json()).code).toBe("no_base");
		const reversed = await (await request.get(`api/documents/${v1}/diff?base=${v2}`, {headers: ro})).json();
		expect(reversed).toMatchObject({status: "changed", added: 1, removed: 2});
	});

	test("無い文書・無い base は 404", async ({request}) => {
		expect((await request.get("api/documents/no-such-id/diff", {headers: ro})).status()).toBe(404);
		const res = await request.get(`api/documents/${v2}/diff?base=no-such-id`, {headers: ro});
		expect(res.status()).toBe(404);
		expect((await res.json()).code).toBe("base_not_found");
	});

	test("本文が同じなら same(改行の書き方と末尾の改行の違いは数えない)", async ({request}) => {
		const a = await upload(request, "改行の違い.txt", "一行目\r\n二行目\r\n", null, "text/plain");
		const b = await upload(request, "改行の違い.txt", "一行目\n二行目", a, "text/plain");
		expect(await (await request.get(`api/documents/${b}/diff`, {headers: ro})).json()).toMatchObject({status: "same", added: 0, removed: 0, hunks: []});
	});

	test("画像のように本文の無い版は比べられない(not_comparable)", async ({request}) => {
		const a = await upload(request, "図.png", PNG, null, "image/png");
		const b = await upload(request, "図.png", PNG, a, "image/png");
		expect(await (await request.get(`api/documents/${b}/diff`, {headers: ro})).json()).toMatchObject({status: "not_comparable", reason: "image"});
	});

	// 試験のサーバーは本文を 5000 文字で切る(playwright.config.js の CONTENT_TEXT_MAX_CHARS)
	test("本文が切ってあるテキストの版は、ファイルを読み直して最後まで比べる", async ({request}) => {
		const long = Array.from({length: 1000}, (_, i) => `line ${String(i + 1).padStart(4, "0")}`).join("\n");
		const a = await upload(request, "長い記録.txt", long, null, "text/plain");
		const b = await upload(request, "長い記録.txt", long.replace("line 0999", "line 0999 changed"), a, "text/plain");
		const body = await (await request.get(`api/documents/${b}/diff`, {headers: ro})).json();
		expect(body).toMatchObject({status: "changed", added: 1, removed: 1});
		expect(body.base).toMatchObject({source: "file", truncated: false});
		expect(body.hunks.flatMap((h) => h.lines).find((l) => l.type === "add").newNo).toBe(999);
	});

	test("Office 文書は取り出した本文を比べる(source が extracted)", async ({request}) => {
		const docx = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "fixtures", "office", "sample.docx"));
		const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		const a = await upload(request, "差分の議事録.docx", docx, null, mime);
		const b = await upload(request, "差分の議事録.docx", docx, a, mime);
		const body = await (await request.get(`api/documents/${b}/diff`, {headers: ro})).json();
		expect(body).toMatchObject({status: "same", base: {source: "extracted"}, target: {source: "extracted"}});
	});

	test("未認証は 401", async ({request}) => {
		expect((await request.get(`api/documents/${v2}/diff`)).status()).toBe(401);
	});
});
