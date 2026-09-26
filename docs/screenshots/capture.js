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

// モックアップは「ビルド済みのページ一式のZIP」を受け取る。撮影用にその場で組み立てる
// (依存を増やさないよう、zlibだけでZIPの最小構成を作る)
const zlib = require("node:zlib");
const buildZip = (entries) => {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const {name, data} of entries) {
		const nameBuf = Buffer.from(name, "utf-8");
		const body = Buffer.from(data, "utf-8");
		const payload = zlib.deflateRawSync(body, {level: 9});
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + payload.length;
	}
	const localPart = Buffer.concat(locals);
	const centralPart = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
};

const uploadMockup = async (name, zip, previewSvg) => {
	const form = new FormData();
	form.append("mockupfile", new Blob([zip], {type: "application/zip"}), "site.zip");
	form.append("name", name);
	if (previewSvg) form.append("previewfile", new Blob([previewSvg], {type: "image/svg+xml"}), "preview.svg");
	const res = await fetch(new URL("api/mockups", BASE_URL), {method: "POST", body: form});
	const text = await res.text();
	if (!res.ok) throw new Error(`api/mockups ${res.status}: ${text}`);
	return JSON.parse(text);
};

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

// 画面では同梱のdraw.ioビューアがこのXMLをそのまま描画するため、座標・スタイルも入れておく
const DRAWIO = `<mxfile><diagram name="システム構成" id="p1"><mxGraphModel pageWidth="850" pageHeight="500"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="ブラウザ" style="rounded=1;html=1;fillColor=#e8f0fe;strokeColor=#1a56db;" vertex="1" parent="1"><mxGeometry x="40" y="160" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="3" value="Document Manager" style="rounded=1;html=1;fillColor=#fff3cd;strokeColor=#b8860b;" vertex="1" parent="1"><mxGeometry x="280" y="160" width="200" height="60" as="geometry"/></mxCell>
<mxCell id="4" value="SQLite / PostgreSQL" style="rounded=1;html=1;fillColor=#eaf7ea;strokeColor=#2f9e44;" vertex="1" parent="1"><mxGeometry x="560" y="80" width="180" height="60" as="geometry"/></mxCell>
<mxCell id="5" value="文書ストレージ" style="rounded=1;html=1;fillColor=#eaf7ea;strokeColor=#2f9e44;" vertex="1" parent="1"><mxGeometry x="560" y="240" width="180" height="60" as="geometry"/></mxCell>
<mxCell id="6" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="7" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="3" target="4"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="8" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="3" target="5"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const DRAWIO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260" font-family="sans-serif" font-size="16">
<rect width="640" height="260" fill="#fff"/>
<rect x="20" y="95" width="150" height="60" rx="8" fill="#e8f0fe" stroke="#1a56db"/><text x="95" y="130" text-anchor="middle">ブラウザ</text>
<rect x="245" y="95" width="170" height="60" rx="8" fill="#fff3cd" stroke="#b8860b"/><text x="330" y="130" text-anchor="middle">Document Manager</text>
<rect x="480" y="40" width="140" height="60" rx="8" fill="#eaf7ea" stroke="#2f9e44"/><text x="550" y="75" text-anchor="middle">メタDB</text>
<rect x="480" y="150" width="140" height="60" rx="8" fill="#eaf7ea" stroke="#2f9e44"/><text x="550" y="185" text-anchor="middle">文書ストレージ</text>
<g stroke="#555" stroke-width="2"><line x1="170" y1="125" x2="245" y2="125"/><line x1="415" y1="115" x2="480" y2="75"/><line x1="415" y1="135" x2="480" y2="180"/></g>
</svg>`;

