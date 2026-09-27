/*!
 * markdown-preview.e2e.js : Markdownプレビューの表の見え方
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 表のセルが途中で折り返されると意味が取りにくくなる。
 * 「2026年9月30日まで」が「2026年9月 / 30日まで」に割れると、読む側が別の日付だと思う。
 *
 * そこで、表は本文の幅(800px)に押し込めず内容なりの幅を取らせ、はみ出す分は横スクロールへ
 * 逃がしている。ただし1つのセルが際限なく伸びると横に振られ続けるため、640pxで頭打ちにし、
 * そこを超えるものだけ折り返す。
 *
 * 見た目の話なので、実ブラウザで行数を数えて確かめる(CSSを読んでも折り返しは分からない)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const {loadKeys, BASE_URL, TEST_DATA_DIR} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const upload = async (request, name, body) => (await (await request.post("api/documents", {
	headers: rw, multipart: {uploadfile: {name, mimeType: "text/markdown", buffer: Buffer.from(body)}}
})).json()).id;

/** セルの中で実際に何行に分かれているか(行ボックスの数を数える) */
const lineCountOf = (page, text) => page.evaluate((needle) => {
	const cell = [...document.querySelectorAll("td")].find((c) => c.textContent.includes(needle));
	if (cell == null) return null;
	const range = document.createRange();
	range.selectNodeContents(cell);
	return range.getClientRects().length;
}, text);

test.describe.serial("Markdownプレビューの表(実ブラウザ)", () => {
	let id;
	const LONG = "あ".repeat(400);

	test.beforeAll(async ({request}) => {
		id = await upload(request, `表-${Date.now()}.md`, [
			"| 項目 | 状況 | 期限 | 担当 |",
			"|---|---|---|---|",
			"| 受注登録の画面改修 | 2026年6月の打ち合わせで合意した範囲です | 2026年9月30日まで | 情報システム部 |",
			`| 長い列 | ${LONG} | 2026年12月 | 本社 |`,
			"",
			"```html",
			"<table>コードの中のこれは枠に包まれない</table>",
			"```"
		].join("\n"));
	});

	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("640pxに収まるセルは折り返さない", async ({page}) => {
		await page.goto(`api/documents/${id}/file`);
		await expect(page.locator("table")).toBeVisible();

		for (const text of ["2026年9月30日まで", "2026年6月の打ち合わせで合意した範囲です", "情報システム部"]) {
			expect(await lineCountOf(page, text), `「${text}」が折り返されている`).toBe(1);
		}
	});

	// 頭打ちが無いと、1つのセルのせいで表全体が何千pxにもなる
	test("640pxを超えるセルは折り返す", async ({page}) => {
		await page.goto(`api/documents/${id}/file`);
		await expect(page.locator("table")).toBeVisible();
		expect(await lineCountOf(page, LONG.slice(0, 20)), "際限なく横に伸びている").toBeGreaterThan(1);

		const width = await page.evaluate((needle) => {
			const cell = [...document.querySelectorAll("td")].find((c) => c.textContent.includes(needle));
			return Math.round(cell.getBoundingClientRect().width);
		}, LONG.slice(0, 20));
		// max-width はセルの内側にかかるので、余白と枠の分だけ広くなる
		expect(width, `セルの幅 ${width}px`).toBeLessThan(700);
	});

	test("本文からはみ出す分は、表だけが横スクロールする", async ({page}) => {
		await page.goto(`api/documents/${id}/file`);
		const wrap = page.locator(".tableWrap");
		await expect(wrap).toHaveCount(1);

		const box = await wrap.evaluate((el) => ({表示幅: el.clientWidth, 中身: el.scrollWidth}));
		expect(box.中身, `枠 ${box.表示幅}px / 表 ${box.中身}px`).toBeGreaterThan(box.表示幅);
		// ページ自体は横に伸びない(本文が読みにくくなるため)
		expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	});

	// 枠は生成したHTMLへ後から被せている。コードブロックの中の文字列を巻き込まないこと
	test("コードブロックに書かれた表は、そのまま文字として出る", async ({page}) => {
		await page.goto(`api/documents/${id}/file`);
		await expect(page.locator("pre code")).toContainText("<table>コードの中のこれは枠に包まれない</table>");
		await expect(page.locator("pre .tableWrap")).toHaveCount(0);
	});

	// preview.html はアップロード時に1度だけ作られる。見た目を直しても、
	// 作り直さなければ既にある文書には反映されない
	test("古い版で作られたプレビューは、配信時に作り直される", async ({page, request}) => {
		const target = await upload(request, `作り直し-${Date.now()}.md`,
			"| A | B |\n|---|---|\n| 1 | 2 |");
		const previewPath = path.join(TEST_DATA_DIR, "documents", target, "preview.html");

		// 直す前の見た目(版の印も枠も無い)へ差し替えて、古い文書を作る
		fs.writeFileSync(previewPath, [
			"<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
			"<style>table { border-collapse: collapse; }</style>",
			"</head><body><table><tr><td>むかしの見た目</td></tr></table></body></html>"
		].join("\n"), "utf-8");

		await page.goto(`api/documents/${target}/file`);
		// 元ファイルから作り直されている(差し替えた中身ではなく、元のMarkdownが出る)
		await expect(page.locator("td").first()).toHaveText("1");
		await expect(page.locator(".tableWrap")).toHaveCount(1);
		expect(fs.readFileSync(previewPath, "utf-8"), "保存側が古いままだと毎回作り直すことになる")
			.toContain("dm-preview-version");

		// 2回目は作り直さない(印が付いているため)
		const writtenAt = fs.statSync(previewPath).mtimeMs;
		await page.goto(`api/documents/${target}/file`);
		expect(fs.statSync(previewPath).mtimeMs, "配信のたびに書き込んでいる").toBe(writtenAt);
	});

	// 作り直せないものまで触ると、直らないうえに毎回書き込みが走る
	test("作り直せない形式(.html)は触らない", async ({page, request}) => {
		const doc = await (await request.post("api/documents", {
			headers: rw, multipart: {uploadfile: {name: `そのまま-${Date.now()}.html`,
				mimeType: "text/html", buffer: Buffer.from("<p>元のまま</p>")}}
		})).json();
		const before = fs.statSync(path.join(TEST_DATA_DIR, "documents", doc.id, doc.entryFile)).mtimeMs;
		await page.goto(`api/documents/${doc.id}/file`);
		await expect(page.locator("p")).toHaveText("元のまま");
		expect(fs.statSync(path.join(TEST_DATA_DIR, "documents", doc.id, doc.entryFile)).mtimeMs,
			"作り直せない形式の実体に書き込んでいる").toBe(before);
	});
});
