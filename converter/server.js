/*!
 * server.js : Office文書 → PDF 変換サービス
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * document-manager から内部ネットワーク経由でのみ呼ばれる小さなHTTPサービス。
 * 外部に公開しない前提のため認証は持たない(composeで内部ネットワークに閉じる)。
 *
 *   GET  /health          稼働確認。{status, apiVersion, libreOffice} を返す
 *   POST /convert         本体に変換対象のバイト列、X-Extension に拡張子。application/pdf を返す
 *
 * ファイル名は受け取らない。医療機関の資料などでは**ファイル名自体に患者名・施設名が入り得る**ため、
 * このサービスには拡張子と、ログ用の文書ID(X-Document-Id)しか渡さない。
 *
 * 設計上の要点:
 *   - LibreOfficeは同じユーザープロファイルを共有すると多重起動で失敗する。リクエストごとに
 *     専用のプロファイルディレクトリを渡し、処理後に消す
 *   - 変換は直列(同時実行1)。非力なサーバでも他の処理を圧迫しないことを優先する
 *   - タイムアウトでプロセスを確実に殺す(ハングしたsofficeを残さない)
 *   - 依存パッケージは持たない(Node標準モジュールのみ)
 */

const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn, execFile} = require("node:child_process");

const API_VERSION = "1.0.0";
const PORT = Number(process.env.LISTEN_PORT || 3000);
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), "convert");
// 1ファイルあたりの上限。PowerPointは10MB前後になることがあるため、余裕を見て50MBを既定とする
// (これを超える文書は変換せず、アプリ側の概要プレビューだけで扱う)
const MAX_BYTES = Number(process.env.CONVERT_MAX_BYTES || 50 * 1024 * 1024);
// 1件あたりの変換の打ち切り。超えたらsofficeを強制終了する
const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_SECONDS || 120) * 1000;
// 受け付ける拡張子(アプリ側で検証済みだが、ここでも絞っておく)
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx", ".odt", ".ods", ".odp"]);
// マクロ付きは受け付けない。LibreOfficeは既定でマクロを実行しないが、信用できないファイルを開く
// ソフトに、わざわざマクロ入りを渡す理由がない(アプリ側では概要プレビューのみで扱う)
const MACRO_EXTENSIONS = new Set([".xlsm", ".docm", ".pptm", ".xlsb"]);

const log = (fields, message) => {
	console.log(JSON.stringify({time: new Date().toISOString(), ...fields, msg: message}));
};

/** 変換は直列に流す。先行の処理が終わってから次を始める */
let queue = Promise.resolve();
const runExclusively = (task) => {
	const result = queue.then(task, task);
	// 失敗しても後続を止めない
	queue = result.then(() => undefined, () => undefined);
	return result;
};

const readBody = (req) => new Promise((resolve, reject) => {
	const chunks = [];
	let size = 0;
	req.on("data", (chunk) => {
		size += chunk.length;
		if (size > MAX_BYTES) {
			reject(Object.assign(new Error(`ファイルが大きすぎます(上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB)`), {status: 413}));
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => resolve(Buffer.concat(chunks)));
	req.on("error", reject);
});

/** soffice を1回だけ起動してPDFへ変換する。ハングしたら殺す */
const runSoffice = (inputPath, outputDir, profileDir) => new Promise((resolve, reject) => {
	const child = spawn("soffice", [
		`-env:UserInstallation=file://${profileDir}`,
		"--headless",
		"--norestore",
		"--nolockcheck",
		"--nodefault",
		"--nologo",
		"--convert-to", "pdf",
		"--outdir", outputDir,
		inputPath
	], {stdio: ["ignore", "pipe", "pipe"]});

	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		reject(Object.assign(new Error(`変換がタイムアウトしました(${TIMEOUT_MS / 1000}秒)`), {status: 504}));
	}, TIMEOUT_MS);

	child.on("error", (err) => {
		clearTimeout(timer);
		reject(err);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (code === 0) {
			resolve();
			return;
		}
		reject(new Error(`変換に失敗しました(soffice終了コード ${code}) ${stderr.trim().slice(0, 300)}`));
	});
});

