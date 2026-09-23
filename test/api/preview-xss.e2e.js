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

	// draw.ioの図はラベルにHTMLを書けるため、図の中身は信用できない入力として扱う。
	// ビューアのページは script-src 'self' で配信しており、図に仕込まれたスクリプトは動かない
	test("draw.ioのラベルに仕込まれたスクリプトはCSPでブロックされる", async ({request, page}) => {
		// value にHTMLを持つ図形(ビューアはHTMLラベルとして描画する)
		const label = `<img src=x onerror="window.__xss=1;document.title='XSS-EXECUTED'">仕込み`;
		const xml = `<mxfile><diagram id="p1" name="罠"><mxGraphModel><root>`
			+ `<mxCell id="0"/><mxCell id="1" parent="0"/>`
			+ `<mxCell id="2" value="${label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}" `
			+ `style="rounded=1;html=1;" vertex="1" parent="1">`
			+ `<mxGeometry x="20" y="20" width="200" height="60" as="geometry"/></mxCell>`
			+ `</root></mxGraphModel></diagram></mxfile>`;
		const uploaded = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "xss-e2e.drawio", mimeType: "application/xml", buffer: Buffer.from(xml)}}
		});
		expect(uploaded.status()).toBe(200);
		const id = (await uploaded.json()).id;

		const cspErrors = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text());
		});

		await page.setExtraHTTPHeaders(rw);
		const response = await page.goto(`drawio-viewer.html?id=${id}`);
		expect(response.status()).toBe(200);
		// ビューアのページはスクリプトの出どころを自分自身に限定して配信される
		expect(response.headers()["content-security-policy"] || "").toContain("script-src 'self'");

		// 図が描画されたうえで、ラベルのスクリプトは動いていないこと
		await expect(page.locator("#viewer svg")).toBeVisible();
		await expect(page.locator("#viewer")).toContainText("仕込み");
		expect(await page.evaluate(() => window.__xss)).toBeUndefined();
		await expect(page).toHaveTitle("draw.io プレビュー");

		await request.delete(`api/documents/${id}`, {headers: rw});
	});

	// Excel/Word/PowerPointの中身(セルの値・段落・シート名)は利用者が自由に書ける。
	// 概要プレビューのHTMLへ素通しすると保存型XSSになるため、エスケープとCSPの両方で防ぐ
	test("Officeの中身に仕込まれたスクリプトは実行されない", async ({request, page}) => {
		const fixture = require("node:fs").readFileSync(
			require("node:path").join(__dirname, "..", "fixtures", "office", "malicious.xlsx")
		);
		const uploaded = await request.post("api/documents", {
			headers: rw,
			multipart: {
				uploadfile: {
					name: "xss-office.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					buffer: fixture
				}
			}
		});
		expect(uploaded.status()).toBe(200);
		const id = (await uploaded.json()).id;

		const cspErrors = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text());
		});

		await page.setExtraHTTPHeaders(rw);
		const response = await page.goto(`api/documents/${id}/file`);
		expect(response.status()).toBe(200);
		expect(response.headers()["content-security-policy"]).toContain("script-src 'none'");

		// 中身は「文字として」見えるが、スクリプトとしては動かない
		await expect(page.locator("body")).toContainText("<script>");
		await expect(page.locator("body")).toContainText("<b>シート名");
		expect(await page.evaluate(() => window.__xss)).toBeUndefined();
		await expect(page).not.toHaveTitle(/XSS-EXECUTED/);
		// 生のタグとして解釈されていないこと(エスケープが効いている)
		expect(await page.locator("script").count()).toBe(0);
		expect(await page.locator("img").count()).toBe(0);

		await request.delete(`api/documents/${id}`, {headers: rw});
	});

	// ビューアの既定では図をクリックすると viewer.diagrams.net の「ライトボックス」が開き、
	// 図の中身が社外のページへ渡ってしまう。これを無効にしてあることを守る
	test("draw.ioの図をクリックしても社外(diagrams.net)へは出ない", async ({request, page, context}) => {
		const xml = `<mxfile><diagram id="p1" name="図"><mxGraphModel><root>`
			+ `<mxCell id="0"/><mxCell id="1" parent="0"/>`
			+ `<mxCell id="2" value="社外秘の構成" style="rounded=1;html=1;" vertex="1" parent="1">`
			+ `<mxGeometry x="20" y="20" width="200" height="60" as="geometry"/></mxCell>`
			+ `</root></mxGraphModel></diagram></mxfile>`;
		const uploaded = await request.post("api/documents", {
			headers: rw,
			multipart: {uploadfile: {name: "lightbox-e2e.drawio", mimeType: "application/xml", buffer: Buffer.from(xml)}}
		});
		const id = (await uploaded.json()).id;

		// 外部へのリクエストが起きたら記録する(通常のプレビューでも発生しないこと)
		const external = [];
		page.on("request", (req) => {
			if (/diagrams\.net|draw\.io/.test(req.url())) external.push(req.url());
		});
		const popups = [];
		context.on("page", (opened) => popups.push(opened.url()));

		await page.setExtraHTTPHeaders(rw);
		await page.goto(`drawio-viewer.html?id=${id}`);
		await expect(page.locator("#viewer svg")).toBeVisible();
		await page.locator("#viewer svg").click({position: {x: 60, y: 40}});
		await page.waitForTimeout(500);

		expect(external).toEqual([]);
		expect(popups).toEqual([]);
		// クリックで開く設定自体が無効(有効だとカーソルがポインタになる)
		expect(await page.evaluate(() => GraphViewer.prototype.lightboxClickEnabled === true)).toBe(false);

		await request.delete(`api/documents/${id}`, {headers: rw});
	});
});