const MOCKUP_SITE = [
	{name: "index.html", data: `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">`
		+ `<title>受注管理 モックアップ</title><link rel="stylesheet" href="./assets/style.css"></head>`
		+ `<body><header><h1>受注管理</h1><nav><a href="./index.html">一覧</a>`
		+ `<a href="./pages/detail.html">明細</a></nav></header>`
		+ `<main><div id="app">読み込み中...</div></main><script src="./app.js"></scr` + `ipt></body></html>`},
	{name: "app.js", data: `const rows = [\n`
		+ `\t{id: "SO-1024", customer: "サンプル商事", amount: 482000, status: "手配中"},\n`
		+ `\t{id: "SO-1025", customer: "テスト工業", amount: 128400, status: "出荷済"},\n`
		+ `\t{id: "SO-1026", customer: "デモ物産", amount: 996000, status: "見積"}\n`
		+ `];\n`
		+ `document.getElementById("app").innerHTML =\n`
		+ `\t'<table><thead><tr><th>受注番号</th><th>取引先</th><th>金額</th><th>状態</th></tr></thead><tbody>'\n`
		+ `\t+ rows.map((r) => \`<tr><td>\${r.id}</td><td>\${r.customer}</td>`
		+ `<td class="num">\${r.amount.toLocaleString()}</td><td><span class="badge">\${r.status}</span></td></tr>\`).join("")\n`
		+ `\t+ '</tbody></table>';\n`},
	{name: "assets/style.css", data: `body { font-family: sans-serif; margin: 0; color: #333; }\n`
		+ `header { background: #2b2b2b; color: #fff; padding: 14px 24px; display: flex; gap: 24px; align-items: center; }\n`
		+ `header h1 { font-size: 1.1em; margin: 0; }\n`
		+ `header a { color: #ddd; margin-right: 16px; text-decoration: none; }\n`
		+ `main { padding: 24px; }\n`
		+ `table { border-collapse: collapse; width: 100%; max-width: 760px; }\n`
		+ `th, td { border-bottom: 1px solid #e3e3e3; padding: 10px 12px; text-align: left; font-size: 0.9em; }\n`
		+ `th { background: #f6f7f9; }\n`
		+ `td.num { text-align: right; }\n`
		+ `.badge { background: #eef3fb; color: #1a56db; border-radius: 10px; padding: 2px 10px; font-size: 0.85em; }\n`},
	{name: "pages/detail.html", data: `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">`
		+ `<title>明細</title><link rel="stylesheet" href="../assets/style.css"></head>`
		+ `<body><header><h1>受注明細</h1><nav><a href="../index.html">一覧へ戻る</a></nav></header>`
		+ `<main><p>SO-1024 の明細です。</p></main></body></html>`},
	{name: "sample.csv", data: "受注番号,取引先,金額\nSO-1024,サンプル商事,482000\n"}
];