const convert = async (buffer, extension) => {
	if (MACRO_EXTENSIONS.has(extension)) {
		throw Object.assign(new Error(`マクロ付きのファイルは変換しません: ${extension}`), {status: 400});
	}
	if (!ALLOWED_EXTENSIONS.has(extension)) {
		throw Object.assign(new Error(`対応していない拡張子です: ${extension || "(なし)"}`), {status: 400});
	}
	// 対応拡張子はいずれもZIP(OOXML/ODF)。中身が伴わないファイルはここで弾く。
	// LibreOfficeは拡張子と中身が食い違っていてもテキストとして読んでPDFを作ってしまい、
	// 「変換できた」という誤った結果を返してしまうため
	if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
		throw Object.assign(new Error("Office文書として読めません(ZIP形式ではありません)"), {status: 400});
	}
	const jobDir = path.join(WORK_DIR, crypto.randomUUID());
	const inputDir = path.join(jobDir, "in");
	const outputDir = path.join(jobDir, "out");
	const profileDir = path.join(jobDir, "profile");
	// 元のファイル名は使わない(空白・日本語・記号での事故を避ける)。拡張子だけ引き継ぐ
	const inputPath = path.join(inputDir, `source${extension}`);
	try {
		await fs.mkdir(inputDir, {recursive: true});
		await fs.mkdir(outputDir, {recursive: true});
		await fs.mkdir(profileDir, {recursive: true});
		await fs.writeFile(inputPath, buffer);
		await runSoffice(inputPath, outputDir, profileDir);
		const produced = (await fs.readdir(outputDir)).filter((name) => name.toLowerCase().endsWith(".pdf"));
		if (produced.length === 0) throw new Error("PDFが生成されませんでした");
		return await fs.readFile(path.join(outputDir, produced[0]));
	} finally {
		await fs.rm(jobDir, {recursive: true, force: true}).catch(() => {});
	}
};

/** 起動しているLibreOfficeの版(健全性の確認と、障害時の切り分け用) */
const libreOfficeVersion = () => new Promise((resolve) => {
	execFile("soffice", ["--version"], {timeout: 30000}, (err, stdout) => {
		resolve(err ? null : String(stdout).trim().split("\n")[0]);
	});
});

const sendJson = (res, status, body) => {
	const payload = Buffer.from(JSON.stringify(body), "utf-8");
	res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length});
	res.end(payload);
};

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (req.method === "GET" && url.pathname === "/health") {
		sendJson(res, 200, {status: "ok", apiVersion: API_VERSION, libreOffice: await libreOfficeVersion()});
		return;
	}
	if (req.method !== "POST" || url.pathname !== "/convert") {
		sendJson(res, 404, {error: "not found"});
		return;
	}

	// ログにはファイル名ではなく文書ID(Document Manager側のID)を残す
	const documentId = String(req.headers["x-document-id"] || "").slice(0, 100);
	const extension = String(req.headers["x-extension"] || "").toLowerCase();
	const started = Date.now();
	try {
		const buffer = await readBody(req);
		const pdf = await runExclusively(() => convert(buffer, extension));
		log({documentId, extension, bytes: buffer.length, pdfBytes: pdf.length, ms: Date.now() - started}, "converted");
		res.writeHead(200, {"Content-Type": "application/pdf", "Content-Length": pdf.length});
		res.end(pdf);
	} catch (err) {
		const status = err.status || 500;
		log({documentId, extension, ms: Date.now() - started, status, error: err.message}, "convert failed");
		sendJson(res, status, {error: err.message});
	}
});

// 変換に時間がかかるため、既定(2分)より長めに取る
server.requestTimeout = TIMEOUT_MS + 60000;
server.headersTimeout = 60000;

const main = async () => {
	await fs.mkdir(WORK_DIR, {recursive: true});
	// 前回の異常終了で残った作業ディレクトリを掃除する
	for (const name of await fs.readdir(WORK_DIR).catch(() => [])) {
		await fs.rm(path.join(WORK_DIR, name), {recursive: true, force: true}).catch(() => {});
	}
	server.listen(PORT, () => log({port: PORT, apiVersion: API_VERSION}, "converter listening"));
};

main();
