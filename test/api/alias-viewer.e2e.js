/*!
 * alias-viewer.e2e.js : 共有リンクで開いた文書に、新しい版が出たことを知らせる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 共有リンク(Alias)は「いまの版」を指すが、**開いたままのページは古い版のまま**になる。
 * 会議の最中に差し替えられても、開いている人は気づけない。そこでテキスト系と図は
 * 包むページ(alias-viewer.html)を挟み、SSEで変更を受けて上に帯を出す。
 *
 * ここで守りたいのは次の3つ。
 *   - 勝手に切り替えないこと。読んでいる途中で中身が変わるほうが困る
 *   - 押せば確かに新しい版に変わること(帯だけ出て変わらない、が最悪)
 *   - 包んでも、文書に仕込まれたスクリプトは動かないままであること
 *
 * 実行には Chromium が必要: `npx playwright install chromium`
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};

const STAMP = Date.now();
const FLOW = "graph TD;\n  A[受注] --> B[出荷];";

const upload = async (request, name, body, previousId, mimeType) => {
	const multipart = {
		uploadfile: {name, mimeType: mimeType || "text/plain", buffer: Buffer.from(body, "utf-8")}
	};
	if (previousId) multipart.previousId = previousId;
	const res = await request.post("api/documents", {headers: rw, multipart});
	expect(res.status()).toBe(200);
	return res.json();
};

// 包むページに着いていること。**位置まで確かめる**(相対パスの階層がずれていても
// 文字列の一部は一致してしまい、404のページを見ながら通ってしまう)
const expectWrapped = async (page, alias) => {
	await expect(page).toHaveURL(new URL(`alias-viewer.html?alias=${alias}`, BASE_URL).href);
};

const openShared = async (page, alias) => {
	await page.goto(`api/documents/alias/${alias}/viewer`);
	await expectWrapped(page, alias);
};

test.describe.serial("共有リンクで開いた文書(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("ふだんは帯を出さず、文書だけが見える", async ({request, page}) => {
		const v1 = await upload(request, `共有枠${STAMP}.txt`, "v1の本文です");
		await openShared(page, v1.alias);

		await expect(page.frameLocator("#content").locator("body")).toContainText("v1の本文です");
		await expect(page.locator("#updateBar"), "新しい版が無いのに帯が出ている").toBeHidden();
		await expect(page.locator("#status")).toBeHidden();
	});

	// この機能の目的そのもの
	test("新しい版が上がると帯が出て、押すと中身が入れ替わる", async ({request, page}) => {
		const v1 = await upload(request, `差し替え${STAMP}.txt`, "古い本文");
		await openShared(page, v1.alias);
		await expect(page.frameLocator("#content").locator("body")).toContainText("古い本文");

		await upload(request, `差し替え${STAMP}.txt`, "新しい本文", v1.id);

		await expect(page.locator("#updateBar"), "新しい版が出たのに知らせていない").toBeVisible({timeout: 15000});
		await expect(page.locator("#updateMessage")).toContainText("新しい版があります");
		// 読んでいる途中で勝手に変わらないこと(帯は出すが、中身はそのまま)
		await expect(page.frameLocator("#content").locator("body"), "押す前に切り替わっている").toContainText("古い本文");

		await page.click("#reloadButton");
		await expect(page.frameLocator("#content").locator("body"), "押しても新しい版にならない").toContainText("新しい本文");
		await expect(page.locator("#updateBar"), "切り替えたのに帯が残っている").toBeHidden();
	});

	// 帯が消せないと、読んでいる間ずっと場所を取る
	test("「あとで」を選べる", async ({request, page}) => {
		const v1 = await upload(request, `あとで${STAMP}.txt`, "本文v1");
		await openShared(page, v1.alias);
		await upload(request, `あとで${STAMP}.txt`, "本文v2", v1.id);
		await expect(page.locator("#updateBar")).toBeVisible({timeout: 15000});

		await page.click("#dismissButton");
		await expect(page.locator("#updateBar")).toBeHidden();
		// 閉じただけなので、見ているのは元の版のまま
		await expect(page.frameLocator("#content").locator("body")).toContainText("本文v1");
	});

	test("Markdownは体裁つきのまま、新しい版も知らせる", async ({request, page}) => {
		const v1 = await upload(request, `手順書${STAMP}.md`, "# 手順\n\n- 最初の版");
		await openShared(page, v1.alias);
		// 生のMarkdownではなく、変換後のHTMLが出ていること
		await expect(page.frameLocator("#content").locator("h1")).toContainText("手順");

		await upload(request, `手順書${STAMP}.md`, "# 手順\n\n- 次の版", v1.id);
		await expect(page.locator("#updateBar")).toBeVisible({timeout: 15000});
		await page.click("#reloadButton");
		await expect(page.frameLocator("#content").locator("body")).toContainText("次の版");
	});

	// 図は画像化していないため、専用のビューアで描く。包んでもそれを残すこと
	test("Mermaidは図として描かれ、新しい版も知らせる", async ({request, page}) => {
		const v1 = await upload(request, `流れ${STAMP}.mmd`, FLOW);
		await openShared(page, v1.alias);

		const frame = page.frameLocator("#content");
		await expect(frame.locator("#viewer svg")).toBeAttached({timeout: 15000});
		await expect(frame.locator("#viewer svg")).toContainText("受注");

		await upload(request, `流れ${STAMP}.mmd`, "graph TD;\n  A[受注] --> C[検品];", v1.id);
		await expect(page.locator("#updateBar"), "図でも知らせること").toBeVisible({timeout: 15000});
		await page.click("#reloadButton");
		await expect(page.frameLocator("#content").locator("#viewer svg")).toContainText("検品", {timeout: 15000});
	});

	test("draw.ioも専用のビューアで描かれる", async ({request, page}) => {
		const xml = `<mxfile><diagram id="p1" name="図"><mxGraphModel><root>`
			+ `<mxCell id="0"/><mxCell id="1" parent="0"/>`
			+ `<mxCell id="2" value="受注登録" style="rounded=1;" vertex="1" parent="1">`
			+ `<mxGeometry x="20" y="20" width="160" height="50" as="geometry"/></mxCell>`
			+ `</root></mxGraphModel></diagram></mxfile>`;
		const v1 = await upload(request, `構成${STAMP}.drawio`, xml, null, "application/xml");
		await openShared(page, v1.alias);

		expect(await page.locator("#content").getAttribute("src")).toContain("drawio-viewer.html");
		await expect(page.frameLocator("#content").locator("#viewer svg")).toBeAttached({timeout: 20000});
	});

	// 枠で包んだせいで守りが緩んでいないこと。文書の中身は信用できない入力のまま
	test("文書に仕込まれたスクリプトは動かない", async ({request, page}) => {
		const html = `<!DOCTYPE html><html><head><title>original</title></head>`
			+ `<body><h1 id="marker">safe</h1>`
			+ `<script>document.getElementById('marker').textContent='XSS-EXECUTED';`
			+ `window.top.location='about:blank';</script></body></html>`;
		const v1 = await upload(request, `罠${STAMP}.html`, html, null, "text/html");
		await openShared(page, v1.alias);

		await expect(page.frameLocator("#content").locator("#marker")).toHaveText("safe");
		// 枠そのものが乗っ取られていないこと
		await expectWrapped(page, v1.alias);
		// スクリプトを許していないこと(許してしまうとCSPだけが頼りになる)
		expect(await page.locator("#content").getAttribute("sandbox")).not.toContain("allow-scripts");
	});

	// SSEは「どれかの文書が変わった」としか言わない。無関係な更新で帯が出ると、
	// 押しても何も変わらない(押した人は壊れていると受け取る)
	test("関係のない文書が変わっても、帯は出ない", async ({request, page}) => {
		const v1 = await upload(request, `無関係${STAMP}.txt`, "この文書は変えない");
		await openShared(page, v1.alias);
		await expect(page.frameLocator("#content").locator("body")).toContainText("この文書は変えない");

		// 別の文書を2回上げて、通知が確かに飛んでいる状況を作る
		const other = await upload(request, `よその文書${STAMP}.txt`, "v1");
		await upload(request, `よその文書${STAMP}.txt`, "v2", other.id);

		// その通知で帯が出てしまわないこと。出るとすれば数秒以内なので、待って確かめる
		await page.waitForTimeout(2000);
		await expect(page.locator("#updateBar"), "無関係な更新で帯が出ている").toBeHidden();
	});

	// このページのURLはアドレスバーに出るので、そのまま人に渡されることがある。
	// 渡された側が未ログインだと「見つかりません」の行き止まりになっていた
	test("未ログインで直接開くと、ログインへ送って共有リンクへ戻す", async ({request, browser}) => {
		const v1 = await upload(request, `未ログイン${STAMP}.txt`, "v1");
		const context = await browser.newContext();   // セッションのcookieを入れない
		const page = await context.newPage();
		try {
			const toLogin = page.waitForRequest((r) => r.url().includes("/login?next="), {timeout: 15000});
			// ログイン画面はOIDCへ繋ぎに行くため、着地までは待たない
			page.goto(`alias-viewer.html?alias=${v1.alias}`).catch(() => {});

			const next = new URL((await toLogin).url()).searchParams.get("next");
			expect(next, "ログイン後の戻り先が共有リンクになっていない").toBe(`/api/documents/alias/${v1.alias}/viewer`);
		} finally {
			await context.close();
		}
	});

	test("無い共有リンクは、黙って白紙にせず案内を出す", async ({page}) => {
		await page.goto("alias-viewer.html?alias=000000000000");
		await expect(page.locator("#status")).toBeVisible();
		await expect(page.locator("#status")).toContainText("見つかりません");
	});
});
