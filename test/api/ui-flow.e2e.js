/*!
 * ui-flow.e2e.js : 主要UIフロー(アップロード→検索→タグ付け→プレビュー→APIキー取得・動作)を
 *                  実ブラウザ(Chromium)で通しで検証するE2E
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * OIDCを省略したテストサーバ(serve.js)には対話的ログインが無いため、serve.jsが払い出した
 * 管理者(owner)のログイン済みセッションcookie(.auth-keys.jsonのsessionCookie)をブラウザへ
 * 注入してから操作する。認証は有効なままなので、UI操作の裏で実際のrequireAuth/requireWrite/
 * requireAdminやAPIキー認証がそのまま働く(APIキーの「動作」まで本物で検証できる)。
 *
 * 実行には Chromium が必要: `npx playwright install chromium`(playwright.config.jsのe2eプロジェクト)。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
// このスペックで作成する文書名(検索・プレビュー・タグ付けの対象)。実行ごとに一意にする
const DOC_NAME = `e2e-flow-${Date.now()}.html`;
const DOC_HTML = "<!DOCTYPE html><html><head><title>e2e</title></head><body><h1>E2E本文サンプル</h1></body></html>";
const TAG_NAME = `e2eタグ${Date.now()}`;

test.describe.serial("主要UIフロー(実ブラウザ)", () => {
	test.beforeEach(async ({context}) => {
		// 管理者のログイン済みセッションを注入する(OIDCを経由せずログイン状態を再現)
		await context.addCookies([{name: keys.sessionCookieName, value: keys.sessionCookie, url: BASE_URL}]);
	});

	test("アップロード→検索→タグ付け→プレビュー→APIキー取得・動作", async ({page, request}) => {
		await test.step("ログイン済みで管理者としてアプリが開く", async () => {
			await page.goto("./");
			// 認証OK時のみ表示される要素(アップロード領域・APIキー管理)が出ることでログイン済みを確認
			await expect(page.locator("#uploadDropZone")).toBeVisible();
			await expect(page.locator("#apiKeyManageLink")).toBeVisible();
		});

		await test.step("ファイルをアップロードできる", async () => {
			// 隠しfile input(display:none)へ直接ファイルを渡すとchangeハンドラでアップロードされる
			await page.setInputFiles("#uploadfile", {name: DOC_NAME, mimeType: "text/html", buffer: Buffer.from(DOC_HTML)});
			// アップロード完了後、一覧に該当文書が現れる
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
		});

		await test.step("検索で見つかる(ファイル名の部分一致)", async () => {
			await page.fill("#filterInput", DOC_NAME.slice(0, 12));
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
			// 検索欄を戻す(後続でタグ検索を行うため)
			await page.fill("#filterInput", "");
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
		});

		await test.step("プレビューが表示される", async () => {
			await page.locator("#documentList li", {hasText: DOC_NAME}).click();
			await expect(page.locator("#previewTitle")).toHaveText(DOC_NAME);
			const frame = page.locator("#previewFrame");
			await expect(frame).toBeVisible();
			await expect(frame).toHaveAttribute("src", /api\/documents\/.+\/file$/);
		});

		await test.step("タグを付けられる", async () => {
			await page.locator("#previewTagEditButton").click();
			await expect(page.locator("#tagEditOverlay")).toBeVisible();
			await page.fill("#tagEditInput", TAG_NAME);
			await page.press("#tagEditInput", "Enter");
			await expect(page.locator("#tagEditChips", {hasText: TAG_NAME})).toBeVisible();
			await page.locator("#tagSaveButton").click();
			await expect(page.locator("#tagEditOverlay")).toBeHidden();
			// 付けたタグで検索してヒットすること(タグ検索の確認も兼ねる)
			await page.fill("#filterInput", TAG_NAME);
			await expect(page.locator("#documentList li", {hasText: DOC_NAME})).toBeVisible();
			await page.fill("#filterInput", "");
		});

		await test.step("APIキーを発行でき、そのキーで実際にAPIが動作する", async () => {
			await page.locator("#apiKeyManageLink").click();
			await expect(page.locator("#apiKeyOverlay")).toBeVisible();
			await page.selectOption("#apiKeyRoleInput", "readwrite");
			await page.locator("#apiKeyCreateButton").click();
			// 発行直後にだけ表示される平文キーを取得する
			const rawKey = (await page.locator(".apiKeyValue").textContent())?.trim();
			expect(rawKey).toMatch(/^dm_/);
			// 一覧にも1件現れる
			await expect(page.locator("#apiKeyList li").first()).toBeVisible();

			// 取得した平文キーで実際にAPIを叩けること(認証有効なので本物の検証になる)
			const apiRes = await request.get("api/documents", {headers: {Authorization: `Bearer ${rawKey}`}});
			expect(apiRes.status()).toBe(200);
			expect(Array.isArray(await apiRes.json())).toBe(true);
		});

		await test.step("後始末(作成した文書をアーカイブ)", async () => {
			// UI操作の副作用を残さないよう、readwriteキーでアーカイブしておく
			const list = await (await request.get("api/documents", {headers: {Authorization: `Bearer ${keys.readwrite}`}})).json();
			const created = list.find((d) => d.entryFile === DOC_NAME);
			if (created) {
				await request.delete(`api/documents/${created.id}`, {headers: {Authorization: `Bearer ${keys.readwrite}`}});
			}
		});
	});

	// .drawio(実体)とプレビュー画像(svg)を同時に選択→フロントのペア判定で previewfile として
	// 送信→一覧表示・DRAWIOバッジ・svgプレビュー・.drawio実体のダウンロードまでを実ブラウザで通す
	test(".drawio+プレビュー画像の同時アップロードとプレビュー表示", async ({page, request}) => {
		const drawioName = `e2e-${Date.now()}.drawio`;
		const svgName = `e2e-${Date.now()}.svg`;
		const drawioXml = `<mxfile><diagram name="E2E構成図" id="p1"><mxGraphModel><root>`
			+ `<mxCell id="2" value="E2Eドローアイオーラベル" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#e8590c"/></svg>`;

		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();

		await test.step("2ファイル選択で.drawioを実体・svgをプレビューとして送信できる", async () => {
			await page.setInputFiles("#uploadfile", [
				{name: drawioName, mimeType: "application/xml", buffer: Buffer.from(drawioXml)},
				{name: svgName, mimeType: "image/svg+xml", buffer: Buffer.from(svg)}
			]);
			const li = page.locator("#documentList li", {hasText: drawioName});
			await expect(li).toBeVisible();
			// 拡張子バッジが DRAWIO になる
			await expect(li.locator(".docTag")).toHaveText("DRAWIO");
		});

		await test.step("svgプレビューが表示され、ダウンロードは.drawio実体を指す", async () => {
			await page.locator("#documentList li", {hasText: drawioName}).click();
			await expect(page.locator("#previewTitle")).toHaveText(drawioName);
			const frame = page.locator("#previewFrame");
			await expect(frame).toBeVisible();
			await expect(frame).toHaveAttribute("src", /api\/documents\/.+\/file$/);
			// ダウンロードリンクは元ファイル(.drawio)を返す ?download=1
			await expect(page.locator("#downloadLink")).toHaveAttribute("href", /api\/documents\/.+\/file\?download=1$/);
		});

		await test.step("XMLラベルが全文検索でヒットする", async () => {
			await page.fill("#filterInput", "E2Eドローアイオーラベル");
			await expect(page.locator("#documentList li", {hasText: drawioName})).toBeVisible();
			await page.fill("#filterInput", "");
		});

		await test.step("後始末(作成した文書をアーカイブ)", async () => {
			const list = await (await request.get("api/documents", {headers: {Authorization: `Bearer ${keys.readwrite}`}})).json();
			const created = list.find((d) => d.entryFile === drawioName);
			if (created) {
				await request.delete(`api/documents/${created.id}`, {headers: {Authorization: `Bearer ${keys.readwrite}`}});
			}
		});
	});

	// ヘルプ(AI連携ガイド)はサーバーのAPI仕様(api/usage.md)から取得され、APIキー発行後の
	// 「AIチャット貼り付け用にコピー」も同じガイドにキーを埋め込んだものになる
	test("AI連携ヘルプはサーバーのAPI仕様から取得される", async ({page, context}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await page.goto("./");

		await test.step("ヘルプに利用ガイドが表示され、実際のアクセス元URLが埋まる", async () => {
			await page.locator("#helpButton").click();
			await expect(page.locator("#helpOverlay")).toBeVisible();
			const guide = page.locator("#helpMarkdownText");
			await expect(guide).toHaveValue(/^# Document Manager API 利用ガイド/);
			const markdown = await guide.inputValue();
			expect(markdown).toContain(`- ベースURL: \`${new URL("./", page.url()).href.replace(/\/$/, "")}\``);
			expect(markdown).toContain("## AIへの指示");
			expect(markdown).toContain("/api/documents/archived");
			await page.locator("#helpCloseButton").click();
		});

		await test.step("APIキー発行後のコピー内容は、キーを埋め込んだ同じガイドになる", async () => {
			await page.locator("#apiKeyManageLink").click();
			await page.selectOption("#apiKeyRoleInput", "readwrite");
			await page.locator("#apiKeyCreateButton").click();
			const rawKey = (await page.locator(".apiKeyValue").textContent())?.trim();
			await page.locator("#apiKeyCopyChatButton").click();
			await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain(rawKey);
			const copied = await page.evaluate(() => navigator.clipboard.readText());
			expect(copied).toContain("Document ManagerのAPIキーを発行しました");
			expect(copied).toContain("# Document Manager API 利用ガイド (AI向け)");
			expect(copied).not.toContain("<APIキー>");
		});
	});

	// APIキー管理画面から Claude Code 用 Skill のZIPをダウンロードでき、登録手順・依頼文が表示される
	test("APIキー管理画面からSkillのZIPをダウンロードできる", async ({page}) => {
		await page.goto("./");
		await page.locator("#apiKeyManageLink").click();
		await expect(page.locator("#apiKeyOverlay")).toBeVisible();
		await page.locator("#claudeSkillBox summary").click();
		// 接続先URLはこのページの位置から算出される
		await expect(page.locator("#claudeSkillBaseUrl")).toHaveText(new URL("./", page.url()).href);
		// エージェントを切り替えると展開先(手順・手動コマンド)が切り替わる
		const expectedDirs = {claude: "~/.claude/skills", codex: "~/.agents/skills", antigravity: "~/.gemini/config/skills"};
		for (const [agent, dir] of Object.entries(expectedDirs)) {
			await page.locator(`#claudeSkillBox .skillAgentTab[data-agent="${agent}"]`).click();
			await expect(page.locator(`#claudeSkillBox .skillAgentTab[data-agent="${agent}"]`)).toHaveClass(/selected/);
			await expect(page.locator("#claudeSkillSteps")).toContainText(`${dir}/document-manager/`);
			await expect(page.locator("#claudeSkillManual")).toContainText(`-d ${dir}/`);
		}
		await page.locator('#claudeSkillBox .skillAgentTab[data-agent="codex"]').click();
		if (process.env.E2E_SCREENSHOT) {
			await page.locator("#apiKeyModalBox").screenshot({path: process.env.E2E_SCREENSHOT});
		}
		const downloadPromise = page.waitForEvent("download");
		await page.locator("#claudeSkillDownloadLink").click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("document-manager-skill.zip");
		const fs = require("node:fs");
		const zip = fs.readFileSync(await download.path());
		expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(zip.includes(Buffer.from("document-manager/SKILL.md"))).toBe(true);
	});

	// 他の人(ここでは自分名義のAPIキー=AIエージェント相当)の操作が右下のポップアップで通知され、
	// クリックで文書を開ける。ブラウザ上の自分の操作は通知されず、ベルでオフにできる
	test("操作のポップアップ通知", async ({page, request}) => {
		const rw = {Authorization: `Bearer ${keys.readwrite}`};
		const name = `e2e-通知-${Date.now()}.txt`;
		await page.goto("./");
		await expect(page.locator("#uploadDropZone")).toBeVisible();
		// SSE接続が張られるのを待つ(接続前のイベントは届かないため)
		await page.waitForTimeout(500);

		let docId;
		await test.step("APIキー経由のアップロードが通知され、クリックで文書が開く", async () => {
			const res = await request.post("api/documents", {headers: rw, multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from("notify")}}});
			docId = (await res.json()).id;
			const toast = page.locator(".activityToast", {hasText: name});
			await expect(toast).toBeVisible();
			await expect(toast).toContainText("をアップロードしました");
			await expect(toast).toContainText("APIキー経由");
			await toast.click();
			await expect(page.locator("#previewTitle")).toHaveText(name);
			await expect(toast).toHaveCount(0);
		});

		await test.step("APIキー経由のタグ付けは追加したタグ付きで通知される", async () => {
			await request.put(`api/documents/${docId}/tags`, {headers: rw, data: {tags: ["通知テスト"]}});
			await expect(page.locator(".activityToast", {hasText: "「通知テスト」"})).toBeVisible();
		});

		await test.step("ブラウザ上の自分の操作は通知されない", async () => {
			await page.locator(".activityToastClose").first().click();
			await expect(page.locator(".activityToast")).toHaveCount(0);
			await page.locator("#previewTagEditButton").click();
			await page.fill("#tagEditInput", "自分で追加");
			await page.press("#tagEditInput", "Enter");
			await page.locator("#tagSaveButton").click();
			await expect(page.locator("#tagEditOverlay")).toBeHidden();
			await page.waitForTimeout(800);
			await expect(page.locator(".activityToast")).toHaveCount(0);
		});

		await test.step("ベルでオフにすると通知されない(設定はリロード後も保持)", async () => {
			await page.locator("#activityNotifyToggle").click();
			await expect(page.locator("#activityNotifyToggle")).toHaveAttribute("aria-pressed", "false");
			await page.reload();
			await expect(page.locator("#activityNotifyToggle")).toHaveAttribute("aria-pressed", "false");
			await page.waitForTimeout(500);
			await request.delete(`api/documents/${docId}`, {headers: rw});
			await page.waitForTimeout(800);
			await expect(page.locator(".activityToast")).toHaveCount(0);
			// 後続テストのため元に戻す
			await page.locator("#activityNotifyToggle").click();
			await expect(page.locator("#activityNotifyToggle")).toHaveAttribute("aria-pressed", "true");
		});
	});

	// アーカイブは押し間違いが多いため、一覧・プレビューのどちらからでも確認ダイアログを挟む
	test("アーカイブは確認ダイアログを経てから実行される", async ({page}) => {
		const name = `e2e-確認ダイアログ-${Date.now()}.txt`;
		await page.goto("./");
		await page.setInputFiles("#uploadfile", {name, mimeType: "text/plain", buffer: Buffer.from("archive confirm")});
		const listItem = page.locator("#documentList li", {hasText: name});
		await expect(listItem).toBeVisible();

		await test.step("一覧のボタン: キャンセルするとアーカイブされない", async () => {
			await listItem.locator(".archiveButton").click();
			await expect(page.locator("#confirmOverlay")).toBeVisible();
			await expect(page.locator("#confirmMessage")).toContainText(name);
			await expect(page.locator("#confirmMessage")).toContainText("完全削除ではありません");
			await page.locator("#confirmNoButton").click();
			await expect(page.locator("#confirmOverlay")).toBeHidden();
			await expect(listItem).toBeVisible();
		});

		await test.step("プレビューのボタン: キャンセルするとアーカイブされない", async () => {
			await listItem.click();
			await expect(page.locator("#previewTitle")).toHaveText(name);
			await page.locator("#previewArchiveButton").click();
			await expect(page.locator("#confirmOverlay")).toBeVisible();
			await page.locator("#confirmNoButton").click();
			await expect(page.locator("#documentList li", {hasText: name})).toBeVisible();
			await expect(page.locator("#previewTitle")).toHaveText(name);
		});

		await test.step("「はい」を選ぶとアーカイブされ、アーカイブ画面に現れる", async () => {
			await page.locator("#previewArchiveButton").click();
			await page.locator("#confirmYesButton").click();
			await expect(page.locator("#documentList li", {hasText: name})).toHaveCount(0);
			await page.locator("#menuArchiveLink").click();
			await expect(page.locator("#documentList li", {hasText: name})).toBeVisible();
			await page.locator("#menuDocumentsLink").click();
		});
	});

	// 本文が大きい文書では、全文検索の対象が先頭までであることを知らせる
	test("本文が上限を超えた文書に注意書きが出る", async ({page}) => {
		const name = `e2e-大きい本文-${Date.now()}.txt`;
		await page.goto("./");
		// テストサーバの上限は5000文字(playwright.config.js)
		await page.setInputFiles("#uploadfile", {name, mimeType: "text/plain", buffer: Buffer.from(`先頭${"あ".repeat(6000)}`)});
		await page.locator("#documentList li", {hasText: name}).click();
		await expect(page.locator("#previewTitle")).toHaveText(name);
		await expect(page.locator("#contentTruncatedRow")).toBeVisible();
		await expect(page.locator("#contentTruncatedRow")).toContainText("全文検索の対象は先頭5,000文字まで");

		// 上限以下の文書では出ない
		const smallName = `e2e-小さい本文-${Date.now()}.txt`;
		await page.setInputFiles("#uploadfile", {name: smallName, mimeType: "text/plain", buffer: Buffer.from("短い本文")});
		await page.locator("#documentList li", {hasText: smallName}).click();
		await expect(page.locator("#previewTitle")).toHaveText(smallName);
		await expect(page.locator("#contentTruncatedRow")).toBeHidden();
	});

	// 関連文書(種類・方向を持たない紐付け)の追加・表示・解除
	test("関連文書を紐づけて、双方から辿れて、解除できる", async ({page}) => {
		const aName = `e2e-関連A-${Date.now()}.txt`;
		const bName = `e2e-関連B-${Date.now()}.txt`;
		await page.goto("./");
		await page.setInputFiles("#uploadfile", {name: aName, mimeType: "text/plain", buffer: Buffer.from("a")});
		await expect(page.locator("#documentList li", {hasText: aName})).toBeVisible();
		await page.setInputFiles("#uploadfile", {name: bName, mimeType: "text/plain", buffer: Buffer.from("b")});
		await page.locator("#documentList li", {hasText: bName}).click();
		await expect(page.locator("#previewTitle")).toHaveText(bName);
		await expect(page.locator("#relatedDocsRow")).toBeHidden();

		await test.step("文書を選んで関連づけるとチップに出る", async () => {
			await page.locator("#previewAddRelatedButton").click();
			await expect(page.locator("#docPickerOverlay")).toBeVisible();
			await page.fill("#docPickerInput", aName);
			await page.locator(".docPickerItem", {hasText: aName}).click();
			await expect(page.locator("#relatedDocsRow")).toBeVisible();
			await expect(page.locator("#relatedDocsRow .relatedDocChip .name")).toHaveText([aName]);
		});

		await test.step("チップから相手を開くと、相手側にもこちらが関連として出る(双方向)", async () => {
			await page.locator("#relatedDocsRow .relatedDocChip .name").click();
			await expect(page.locator("#previewTitle")).toHaveText(aName);
			await expect(page.locator("#relatedDocsRow .relatedDocChip .name")).toHaveText([bName]);
		});

		await test.step("解除すると両方から消える", async () => {
			await page.locator("#relatedDocsRow .relatedDocChip .unlink").click();
			await page.locator("#confirmYesButton").click();
			await expect(page.locator("#relatedDocsRow")).toBeHidden();
			await page.locator("#documentList li", {hasText: bName}).click();
			await expect(page.locator("#previewTitle")).toHaveText(bName);
			await expect(page.locator("#relatedDocsRow")).toBeHidden();
		});
	});

	// 既に別々に登録された文書同士を、プレビューの「旧版を紐づける」から後追いで紐づける
	test("後から旧版を紐づけて、解除できる", async ({page}) => {
		const oldName = `e2e-後追い旧-${Date.now()}.txt`;
		const newName = `e2e-後追い新-${Date.now()}.txt`;
		await page.goto("./");
		await page.setInputFiles("#uploadfile", {name: oldName, mimeType: "text/plain", buffer: Buffer.from("old")});
		await expect(page.locator("#documentList li", {hasText: oldName})).toBeVisible();
		await page.setInputFiles("#uploadfile", {name: newName, mimeType: "text/plain", buffer: Buffer.from("new")});
		await page.locator("#documentList li", {hasText: newName}).click();
		await expect(page.locator("#previewTitle")).toHaveText(newName);
		await expect(page.locator("#versionHistoryRow")).toBeHidden();

		await test.step("文書を選んで旧版として紐づけると、版履歴に並び旧版は一覧から消える", async () => {
			await page.locator("#previewLinkPreviousButton").click();
			await expect(page.locator("#docPickerOverlay")).toBeVisible();
			await page.fill("#docPickerInput", oldName);
			await page.locator(".docPickerItem", {hasText: oldName}).click();
			await page.locator("#confirmYesButton").click();
			const row = page.locator("#versionHistoryRow");
			await expect(row).toBeVisible();
			// 既定は畳まれているため、一覧は「すべての版」を開いてから確かめる
			await expect(row.locator(".versionPosition")).toHaveText("v2 / 全2版");
			await row.locator(".versionToggle").click();
			await expect(row.locator(".versionChip")).toHaveText([`v1 ${oldName}`, `v2 ${newName}`]);
			await expect(page.locator("#documentList li", {hasText: oldName})).toHaveCount(0);
		});

		await test.step("解除すると版履歴が消える(旧版はアーカイブされたまま)", async () => {
			await expect(page.locator("#previewLinkPreviousButton")).toHaveAttribute("title", "旧版の紐付けを解除");
			await page.locator("#previewLinkPreviousButton").click();
			await page.locator("#confirmYesButton").click();
			await expect(page.locator("#versionHistoryRow")).toBeHidden();
			await expect(page.locator("#previewLinkPreviousButton")).toHaveAttribute("title", "旧版を紐づける");
		});
	});

	// プレビューの「新しい版をアップロード」→旧版のアーカイブ・新版への切り替え・版履歴の表示と
	// 版履歴から旧版(アーカイブ済み)を開く操作までを実ブラウザで通す
	test("新しい版のアップロードと版履歴の表示", async ({page}) => {
		const v1Name = `e2e-版-v1-${Date.now()}.txt`;
		const v2Name = `e2e-版-v2-${Date.now()}.txt`;

		await page.goto("./");
		await page.setInputFiles("#uploadfile", {name: v1Name, mimeType: "text/plain", buffer: Buffer.from("version 1")});
		await page.locator("#documentList li", {hasText: v1Name}).click();
		await expect(page.locator("#previewTitle")).toHaveText(v1Name);
		// 紐付けの無い文書では版履歴は出ない
		await expect(page.locator("#versionHistoryRow")).toBeHidden();

		await test.step("新しい版をアップロードすると旧版は一覧から消え、新しい版のプレビューに切り替わる", async () => {
			const chooserPromise = page.waitForEvent("filechooser");
			await page.locator("#previewReviseButton").click();
			const chooser = await chooserPromise;
			await chooser.setFiles({name: v2Name, mimeType: "text/plain", buffer: Buffer.from("version 2")});
			await expect(page.locator("#previewTitle")).toHaveText(v2Name);
			await expect(page.locator("#documentList li", {hasText: v2Name})).toBeVisible();
			await expect(page.locator("#documentList li", {hasText: v1Name})).toHaveCount(0);
		});

		// 版が増えてもヘッダーが膨らまないよう、版履歴は既定で1行に畳まれている
		await test.step("版履歴は畳まれた状態で表示され、前の版・最新版へ移動できる", async () => {
			const row = page.locator("#versionHistoryRow");
			await expect(row).toBeVisible();
			await expect(row.locator(".versionPosition")).toHaveText("v2 / 全2版");
			await expect(row.locator(".versionChip")).toHaveCount(0);

			await row.getByLabel("1つ前の版へ").click();
			await expect(page.locator("#previewTitle")).toHaveText(v1Name);
			await expect(row.locator(".versionPosition")).toHaveText("v1 / 全2版");
			await expect(row.getByLabel("1つ前の版へ")).toBeDisabled();

			await row.locator(".versionChip", {hasText: "最新版へ"}).click();
			await expect(page.locator("#previewTitle")).toHaveText(v2Name);
		});

		await test.step("すべての版を開くと v1 › v2 が並び、現在の版が強調される", async () => {
			const row = page.locator("#versionHistoryRow");
			await row.locator(".versionToggle").click();
			await expect(row.locator(".versionChip")).toHaveText([`v1 ${v1Name}`, `v2 ${v2Name}`]);
			await expect(row.locator(".versionChip.current")).toHaveText(`v2 ${v2Name}`);
		});

		await test.step("版履歴から旧版を開くとアーカイブ済みとして表示される", async () => {
			await page.locator("#versionHistoryRow .versionChip", {hasText: v1Name}).click();
			await expect(page.locator("#previewTitle")).toHaveText(v1Name);
			await expect(page.locator("#previewRestoreButton")).toBeVisible();
			await expect(page.locator("#previewReviseButton")).toBeHidden();
			await expect(page.locator("#versionHistoryRow .versionChip.current")).toHaveText(`v1 ${v1Name}`);
		});
	});
});
