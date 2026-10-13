/*!
 * html-pdf.spec.js : HTML・Markdown・MHTMLの文書を、PDFにしてダウンロードする
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 変換そのもの(Chromiumの挙動。崩れない・欠けない・スクリプトを動かさない)は
 * pdf-converter/test/smoke.js が実物に対して確かめる。
 * ここで確かめるのはアプリ側の振る舞い: 何を変換に渡すか、誰が使えるか、
 * 変換サービスが不調のときにどう答えるか。変換サービスにはスタブ(converter-stub.js)を使う。
 *
 * いちばん確かめたいのは「**プレビューで見えているものを渡している**」こと。Markdownの
 * 原本を渡してしまうと、記号がそのまま見える文字の羅列がPDFになる(人に渡す用途で致命的)。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");
const {MINIMAL_PDF} = require("./converter-stub.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
// APIキーは管理者になれないので、管理者の操作はログイン済みのセッションで行う
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};

// スタブの接続先(serve.jsが、Office用のスタブの10番あとで起動している)
const STUB_URL = process.env.PDF_STUB_URL || `http://127.0.0.1:${process.env.PDF_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 10}`;
const controlStub = async (request, control) => (await request.post(`${STUB_URL}/__control`, {data: control})).json();
const stubRequests = async (request) => (await request.get(`${STUB_URL}/__requests`)).json();

const STAMP = Date.now();

const upload = async (request, name, body) => {
	const res = await request.post("api/documents", {
		headers: rw,
		multipart: {uploadfile: {name, mimeType: "application/octet-stream", buffer: Buffer.from(body, "utf-8")}}
	});
	expect(res.status()).toBe(200);
	return res.json();
};

const MARKDOWN = "# 導入手順\n\n| 項目 | 値 |\n|---|---|\n| 上限 | 16 |\n";
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>報告</title></head><body><h1 id="origin">元のHTMLそのもの</h1></body></html>`;

test.describe.serial("PDFでダウンロード(HTML・Markdown・MHTML)", () => {
	test.beforeEach(async ({request}) => {
		await controlStub(request, {mode: "ok", blocked: 0, status: 500, reset: true});
	});
	test.afterAll(async ({request}) => {
		await controlStub(request, {mode: "ok", blocked: 0, status: 500, reset: true});
	});

	test("使える環境であることが、ログイン時の応答で分かる(画面がボタンを出す判断に使う)", async ({request}) => {
		const res = await request.get("api/check_access_token", {headers: {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`}});
		expect((await res.json()).htmlPdfEnabled).toBe(true);
	});

	// この機能の要
	test("Markdownは、原本ではなく整えたプレビューを渡す", async ({request}) => {
		const name = `手順書${STAMP}.md`;
		const doc = await upload(request, name, MARKDOWN);
		const res = await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/pdf");
		expect(Buffer.compare(await res.body(), MINIMAL_PDF), "変換サービスの返したPDFがそのまま返っていない").toBe(0);

		const [sent] = await stubRequests(request);
		expect(sent.path).toBe("/convert");
		expect(sent.bodyHead, "見出しが整えられていない(原本を渡している)").toContain("<h1>導入手順</h1>");
		expect(sent.bodyHead, "表が整えられていない").toContain("<table>");
		expect(sent.bodyHead, "Markdownの記号がそのまま渡っている").not.toContain("# 導入手順");
	});

	test("HTMLは、元のファイルをそのまま渡す", async ({request}) => {
		const doc = await upload(request, `報告${STAMP}.html`, HTML);
		expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: rw})).status()).toBe(200);
		const [sent] = await stubRequests(request);
		expect(sent.bodyHead).toBe(HTML);
	});

	// ファイル名には患者名・施設名などが入り得る。変換サービスのログにも残さない
	test("変換サービスへは、ファイル名を渡さない(文書IDだけ)", async ({request}) => {
		const secret = `山田太郎様_検査結果${STAMP}`;
		const doc = await upload(request, `${secret}.html`, HTML);
		await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
		const [sent] = await stubRequests(request);
		expect(sent.documentId).toBe(doc.id);
		expect(JSON.stringify(sent), "ファイル名が渡っている").not.toContain("山田太郎");
		expect(JSON.stringify(sent)).not.toContain(encodeURIComponent("山田太郎"));
	});

	test("保存するときの名前は、元の名前の拡張子を .pdf に替えたもの", async ({request}) => {
		const doc = await upload(request, `議事録 10月${STAMP}.md`, MARKDOWN);
		const res = await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
		const disposition = res.headers()["content-disposition"];
		expect(disposition).toMatch(/^attachment;/);
		expect(decodeURIComponent(disposition)).toContain(`議事録 10月${STAMP}.pdf`);
		expect(decodeURIComponent(disposition)).not.toContain(".md");
	});

	test("閲覧だけの権限でも使える(元ファイルのダウンロードと同じ)", async ({request}) => {
		const doc = await upload(request, `閲覧権限${STAMP}.html`, HTML);
		expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: ro})).status()).toBe(200);
	});

	test("認証なしでは使えない", async ({playwright}) => {
		const anonymous = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		try {
			const res = await anonymous.get("api/documents/202601_none/pdf");
			expect(res.status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});

	test("アーカイブ済みの文書でも使える(プレビュー・ダウンロードと揃える)", async ({request}) => {
		const doc = await upload(request, `アーカイブ${STAMP}.html`, HTML);
		expect((await request.delete(`api/documents/${doc.id}`, {headers: rw})).status()).toBe(204);
		expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: rw})).status()).toBe(200);
	});

	test("対象外の形式は400(変換サービスへは渡さない)", async ({request}) => {
		for (const [name, body] of [[`対象外${STAMP}.txt`, "テキスト"], [`対象外${STAMP}.csv`, "a,b\n1,2\n"]]) {
			const doc = await upload(request, name, body);
			const res = await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
			expect(res.status(), name).toBe(400);
			expect((await res.json()).error).toContain("HTML・Markdown・MHTML");
		}
		expect(await stubRequests(request), "対象外の文書を変換サービスへ渡している").toHaveLength(0);
	});

	test("存在しない文書は404", async ({request}) => {
		expect((await request.get("api/documents/209901_nothing/pdf", {headers: rw})).status()).toBe(404);
	});

	// 外部の画像は読み込ませないので、PDFでは抜ける。黙って渡させない
	test("読み込まなかった外部の部品の数を、応答で伝える", async ({request}) => {
		const doc = await upload(request, `外部画像${STAMP}.html`, HTML);
		await controlStub(request, {blocked: 3});
		const res = await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
		expect(res.headers()["x-blocked-requests"]).toBe("3");
	});

	test.describe("変換サービスが不調のとき", () => {
		let doc;
		test.beforeAll(async ({request}) => {
			doc = await upload(request, `不調${STAMP}.html`, HTML);
		});

		test("変換に失敗したら502(こちらの都合なので、利用者の入力の誤りにはしない)", async ({request}) => {
			await controlStub(request, {mode: "fail", status: 500});
			const res = await request.get(`api/documents/${doc.id}/pdf`, {headers: rw});
			expect(res.status()).toBe(502);
			expect(res.headers()["content-type"]).toContain("application/json");
			expect((await res.json()).error).toContain("変換サービス");
		});

		test("時間切れ・大きすぎは、そのまま伝える(利用者が次にすることが違うため)", async ({request}) => {
			for (const status of [504, 413]) {
				await controlStub(request, {mode: "fail", status});
				expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: rw})).status()).toBe(status);
			}
		});

		test("失敗のあと、直れば普通に使える。他の機能は巻き込まれない", async ({request}) => {
			await controlStub(request, {mode: "fail"});
			expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: rw})).status()).toBe(502);
			// プレビューと元ファイルのダウンロードは、変換サービスと無関係に動く
			expect((await request.get(`api/documents/${doc.id}/file`, {headers: rw})).status()).toBe(200);
			expect((await request.get(`api/documents/${doc.id}/file?download=1`, {headers: rw})).status()).toBe(200);
			await controlStub(request, {mode: "ok"});
			expect((await request.get(`api/documents/${doc.id}/pdf`, {headers: rw})).status()).toBe(200);
		});
	});

	test.describe("変換サービスの状態(管理画面用)", () => {
		test("管理者は状態を見られる", async ({request}) => {
			const res = await request.get("api/html-pdf/health", {headers: admin});
			expect(res.status()).toBe(200);
			const health = await res.json();
			expect(health).toMatchObject({enabled: true, reachable: true, chromium: "stub"});
			expect(health.checkedAt).toBeTruthy();
		});

		test("管理者以外は見られない", async ({request}) => {
			expect((await request.get("api/html-pdf/health", {headers: rw})).status()).toBe(403);
		});
	});
});
