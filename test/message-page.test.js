/*!
 * message-page.test.js : ログインに失敗したときなどに出す知らせのページ(app/lib/message-page.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * ほかの画面と同じく、いちばん下にフッター(左に著作権、右に版)が出ること。
 * 版が無いとき(ビルドせずに動かしているとき)は、空にせず「Ver. -」と出すこと。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {messagePageHtml, footerVersionText} = require("../app/lib/message-page.js");

const PAGE = {icon: "error", iconColor: "#f08c00", title: "ログインに失敗しました", message: "もう一度お試しください。", retryHref: "./", retryLabel: "もう一度ログイン"};

test("フッターに著作権と版が出る", () => {
	const html = messagePageHtml({...PAGE, version: "20261101.1530", year: 2026});
	assert.match(html, /<footer>[\s\S]*<span class="footer_copyright">© 2026 EARCE\.NET<\/span>[\s\S]*<span class="footer_version">Ver\. 20261101\.1530<\/span>[\s\S]*<\/footer>/);
	// 本文(カード)も出る
	assert.match(html, /<h1>ログインに失敗しました<\/h1>/);
	assert.match(html, /<a class="button" href=".\/">もう一度ログイン<\/a>/);
});

test("版が無いときは Ver. - と出す(空にしない)", () => {
	for (const version of [null, undefined, ""]) {
		assert.match(messagePageHtml({...PAGE, version, year: 2026}), /<span class="footer_version">Ver\. -<\/span>/);
		assert.equal(footerVersionText(version), "Ver. -");
	}
	assert.equal(footerVersionText("20261101.1530"), "Ver. 20261101.1530");
});

test("年を渡さなければ、いまの年を出す", () => {
	assert.match(messagePageHtml(PAGE), new RegExp(`© ${new Date().getFullYear()} EARCE\\.NET`));
});
