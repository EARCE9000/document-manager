/*!
 * project-link.spec.js : おしながきのMarkdownに入る、資料を開くリンクとプロジェクトを開くリンク
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * おしながきのMarkdownは、メールや議事録に貼って人に渡すもの。名前だけ渡すと、受け取った人が
 * 自分で探し直すことになる。各資料に「そこから開けるリンク」を付ける。
 *
 * いちばん確かめたいのは「**渡したあとで資料を更新しても、リンクが最新版を指す**」こと。
 * その時点の版を指すURLにしてしまうと、見た目は正常なまま古い版へ案内し続ける。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
const session = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};

const STAMP = Date.now();

const upload = async (request, name, body, previousId) => {
	const multipart = {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body, "utf-8")}};
	if (previousId) multipart.previousId = previousId;
	const res = await request.post("api/documents", {headers: rw, multipart});
	expect(res.status()).toBe(200);
	return res.json();
};

/** Markdownの `[名前](URL)` を {名前: URL} にする */
const linksOf = (markdown) => Object.fromEntries([...markdown.matchAll(/\*\*\[((?:\\.|[^\]\\])+)\]\(([^)]+)\)\*\*/g)]
	.map((m) => [m[1].replace(/\\(.)/g, "$1"), m[2]]));

test.describe.serial("おしながきのリンク", () => {
	const COVER = `表紙${STAMP}.txt`;
	const SPEC = `仕様[第1版]${STAMP}.txt`;
	let projectId;
	let folderId;
	let cover;
	let spec;

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `リンクPJ ${STAMP}`}})).json()).id;
		folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件"}})).json()).id;
		cover = await upload(request, COVER, "表紙の本文");
		spec = await upload(request, SPEC, "仕様の本文 v1");
		await request.put(`api/projects/${projectId}/documents/${cover.id}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${projectId}/documents/${spec.id}`, {headers: rw, data: {folderId}});
	});

	const markdownOf = async (request, query = "") =>
		(await request.get(`api/projects/${projectId}/manifest.md${query}`, {headers: ro})).text();

	test("各資料に、共有リンク(版が変わっても同じURL)が付く", async ({request}) => {
		const links = linksOf(await markdownOf(request));
		expect(Object.keys(links).sort()).toEqual([COVER, SPEC].sort());
		// 公開しているURLから始まる、そのまま開ける形
		expect(links[COVER]).toBe(`${BASE_URL}/api/documents/alias/${cover.alias}/viewer`.replace(/([^:])\/\//g, "$1/"));
		expect(links[SPEC]).toContain(`/api/documents/alias/${spec.alias}/viewer`);
		// その版を指すURL(文書ID)にはしない
		expect(links[COVER]).not.toContain(cover.id);
	});

	// 名前に [ ] が入っていると、何もしなければリンクが途中で切れる
	test("名前に角括弧が入っていても、リンクが壊れない", async ({request}) => {
		const markdown = await markdownOf(request);
		expect(markdown).toContain(`[仕様\\[第1版\\]${STAMP}.txt](`);
	});

	test("リンクは、ログインしていれば実際に開ける", async ({request}) => {
		const links = linksOf(await markdownOf(request));
		const res = await request.get(links[COVER], {headers: session, maxRedirects: 5});
		expect(res.status()).toBe(200);
	});

	// この機能の要。おしながきは渡したあとも読まれ続ける
	test("渡したあとで資料を更新しても、同じリンクが最新版を開く", async ({request}) => {
		const before = linksOf(await markdownOf(request))[COVER];
		const v2 = await upload(request, COVER, "表紙の本文 第2版", cover.id);

		// 渡してあるリンクは開けて、指している先は新しい版になっている
		// (リンクそのものは「新しい版があります」を出せる包むページへ行くので、指す先は台帳で確かめる)
		expect((await request.get(before, {headers: session, maxRedirects: 5})).status()).toBe(200);
		const alias = before.match(/\/alias\/([^/]+)\/viewer$/)[1];
		const pointed = await (await request.get(`api/documents/alias/${alias}`, {headers: ro})).json();
		expect(pointed.id ?? pointed.documentId, "リンクが古い版を指したまま").toBe(v2.id);

		// 取り直したおしながきでも、URLは変わっていない
		expect(linksOf(await markdownOf(request))[COVER]).toBe(before);
		cover = v2;
	});

	test("見出しの下に、プロジェクトを開くリンクが入る", async ({request}) => {
		const markdown = await markdownOf(request);
		const lines = markdown.split("\n");
		expect(lines[0]).toContain("おしながき");
		expect(markdown).toContain(`プロジェクトを開く: <${BASE_URL.replace(/\/+$/, "")}/?project=${encodeURIComponent(projectId)}>`);
		// 資料の一覧より前にある
		expect(markdown.indexOf("プロジェクトを開く")).toBeLessThan(markdown.indexOf(`[${COVER}]`));
	});

	test("章だけを切り出したときも、リンクが付く", async ({request}) => {
		const links = linksOf(await markdownOf(request, `?folderId=${folderId}`));
		expect(Object.keys(links)).toEqual([SPEC]);
		expect(links[SPEC]).toContain(`/alias/${spec.alias}/viewer`);
	});

	// 印刷物や、URLを載せたくない文面向け
	test("links=0 で、リンクなし(名前と説明書きだけ)にできる", async ({request}) => {
		const markdown = await markdownOf(request, "?links=0");
		expect(markdown).toContain(`- **${COVER}**`);
		expect(markdown).not.toContain("](");
		expect(markdown).not.toContain("http");
		expect(markdown).not.toContain("プロジェクトを開く");
	});

	// 読むだけの操作で、台帳(Alias)を書き換えない
	test("おしながきを取っても、Aliasは増えも変わりもしない", async ({request}) => {
		const aliasBefore = (await (await request.get(`api/documents/${spec.id}`, {headers: ro})).json()).alias;
		await markdownOf(request);
		await markdownOf(request);
		expect((await (await request.get(`api/documents/${spec.id}`, {headers: ro})).json()).alias).toBe(aliasBefore);
	});

	// 呼び出し側が宛先を差し替えられると、人に渡す文面に他所のURLを混ぜ込める
	test("リンクの宛先は、呼び出し側の指定では変わらない", async ({request}) => {
		const markdown = await markdownOf(request, "?baseUrl=https://evil.example.com");
		expect(markdown).not.toContain("evil.example.com");
		const forwarded = await (await request.get(`api/projects/${projectId}/manifest.md`, {
			headers: {...ro, "X-Forwarded-Host": "evil.example.com"}
		})).text();
		expect(forwarded).not.toContain("evil.example.com");
	});

	test("JSONのおしながきは、これまでどおり(リンクは持たない)", async ({request}) => {
		const manifest = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		expect(manifest.documentCount).toBe(2);
		expect(JSON.stringify(manifest)).not.toContain("/viewer");
	});
});