const MOCKUP_PREVIEW = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" font-family="sans-serif">
<rect width="640" height="400" fill="#ffffff"/>
<rect width="640" height="52" fill="#2b2b2b"/>
<text x="24" y="33" fill="#ffffff" font-size="17" font-weight="700">受注管理</text>
<text x="140" y="33" fill="#cccccc" font-size="13">一覧    明細</text>
<rect x="24" y="84" width="592" height="34" fill="#f6f7f9"/>
<text x="38" y="106" fill="#555" font-size="13">受注番号        取引先                金額          状態</text>
<g font-size="13" fill="#333">
<text x="38" y="150">SO-1024      サンプル商事      482,000</text>
<text x="38" y="192">SO-1025      テスト工業        128,400</text>
<text x="38" y="234">SO-1026      デモ物産          996,000</text>
</g>
<g><rect x="470" y="136" rx="10" width="72" height="20" fill="#eef3fb"/><text x="484" y="151" fill="#1a56db" font-size="12">手配中</text>
<rect x="470" y="178" rx="10" width="72" height="20" fill="#eef3fb"/><text x="484" y="193" fill="#1a56db" font-size="12">出荷済</text>
<rect x="470" y="220" rx="10" width="72" height="20" fill="#eef3fb"/><text x="490" y="235" fill="#1a56db" font-size="12">見積</text></g>
<line x1="24" y1="160" x2="616" y2="160" stroke="#e3e3e3"/><line x1="24" y1="202" x2="616" y2="202" stroke="#e3e3e3"/>
<line x1="24" y1="244" x2="616" y2="244" stroke="#e3e3e3"/></svg>`;

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

	// お品書き(プロジェクトの資料一覧に付ける説明書き)
	const note = (documentId, text) => api("PUT", `api/projects/${project.id}/documents/${documentId}/note`, {note: text});
	await api("PUT", `api/projects/${project.id}/folders/${designFolder.id}/note`, {note: "実装に入る前のレビュー対象。ここが確定したら着手します。"});
	await api("PUT", `api/projects/${project.id}/folders/${salesFolder.id}/note`, {note: "先方へ提出済みのもの。金額の変更はここに追記します。"});
	await note(specV2.id, "第2版が最新。版管理とAIエージェント連携の章が今回の追加分です。");
	await note(drawio.id, "構成の全体像。変換サービスと意味検索は任意なので、無い構成もあります。");
	await note(estimate.id, "初回提示分。値引き後の金額で出しています。");
	await note(minutes.id, "この会議で仕様書の第2版の方針を決めました。");

	// モックアップ(文書とは別のコレクション。ビルド済みのページ一式)
	const mockup = await uploadMockup("受注管理画面 モックアップ", buildZip(MOCKUP_SITE), MOCKUP_PREVIEW);
	await api("PUT", `api/mockups/${mockup.id}/memo`, {memo: "一覧の絞り込みと、状態バッジの色を見てほしい版。明細ページはまだ仮です。"});
	await uploadMockup("在庫照会画面 モックアップ", buildZip(MOCKUP_SITE));

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
		env: {...process.env, AUTH_DISABLED: "true", DATA_DIR: dataDir, LISTEN_PORT: String(PORT), LOG_LEVEL: "warn", SESSION_SECRET: "screenshots", MOCKUPS_ENABLED: "true"},
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
		// (draw.io 文書を選び、同梱のビューアが図をそのまま描画する様子も写す)
		await page.locator("#menuTagTreeLink").click();
		await page.locator("#documentList li", {hasText: "システム構成図.drawio"}).first().click();
		await page.frameLocator("#previewFrame").locator("#viewer svg").waitFor();
		await page.waitForTimeout(600); // 図の描画・縮小の完了待ち
		await shot("tag-tree");

		// 3. プロジェクト(フォルダ階層。新しい版がフォルダ内の同じ位置に引き継がれている)
		await page.locator("#menuProjectsLink").click();
		await page.locator(`.projectTab[data-id="${project.id}"]`).click();
		await page.locator(`.treeDocRow[data-document-id="${specV2.id}"]`).click();
		await page.frameLocator("#previewFrame").locator("h1").waitFor();
		await shot("projects");

		// 4. お品書き(プロジェクト名を押すと、資料一覧と説明書きがプレビュー領域に出る)
		await page.locator("#projectTreeTitle").click();
		await page.locator(".manifestItem").first().waitFor();
		await shot("project-manifest");

		// 5. モックアップ(文書とは別のコレクション)
		await page.locator("#menuMockupsLink").click();
		await page.locator(".mockupCard").first().waitFor();
		// 版履歴は、プレビュー画像のあるカード側で開く(READMEでは見栄えのする方を写す)
		const mockupCard = page.locator(".mockupCard", {hasText: "受注管理画面"});
		await mockupCard.locator(".mockupVersionsToggle").click();
		await mockupCard.locator(".mockupVersionList").waitFor();
		await shot("mockups");

		// 6. 操作履歴
		await page.locator("#historyManageLink").click();
		await page.locator("#historyList tr").first().waitFor();
		await shot("history");
		await page.locator("#historyCloseButton").click();

		// 7. APIキー管理と AIエージェント用 Skill
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
