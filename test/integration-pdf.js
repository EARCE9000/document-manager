/*!
 * integration-pdf.js : Document Manager と HTML→PDF変換サービス(pdf-converter) を実物同士で繋いだ結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 普段のAPIテストは変換サービスにスタブを使う(本物はChromium入りで大きいため)。
 * ここでは本物を相手に、アップロードから「PDFでダウンロード」で受け取るPDFの中身までを通しで確かめる。
 * 「PDFが返った」だけでなく、**元の文書の文字がPDFに入っていること・1枚に収まっていること**まで見る。
 * Markdownは、記号(# や |)が残っていないこと=整えたプレビューが渡っていることも見る。
 *
 * 実行:
 *   docker build -f pdf-converter/Dockerfile -t dm-pdf-converter:local .
 *   docker run -d --name dm-pdf-converter -p 127.0.0.1:3012:3000 --tmpfs /tmp:rw,size=512m --read-only \
 *     --security-opt no-new-privileges:true --cap-drop ALL dm-pdf-converter:local
 *   npm run test:pdf          (PDF_CONVERTER_URL で接続先を変えられる)
 *
 * 変換サービスに繋がらない場合は、何もせず成功扱いで終える(Dockerの無い環境で壊さない)。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const F = require("../pdf-converter/test/fixtures.js");

const REPO = path.join(__dirname, "..");
const PDF_CONVERTER_URL = process.env.PDF_CONVERTER_URL || "http://127.0.0.1:3012";
const PORT = Number(process.env.INTEGRATION_PORT || 18118);
const BASE_URL = `http://127.0.0.1:${PORT}/`;

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "  ok   " : "  FAIL "}${message}`);
	if (!condition) failures++;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, attempts = 60, intervalMs = 500) => {
	for (let i = 0; i < attempts; i++) {
		try {
			if (await probe()) return true;
		} catch {}
		await sleep(intervalMs);
	}
	return false;
};

const MARKDOWN = `# 導入手順書

本書は **運用サーバ** へ導入する手順です。

| 環境変数 | 既定値 | 意味 | 変更が要る場面 | 備考 | 関連する設定 | 右端の列 |
|---|---|---|---|---|---|---|
| SESSION_MAX_AGE_HOURS | 16 | ログインの有効時間 | 終業をまたいで使う運用のとき | 長くするほど、置き忘れた端末の危険が増す | SESSION_SECRET | 右端まで見えること |
`;

// ブラウザの「名前を付けて保存(1つのファイル)」が作る形。スタイルと画像を別の部品として持つ
const MHTML = [
	"From: <Saved by Blink>",
	"Subject: =?utf-8?Q?=E3=81=8A=E7=9F=A5=E3=82=89=E3=81=9B?=",
	"MIME-Version: 1.0",
	'Content-Type: multipart/related; type="text/html"; boundary="----B"',
	"",
	"------B",
	"Content-Type: text/html",
	"Content-Transfer-Encoding: base64",
	"Content-Location: https://portal.example.com/news",
	"",
	Buffer.from('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="https://portal.example.com/site.css"></head><body><h1>社内ポータルのお知らせ</h1><p>定期メンテナンスを行います。</p></body></html>').toString("base64"),
	"------B",
	"Content-Type: text/css",
	"Content-Transfer-Encoding: quoted-printable",
	"Content-Location: https://portal.example.com/site.css",
	"",
	"body{font-family:sans-serif;background:#eef2f7}h1{color:#243b53}",
	"------B--",
	""
].join("\r\n");

const main = async () => {
	const converterUp = await waitFor(async () => (await fetch(`${PDF_CONVERTER_URL}/health`)).ok, 3, 300);
	if (!converterUp) {
		console.log(`変換サービス(${PDF_CONVERTER_URL})に接続できないため、この結合テストは省略します`);
		console.log("  実行するには: docker run -d --name dm-pdf-converter -p 127.0.0.1:3012:3000 --tmpfs /tmp --read-only dm-pdf-converter:local");
		return;
	}
	const health = await (await fetch(`${PDF_CONVERTER_URL}/health`)).json();
	console.log(`[変換サービス] ${health.chromium}`);

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pdf-int-"));
	const server = spawn(process.execPath, [path.join(REPO, "test", "api", "serve.js")], {
		cwd: REPO,
		env: {
			...process.env,
			DATABASE_BACKEND: "sqlite",
			STORAGE_BACKEND: "local",
			DATA_DIR: dataDir,
			LISTEN_PORT: String(PORT),
			SESSION_SECRET: "pdf-integration",
			LOG_LEVEL: "warn",
			// スタブではなく本物の変換サービスへ繋ぐ(ここがこのテストの目的)
			HTML_PDF_URL: PDF_CONVERTER_URL,
			CONVERTER_STUB_PORT: String(PORT + 1),
			PDF_STUB_PORT: String(PORT + 2)
		},
		stdio: "inherit"
	});

	try {
		const started = await waitFor(async () => (await fetch(`${BASE_URL}_ping`)).ok);
		if (!started) throw new Error("テストサーバが起動しませんでした");
		const keys = JSON.parse(fs.readFileSync(path.join(REPO, "test", "api", ".auth-keys.json"), "utf-8"));
		const auth = {Authorization: `Bearer ${keys.readwrite}`};
		const {PDFParse} = require(path.join(REPO, "app", "node_modules", "pdf-parse"));

		const cases = [
			{file: "報告書.html", body: F.LAYOUT, expect: ["月次レポート", "受注件数", F.SCREEN_ONLY_TEXT], absent: []},
			// 記号が残っていない = 原本ではなく、整えたプレビューが渡っている
			{file: "導入手順書.md", body: MARKDOWN, expect: ["導入手順書", "運用サーバ", "右端まで見えること"], absent: ["# 導入手順書", "**運用サーバ**", "|---"], widened: true},
			{file: "お知らせ.mhtml", body: MHTML, expect: ["社内ポータルのお知らせ", "定期メンテナンスを行います"], absent: ["Content-Type"]}
		];

		for (const {file, body, expect, absent, widened} of cases) {
			console.log(`[${file}]`);
			const form = new FormData();
			form.append("uploadfile", new Blob([body]), file);
			const uploaded = await (await fetch(`${BASE_URL}api/documents`, {method: "POST", headers: auth, body: form})).json();

			const startedAt = Date.now();
			const res = await fetch(`${BASE_URL}api/documents/${uploaded.id}/pdf`, {headers: auth});
			const pdf = Buffer.from(await res.arrayBuffer());
			check(res.status === 200 && String(res.headers.get("content-type")).includes("application/pdf"),
				`PDFとして取得できる (${res.status} / ${((Date.now() - startedAt) / 1000).toFixed(2)}秒 / ${(pdf.length / 1024).toFixed(0)}KB)`);
			check(pdf.subarray(0, 4).toString("latin1") === "%PDF", "PDFとして始まる");
			check(decodeURIComponent(String(res.headers.get("content-disposition"))).includes(file.replace(/\.[^.]+$/, ".pdf")), "保存名は拡張子を .pdf に替えたもの");

			const pages = F.pageSizes(pdf);
			check(pages.length === 1, `1枚のページに収まる (${pages.length}ページ)`);
			if (widened) check(pages[0]?.width > 1280, `横に長い表に合わせて、ページを右へ広げている (幅 ${pages[0]?.width}px)`);

			const parser = new PDFParse({data: pdf});
			try {
				const text = (await parser.getText()).text.replace(/\s+/g, "");
				for (const phrase of expect) check(text.includes(phrase.replace(/\s+/g, "")), `PDFの中身に元の文字が入っている ("${phrase}")`);
				for (const phrase of absent) check(!text.includes(phrase.replace(/\s+/g, "")), `整える前の記号が残っていない ("${phrase}")`);
			} finally {
				await parser.destroy();
			}

			// 元ファイルのダウンロードは従来どおり(PDFに置き換わっていない)
			const original = await fetch(`${BASE_URL}api/documents/${uploaded.id}/file?download=1`, {headers: auth});
			check(Buffer.compare(Buffer.from(await original.arrayBuffer()), Buffer.from(body)) === 0, "元ファイルのダウンロードは変わらない");
		}

		console.log("[対象外]");
		const form = new FormData();
		form.append("uploadfile", new Blob(["a,b\n1,2\n"]), "表.csv");
		const csv = await (await fetch(`${BASE_URL}api/documents`, {method: "POST", headers: auth, body: form})).json();
		const refused = await fetch(`${BASE_URL}api/documents/${csv.id}/pdf`, {headers: auth});
		check(refused.status === 400, `対象外の形式は400 (${refused.status})`);
	} finally {
		server.kill();
		await sleep(500);
		fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 3});
	}

	if (failures > 0) {
		console.log(`\n${failures} 件失敗しました`);
		process.exitCode = 1;
		return;
	}
	console.log("\nすべて成功しました");
};

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
