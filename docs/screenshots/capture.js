/*!
 * capture.js : README用スクリーンショット(docs/screenshots/*.png)の撮影
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm run screenshots`
 *   (要: ルートで npm install、app/ で npm install、`npx playwright install chromium`)
 *
 * 一時DATA_DIR・認証無効(AUTH_DISABLED=true、dev-user=admin)でアプリを起動し、ダミーの
 * サンプルデータ(文書・版・タグ体系・プロジェクト・メモ)をAPIで登録してから、Chromiumで
 * 各画面を 1280x800 で撮影する。既存のPNGは上書きされる。機能追加で画面が変わったら
 * これを再実行して README の画像を更新する。
 */

const {spawn} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {chromium} = require("@playwright/test");

const REPO = path.resolve(__dirname, "..", "..");
const OUT_DIR = __dirname;
const PORT = Number(process.env.SCREENSHOT_PORT || 18097);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const VIEWPORT = {width: 1280, height: 800};

const api = async (method, apiPath, body) => {
	const init = {method};
	if (body instanceof FormData) {
		init.body = body;
	} else if (body !== undefined) {
		init.headers = {"Content-Type": "application/json"};
		init.body = JSON.stringify(body);
	}
	const res = await fetch(new URL(apiPath, BASE_URL), init);
	if (!res.ok) throw new Error(`${method} ${apiPath}: ${res.status} ${await res.text()}`);
	const text = await res.text();
	return text ? JSON.parse(text) : null;
};

const upload = async (name, content, {previousId, preview} = {}) => {
	const form = new FormData();
	form.append("uploadfile", new Blob([content]), name);
	if (preview) form.append("previewfile", new Blob([preview.content]), preview.name);
	if (previousId) form.append("previousId", previousId);
	return api("POST", "api/documents", form);
};

const setTags = (id, tags) => api("PUT", `api/documents/${encodeURIComponent(id)}/tags`, {tags});

const SPEC_V1 = `# 文書管理システム 仕様書

## 概要
社内文書を一元管理するWebアプリケーション。

## 機能一覧
- 文書のアップロード・プレビュー・検索
- タグによる分類
- プロジェクト単位でのフォルダ管理
`;

const SPEC_V2 = `# 文書管理システム 仕様書 (第2版)

## 概要
社内文書を一元管理するWebアプリケーション。AIエージェントからの登録・検索にも対応する。

## 機能一覧
- 文書のアップロード・プレビュー・全文検索
- **新しい版のアップロード**(旧版はアーカイブし、タグ・プロジェクトを引き継ぐ)
- タグによる分類・タグ体系での一覧
- プロジェクト単位でのフォルダ管理
- 操作履歴の確認
- APIキー(最長1年)と AIエージェント用 Skill

## 改訂履歴
| 版 | 内容 |
|---|---|
| 第1版 | 初版 |
| 第2版 | 版管理・AIエージェント連携を追記 |
`;

const ESTIMATE = `# 見積書 サンプル案件

| 項目 | 数量 | 金額 |
|---|---|---|
| 要件定義 | 1式 | 500,000円 |
| 設計・開発 | 1式 | 1,800,000円 |
| テスト | 1式 | 400,000円 |
`;

const MINUTES = `# 定例会議 議事録

- 日時: 2026年9月定例
- 参加者: 開発チーム

## 決定事項
- 版管理機能をリリースする
- AIエージェント用 Skill を配布する
`;

const CUSTOMERS = "顧客ID,会社名,担当者,地域\nC001,サンプル商事,山田,東京\nC002,テスト工業,佐藤,大阪\nC003,デモ物産,鈴木,名古屋\n";

const DRAWIO = `<mxfile><diagram name="システム構成"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="ブラウザ" vertex="1" parent="1"/><mxCell id="3" value="Document Manager" vertex="1" parent="1"/>
<mxCell id="4" value="SQLite / PostgreSQL" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>`;

const DRAWIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260" font-family="sans-serif" font-size="16">
<rect width="640" height="260" fill="#fff"/>
<rect x="20" y="95" width="150" height="60" rx="8" fill="#e8f0fe" stroke="#1a56db"/><text x="95" y="130" text-anchor="middle">ブラウザ</text>
<rect x="245" y="95" width="170" height="60" rx="8" fill="#fff3cd" stroke="#b8860b"/><text x="330" y="130" text-anchor="middle">Document Manager</text>
<rect x="480" y="40" width="140" height="60" rx="8" fill="#eaf7ea" stroke="#2f9e44"/><text x="550" y="75" text-anchor="middle">メタDB</text>
<rect x="480" y="150" width="140" height="60" rx="8" fill="#eaf7ea" stroke="#2f9e44"/><text x="550" y="185" text-anchor="middle">文書ストレージ</text>
<g stroke="#555" stroke-width="2"><line x1="170" y1="125" x2="245" y2="125"/><line x1="415" y1="115" x2="480" y2="75"/><line x1="415" y1="135" x2="480" y2="180"/></g>
</svg>`;

const seed = async () => {
	const customers = await upload("顧客リスト.csv", CUSTOMERS);
	await setTags(customers.id, ["顧客管理"]);
	const estimate = await upload("見積書_サンプル案件.md", ESTIMATE);
	await setTags(estimate.id, ["見積書"]);
	const drawio = await upload("システム構成図.drawio", DRAWIO, {preview: {name: "システム構成図.svg", content: DRAWIO_SVG}});
	await setTags(drawio.id, ["設計"]);
	const minutes = await upload("議事録_定例会議.md", MINUTES);
	await setTags(minutes.id, ["議事録"]);

	const specV1 = await upload("仕様書_文書管理システム.md", SPEC_V1);
	await setTags(specV1.id, ["仕様書", "設計"]);

	const project = await api("POST", "api/projects", {name: "サンプル案件プロジェクト"});
	const designFolder = await api("POST", `api/projects/${project.id}/folders`, {name: "設計資料"});
	const salesFolder = await api("POST", `api/projects/${project.id}/folders`, {name: "見積・契約"});
	await api("PUT", `api/projects/${project.id}/documents/${specV1.id}`, {folderId: designFolder.id});
	await api("PUT", `api/projects/${project.id}/documents/${drawio.id}`, {folderId: designFolder.id});
	await api("PUT", `api/projects/${project.id}/documents/${estimate.id}`, {folderId: salesFolder.id});
	await api("PUT", `api/projects/${project.id}/documents/${minutes.id}`, {folderId: null});

	// 新しい版としてアップロード(旧版はアーカイブされ、タグ・プロジェクト配置が引き継がれる)
	const specV2 = await upload("仕様書_文書管理システム.md", SPEC_V2, {previousId: specV1.id});
	await api("PUT", `api/documents/${specV2.id}/memo`, {memo: "第2版で版管理とAIエージェント連携の章を追加。レビュー済み。"});

	// 関連文書(種類・方向を持たない紐付け): 仕様書と、その内容を決めた議事録・構成図
	await api("PUT", `api/documents/${specV2.id}/links/${minutes.id}`);
	await api("PUT", `api/documents/${specV2.id}/links/${drawio.id}`);

	await api("PUT", "api/tag_order", {tags: ["仕様書", "設計", "見積書", "議事録", "顧客管理"]});
	return {specV2, project};
};

const waitForServer = async (proc) => {
	for (let i = 0; i < 60; i++) {
		if (proc.exitCode != null) throw new Error("server exited");
		try {
			const res = await fetch(new URL("_ping", BASE_URL));
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("server did not start");
};

const main = async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-screenshots-"));
	const server = spawn(process.execPath, [path.join(REPO, "app", "server.js")], {
		cwd: path.join(REPO, "app"),
		env: {...process.env, AUTH_DISABLED: "true", DATA_DIR: dataDir, LISTEN_PORT: String(PORT), LOG_LEVEL: "warn", SESSION_SECRET: "screenshots"},
		stdio: "inherit"
	});
	const browser = await chromium.launch();
	try {
		await waitForServer(server);
		const {specV2, project} = await seed();

		const page = await browser.newPage({viewport: VIEWPORT, locale: "ja-JP", timezoneId: "Asia/Tokyo"});
		const shot = async (name) => {
			await page.waitForTimeout(400); // 描画・フォント読み込みの完了待ち
			await page.screenshot({path: path.join(OUT_DIR, `${name}.png`)});
			console.log(`saved: docs/screenshots/${name}.png`);
		};

		// 1. 文書一覧・プレビュー(新しい版の文書を選択し、版履歴を表示)
		await page.goto(BASE_URL);
		await page.locator("#documentList li", {hasText: "仕様書_文書管理システム.md"}).click();
		// 版履歴は既定で1行に畳まれているため、README用には「すべての版」を開いた状態を写す
		await page.locator("#versionHistoryRow .versionToggle").click();
		await page.locator("#versionHistoryRow .versionChip.current").waitFor();
		await page.frameLocator("#previewFrame").locator("h1").waitFor();
		await shot("document-list");

		// 2. タグ体系
		// (draw.io 文書を選び、添付したプレビュー画像が表示される様子も写す)
		await page.locator("#menuTagTreeLink").click();
		await page.locator("#documentList li", {hasText: "システム構成図.drawio"}).first().click();
		await page.frameLocator("#previewFrame").locator("svg").waitFor();
		await shot("tag-tree");

		// 3. プロジェクト(フォルダ階層。新しい版がフォルダ内の同じ位置に引き継がれている)
		await page.locator("#menuProjectsLink").click();
		await page.locator(`.projectTab[data-id="${project.id}"]`).click();
		await page.locator(`.treeDocRow[data-document-id="${specV2.id}"]`).click();
		await page.frameLocator("#previewFrame").locator("h1").waitFor();
		await shot("projects");

		// 4. 操作履歴
		await page.locator("#historyManageLink").click();
		await page.locator("#historyList tr").first().waitFor();
		await shot("history");
		await page.locator("#historyCloseButton").click();

		// 5. APIキー管理と AIエージェント用 Skill
		await page.locator("#menuDocumentsLink").click();
		await page.locator("#apiKeyManageLink").click();
		await page.selectOption("#apiKeyRoleInput", "readwrite");
		await page.locator("#apiKeyExpirySummaryButton").click();
		await page.locator('.expiryRadioPill[data-value="365d"]').click();
		await page.locator("#apiKeyCreateButton").click();
		await page.locator(".apiKeyValue").waitFor();
		// 公開READMEにキー形式の文字列を載せないよう、表示中の平文キーを伏せ字にしてから撮る
		// (一時DBのキーで撮影後に破棄されるが、秘密情報スキャナ等の誤検知も避ける)
		await page.locator(".apiKeyValue").evaluate((el) => { el.textContent = "dm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; });
		await page.locator("#claudeSkillBox summary").click();
		await page.locator('#claudeSkillBox .skillAgentTab[data-agent="claude"]').click();
		// モーダルは縦に長いため、ビューポートを広げてモーダル部分だけを撮る
		await page.setViewportSize({width: VIEWPORT.width, height: 1400});
		await page.waitForTimeout(400);
		await page.locator("#apiKeyModalBox").screenshot({path: path.join(OUT_DIR, "api-keys-skill.png")});
		console.log("saved: docs/screenshots/api-keys-skill.png");
	} finally {
		await browser.close();
		// Windowsではサーバーがファイル(SQLite)を掴んだままだと削除できないため、終了を待ってから消す
		const exited = server.exitCode != null ? Promise.resolve() : new Promise((resolve) => server.once("exit", resolve));
		server.kill();
		await exited;
		fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
	}
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
