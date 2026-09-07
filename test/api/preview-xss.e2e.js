/*!
 * preview-xss.e2e.js : 文書プレビュー配信の保存型XSS対策(CSP)を実ブラウザ(Chromium)で検証するE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * API テスト(*.spec.js)は「配信レスポンスにCSPヘッダーが付くか」をHTTPで確認するのに対し、
 * このE2Eは実ブラウザでCSP(script-src 'none')が実際にスクリプト実行を止めることを確認する
 * (ヘッダーが付いていても、値が誤っていればスクリプトは動いてしまうため、実挙動での回帰を守る)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`(playwright.config.jsのe2eプロジェクト)。
 * OIDCを省略したテストサーバ(serve.js)にはブラウザのセッションログインが無いため、APIキー(Bearer)を
 * page.setExtraHTTPHeaders で付けて文書配信エンドポイントへ直接ナビゲートする。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

// script が実行されると #marker のテキストと document.title を書き換える悪意あるHTML。
// CSP(script-src 'none')が効いていれば、いずれも書き換わらない
const MALICIOUS_HTML = `<!DOCTYPE html><html><head><title>original-title</title></head>
<body><h1 id="marker">safe</h1>
<script>document.getElementById('marker').textContent = 'XSS-EXECUTED'; document.title = 'XSS-EXECUTED';</script>
</body></html>`;

test.describe("プレビュー配信の保存型XSS対策(実ブラウザ)", () => {
	test("html内のインラインscriptはCSPでブロックされ実行されない", async ({request, page}) => {
		// 悪意あるHTMLをアップロード(アップロード自体はブラウザ不要のためrequestで行う)
		const uploaded = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "xss-e2e.html", mimeType: "text/html", buffer: Buffer.from(MALICIOUS_HTML)}}
		});
		expect(uploaded.status()).toBe(200);
		const id = (await uploaded.json()).id;

		// CSP違反時にChromiumが出すコンソールエラーを捕捉する(実際にブロックされた強い証跡)
		const cspErrors = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" && /Content Security Policy|Refused to execute/i.test(msg.text())) {
				cspErrors.push(msg.text());
			}
		});

		// セッション(OIDC)が無いのでAPIキーをヘッダーで付与し、文書をトップレベル文書として開く
		// (別ウィンドウプレビュー/共有リンクと同じ、サンドボックスの外での配信を再現する)
		await page.setExtraHTTPHeaders(rw);
		const response = await page.goto(`api/documents/${id}/file`);
		expect(response.status()).toBe(200);
		expect(response.headers()["content-security-policy"] || "").toContain("script-src 'none'");

		// scriptが実行されていれば 'XSS-EXECUTED' に書き換わる。CSPで止まっていれば元のまま
		await expect(page.locator("#marker")).toHaveText("safe");
		await expect(page).toHaveTitle("original-title");
		// Chromiumが実際にCSP違反としてスクリプトをブロックしたことを確認する
		expect(cspErrors.length).toBeGreaterThan(0);

		// このテストで作成した文書は後続に影響させないようアーカイブしておく
		await request.delete(`api/documents/${id}`, {headers: rw});
	});
});
