/*!
 * integration-converter.js : Document Manager と 変換サービス(converter) を実物同士で繋いだ結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 普段のAPIテストは変換サービスにスタブを使う(本物はLibreOffice入りで1GB超あるため)。
 * ここでは本物のconverterを相手に、アップロードからPDFの中身までを通しで確かめる。
 * 「PDFが返った」だけでなく、**元の文書の文字がPDFに入っていること**まで見る
 * (フォント・変換経路の取り違えで、体裁だけできて中身が落ちる事故を捕まえるため)。
 *
 * 実行:
 *   docker run -d --name dm-converter -p 3010:3000 --tmpfs /tmp:rw,size=512m --read-only \
 *     --memory 1g dm-converter:local
 *   npm run test:converter          (CONVERTER_URL で接続先を変えられる)
 *
 * converterに繋がらない場合は、何もせず成功扱いで終える(Dockerの無い環境でnpm testを壊さない)。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");

const REPO = path.join(__dirname, "..");
const CONVERTER_URL = process.env.CONVERTER_URL || "http://127.0.0.1:3010";
const PORT = Number(process.env.INTEGRATION_PORT || 18098);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const FIXTURES = path.join(__dirname, "fixtures", "office");

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

const main = async () => {
	// converterが動いていなければ、このテストは行わない(環境によっては動かせないため)
	const converterUp = await waitFor(async () => (await fetch(`${CONVERTER_URL}/health`)).ok, 3, 300);
	if (!converterUp) {
		console.log(`変換サービス(${CONVERTER_URL})に接続できないため、この結合テストは省略します`);
		console.log("  実行するには: docker run -d --name dm-converter -p 3010:3000 --tmpfs /tmp --read-only dm-converter:local");
		return;
	}
	const health = await (await fetch(`${CONVERTER_URL}/health`)).json();
	console.log(`[変換サービス] ${health.libreOffice}`);

	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-conv-int-"));
	const server = spawn(process.execPath, [path.join(REPO, "test", "api", "serve.js")], {
		cwd: REPO,
		env: {
			...process.env,
			DATABASE_BACKEND: "sqlite",
			STORAGE_BACKEND: "local",
			DATA_DIR: dataDir,
			LISTEN_PORT: String(PORT),
			SESSION_SECRET: "converter-integration",
			LOG_LEVEL: "warn",
			// スタブではなく本物の変換サービスへ繋ぐ(ここがこのテストの目的)
			OFFICE_RENDER_URL: CONVERTER_URL,
			CONVERTER_STUB_PORT: String(PORT + 1)
		},
		stdio: "inherit"
	});

	try {
		const started = await waitFor(async () => (await fetch(`${BASE_URL}_ping`)).ok);
		if (!started) throw new Error("テストサーバが起動しませんでした");
		const keys = JSON.parse(fs.readFileSync(path.join(REPO, "test", "api", ".auth-keys.json"), "utf-8"));
		const auth = {Authorization: `Bearer ${keys.readwrite}`};

		const {PDFParse} = require(path.join(REPO, "app", "node_modules", "pdf-parse"));

		// 実ファイルごとに、PDFの中身に元の文字が入っているかまで確かめる。
		// Excelは列幅が足りないと文字が切れる(Excelで印刷したときと同じ挙動)ため、
		// 期待値には切れない文字列を使う。切れた内容は概要プレビュー側で確認できる
		const cases = [
			{file: "sample.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", expect: "テスト工業"},
			{file: "sample.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expect: "導入手順書"},
			{file: "sample.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", expect: "文書管理システムのご提案"}
		];

		for (const {file, type, expect} of cases) {
			console.log(`[${file}]`);
			const form = new FormData();
			form.append("uploadfile", new Blob([fs.readFileSync(path.join(FIXTURES, file))], {type}), file);
			const uploaded = await (await fetch(`${BASE_URL}api/documents`, {method: "POST", headers: auth, body: form})).json();

			const startedAt = Date.now();
			let status = null;
			const done = await waitFor(async () => {
				const doc = await (await fetch(`${BASE_URL}api/documents/${uploaded.id}`, {headers: auth})).json();
				status = doc.renderStatus;
				return status === "ok" || status === "failed";
			}, 120, 500);
			check(done && status === "ok", `変換が完了する (renderStatus=${status} / ${((Date.now() - startedAt) / 1000).toFixed(1)}秒)`);

			const res = await fetch(`${BASE_URL}api/documents/${uploaded.id}/file?render=1`, {headers: auth});
			check(res.status === 200 && res.headers.get("content-type").includes("application/pdf"), "PDFとして取得できる");
			const pdf = Buffer.from(await res.arrayBuffer());
			check(pdf.subarray(0, 4).toString("latin1") === "%PDF", "PDFとして始まる");

			// 中身の確認: 元の文書の文字がPDFに入っているか(文字化け・空PDFを捕まえる)
			const parser = new PDFParse({data: pdf});
			try {
				const info = await parser.getInfo();
				const text = (await parser.getText()).text;
				check(info.total >= 1, `ページがある (${info.total}ページ / ${(pdf.length / 1024).toFixed(0)}KB)`);
				check(text.includes(expect), `PDFの中身に元の文字が入っている ("${expect}")`);
			} finally {
				await parser.destroy();
			}

			// 概要プレビューとダウンロードが壊れていないこと
			const preview = await fetch(`${BASE_URL}api/documents/${uploaded.id}/file`, {headers: auth});
			check(preview.headers.get("content-type").includes("text/html"), "概要プレビューは従来どおりHTML");
			const original = await fetch(`${BASE_URL}api/documents/${uploaded.id}/file?download=1`, {headers: auth});
			check(Buffer.from(await original.arrayBuffer()).subarray(0, 2).toString("latin1") === "PK", "ダウンロードは元のOfficeファイル");
		}

		// マクロ付きは変換に出さない(本物のconverterも受け取らない)
		console.log("[マクロ付き]");
		const macroForm = new FormData();
		macroForm.append("uploadfile", new Blob([fs.readFileSync(path.join(FIXTURES, "sample.xlsx"))]), "macro.xlsm");
		const macro = await (await fetch(`${BASE_URL}api/documents`, {method: "POST", headers: auth, body: macroForm})).json();
		await sleep(1500);
		const macroDoc = await (await fetch(`${BASE_URL}api/documents/${macro.id}`, {headers: auth})).json();
		check(macroDoc.renderStatus == null, "マクロ付きは変換に出さない");
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
