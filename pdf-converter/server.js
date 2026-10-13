/*!
 * server.js : HTML → PDF 変換サービス
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * document-manager から内部ネットワーク経由でのみ呼ばれる小さなHTTPサービス。
 * 外部に公開しない前提のため認証は持たない(composeで内部ネットワークに閉じる)。
 *
 *   GET  /health          稼働確認。{status, apiVersion, chromium, maxBytes, timeoutSeconds, viewportWidth} を返す
 *   POST /convert         本体にHTMLのバイト列(UTF-8)。application/pdf を返す
 *
 * 目的は「HTMLで作った資料を、メールに添付して渡せる形にする」こと。HTMLをそのまま添付すると
 * 相手の環境ではテキストとして出てしまうことがあるため、**画面で見たままの1枚の長いPDF**にする。
 * A4には区切らない(区切ると表や図がページの途中で切れ、右へはみ出した分が欠ける)。
 *
 * ファイル名は受け取らない。ファイル名自体に患者名・施設名等が入り得るため、
 * このサービスにはログ用の文書ID(X-Document-Id)しか渡さない(converter/ と同じ方針)。
 *
 * 設計上の要点:
 *   - 描画はChromium(ブラウザと同じエンジン)。LibreOfficeはHTMLを正しく描けない
 *   - **文書のスクリプトは動かさない**。アプリのプレビューがスクリプトを止めて見せているので、
 *     同じ条件で描けば「画面で見えているもの = PDFに写るもの」になる
 *   - **文書そのもの以外は何も読み込ませない**(外部の画像・CSS、コンテナ内のファイル、内部の宛先)。
 *     読み込みを全てこちらで受け止めて断り、さらに通信先を存在しないプロキシへ向け、
 *     名前解決も失敗させる。そのうえでcompose側のネットワーク構成でも外へ出られなくしてある
 *   - Chromiumは変換1件ごとに起動して捨てる(前の文書の状態を次へ持ち越さない)。
 *     終了時は子プロセスごと止める(親だけ止めると描画用のプロセスが残り、メモリを持ち続ける)
 *   - 変換は直列(同時実行1)。非力なサーバでも他の処理を圧迫しないことを優先する
 *   - 依存パッケージは持たない(Node標準モジュールのみ)。Chromiumとは --remote-debugging-pipe
 *     (fd3/fd4、NUL区切りのJSON)で話すので、待ち受けるポートも増えない
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
const CHROMIUM = process.env.CHROMIUM_PATH || "chromium-headless-shell";
// 1ファイルあたりの上限。画像を埋め込んだHTMLは大きくなるため、Office用と同じ50MBを既定とする
const MAX_BYTES = Number(process.env.CONVERT_MAX_BYTES || 50 * 1024 * 1024);
// 1件あたりの変換の打ち切り。超えたらChromiumを強制終了する
const TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_SECONDS || 60) * 1000;

// 画面として描くときの幅と高さ(px)。アプリのプレビュー枠に近い大きさにしてある。
// 幅を変えると、幅に応じて並びを変える文書(レスポンシブ)の出方が変わる
const VIEWPORT_WIDTH = Number(process.env.PDF_VIEWPORT_WIDTH || 1280);
const VIEWPORT_HEIGHT = 800;
// PDFの1ページは200インチまで(これを超えると開けないビューアがある)。96px/インチなので19200px。
// これより長い文書は、同じ大きさのページへ続ける
const CSS_PX_PER_INCH = 96;
const MAX_PAGE_PX = 200 * CSS_PX_PER_INCH;
// ページの高さに足す遊び(px)。内容の高さぴったりにすると、端数の差で最後の1行だけが
// 次のページへ回ることがある(実際の文書で、末尾の著作権表示だけが2ページ目に出た)
const PAGE_HEIGHT_SLACK = 2;
// 表やコードに合わせてページを右へ広げたとき、右端に付ける余白(px)。無いと紙の端にぴったり付く
const WIDENED_RIGHT_MARGIN = 32;

// 文書が指定するフォント(游ゴシック・メイリオ・Segoe UI など)はコンテナに無いので、
// 最後は総称に落ちる。その落ち先(選んだ理由は pdf-converter/fonts.conf)
const GENERIC_FONTS = Object.freeze({
	standard: "BIZ UDPGothic",
	sansSerif: "BIZ UDPGothic",
	serif: "BIZ UDPMincho",
	fixed: "Liberation Mono"
});

// 文書はこのURLで読み込ませる。実在しない宛先で、この1件だけをこちらから渡す
const DOCUMENT_URL = "http://document.invalid/";
// アプリが文書を配信するときと同じ指定(スクリプトを動かさない)。app/server.js の ACTIVE_CONTENT_CSP
const DOCUMENT_CSP = "script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

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
	let exceeded = false;
	req.on("data", (chunk) => {
		size += chunk.length;
		if (size > MAX_BYTES) {
			if (!exceeded) {
				exceeded = true;
				chunks.length = 0;
				reject(Object.assign(new Error(`ファイルが大きすぎます(上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB)`), {status: 413}));
			}
			// ここで接続を切るとクライアントが413を読み取れず、通信エラーとしか分からなくなる。
			// 応答を届けるため、以降のデータは読み捨てて受け切る。
			// ただし極端に送り続けてくる相手には付き合わない
			if (size > MAX_BYTES * 2) req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (!exceeded) resolve(Buffer.concat(chunks));
	});
	req.on("error", reject);
});

/**
 * Chromiumを1つ起動し、DevToolsプロトコルで話すための口を返す。
 * @param {string} profileDir この1件だけで使うプロファイルの置き場所
 */
const launch = (profileDir) => {
	const child = spawn(CHROMIUM, [
		"--remote-debugging-pipe",
		`--user-data-dir=${profileDir}`,
		// Chromium自身のサンドボックスは、権限を絞ったコンテナ(非root・no-new-privileges・
		// 既定のseccomp)の中では立ち上げられない。隔離はコンテナ側(外へ出られないネットワーク・
		// 読み取り専用・権限なし)で行う。スクリプトを動かさず通信も断つので攻撃の入口は狭いが、
		// 描画そのものの欠陥に対する守りはコンテナの隔離だけになる(pdf-converter/README.md参照)
		"--no-sandbox",
		"--disable-gpu",
		// /dev/shm はコンテナの既定で64MBしかなく、大きなページで落ちる。作業場所(tmpfs)を使わせる
		"--disable-dev-shm-usage",
		"--hide-scrollbars",
		"--no-first-run",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-default-apps",
		// 通信は全て、存在しないプロキシへ向ける(IPアドレスを直接書かれても届かない)。
		// 自分自身(127.0.0.1)宛ても例外にしない
		"--proxy-server=http://127.0.0.1:9",
		"--proxy-bypass-list=<-loopback>",
		// 名前解決も全て失敗させる
		"--host-resolver-rules=MAP * ~NOTFOUND",
		"about:blank"
	], {
		// 子プロセスごと止められるよう、独立したプロセスグループにする
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
	});

	const writer = child.stdio[3];
	const reader = child.stdio[4];
	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	let buffered = Buffer.alloc(0);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-2000);
	});

	reader.on("data", (chunk) => {
		buffered = Buffer.concat([buffered, chunk]);
		let end;
		while ((end = buffered.indexOf(0)) >= 0) {
			let message;
			try {
				message = JSON.parse(buffered.subarray(0, end).toString("utf-8"));
			} catch {
				message = null;
			}
			buffered = buffered.subarray(end + 1);
			if (message == null) continue;
			if (message.id != null && pending.has(message.id)) {
				const {resolve, reject} = pending.get(message.id);
				pending.delete(message.id);
				if (message.error) reject(new Error(String(message.error.message)));
				else resolve(message.result);
			} else if (message.method) {
				for (const listener of listeners) listener(message);
			}
		}
	});
	const failAll = (err) => {
		for (const {reject} of pending.values()) reject(err);
		pending.clear();
	};
	// 口が先に閉じても落ちないようにする(強制終了のあとに書き込みが残っていることがある)
	writer.on("error", () => {});
	reader.on("error", () => {});
	child.on("exit", (code) => failAll(new Error(`Chromiumが終了しました(終了コード ${code}) ${stderr.trim().slice(-300)}`)));
	child.on("error", (err) => failAll(err));

	const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, {resolve, reject});
		writer.write(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}) + "\0");
	});
	const on = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const waitFor = (method, sessionId) => new Promise((resolve) => {
		const off = on((message) => {
			if (message.method === method && message.sessionId === sessionId) {
				off();
				resolve(message.params);
			}
		});
	});
	return {child, send, on, waitFor};
};

/** Chromiumを、子プロセスごと確実に止める */
const terminate = async (child) => {
	const exited = child.exitCode != null || child.signalCode != null
		? Promise.resolve()
		: new Promise((resolve) => child.once("exit", resolve));
	try {
		// 負のPIDはプロセスグループ全体を指す
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	await exited;
};

/**
 * 紙に出す前の下ごしらえ。**この関数は文字列にしてページの中で動かす**(外の変数は参照できない)。
 * 文書のスクリプトとは別の世界(isolated world)で動かすので、文書側からは触れない。
 *
 *  1. 画面の高さ・幅を基準にした長さ(vh など)を、画面で見たときの値に固定する。
 *     紙では「1vh = ページの高さの1%」になるため、長い1枚のページにすると
 *     「画面いっぱい」の指定がページ全体の高さまで膨らみ、残りが次のページへ押し出される
 *  2. 中でスクロールさせている枠を開く。PDFではスクロールできず、はみ出した分が欠けるため
 *     (横に長い表・1行が長いコード・高さを区切った一覧)
 *  3. 文書の幅を、画面で見たときの幅に固定する。ページを右へ広げても、中央寄せの本文が
 *     広げた分だけ右へずれていかないようにするため
 */
const PREPARE = (viewportWidth, viewportHeight) => {
	const notes = {viewportUnits: 0, opened: 0, scrollWidth: 0};
	const unit = {
		vh: viewportHeight, svh: viewportHeight, lvh: viewportHeight, dvh: viewportHeight,
		vw: viewportWidth, svw: viewportWidth, lvw: viewportWidth, dvw: viewportWidth,
		vmin: Math.min(viewportWidth, viewportHeight), vmax: Math.max(viewportWidth, viewportHeight)
	};
	const pattern = /(-?\d*\.?\d+)(svh|lvh|dvh|vh|svw|lvw|dvw|vw|vmin|vmax)\b/g;
	const freeze = (style) => {
		for (const name of Array.from(style)) {
			const value = style.getPropertyValue(name);
			pattern.lastIndex = 0;
			if (!pattern.test(value)) continue;
			pattern.lastIndex = 0;
			style.setProperty(name, value.replace(pattern, (_, n, u) => `${(Number(n) * unit[u]) / 100}px`), style.getPropertyPriority(name));
			notes.viewportUnits++;
		}
	};
	const walk = (rules) => {
		for (const rule of Array.from(rules || [])) {
			if (rule.style) freeze(rule.style);
			if (rule.cssRules) walk(rule.cssRules);
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			walk(sheet.cssRules);
		} catch {
			// 読めないスタイルシートは触らない
		}
	}
	for (const el of document.querySelectorAll("[style]")) freeze(el.style);

	// 外側から順に開く(外を開くと内側の幅が変わるため、要素ごとに測り直す)
	for (const el of document.querySelectorAll("body, body *")) {
		const computed = getComputedStyle(el);
		const scrollsX = /auto|scroll/.test(computed.overflowX) && el.scrollWidth > el.clientWidth + 1;
		const scrollsY = /auto|scroll/.test(computed.overflowY) && el.scrollHeight > el.clientHeight + 1;
		if (!scrollsX && !scrollsY) continue;
		if (scrollsY) {
			el.style.setProperty("height", "auto", "important");
			el.style.setProperty("max-height", "none", "important");
		}
		el.style.setProperty("overflow", "visible", "important");
		// 枠そのものを中身の幅まで広げる(背景や罫線が、はみ出した中身の下まで届くように)
		if (scrollsX) el.style.setProperty("min-width", "max-content", "important");
		notes.opened++;
	}

	document.documentElement.style.setProperty("width", `${viewportWidth}px`, "important");
	notes.scrollWidth = document.documentElement.scrollWidth;
	return notes;
};

/**
 * HTMLをPDFにする。
 * @param {Buffer} html
 * @returns {Promise<{pdf: Buffer, width: number, contentHeight: number, pageHeight: number, notes: object, blocked: number}>}
 */
const convert = async (html) => {
	const jobDir = path.join(WORK_DIR, crypto.randomUUID());
	await fs.mkdir(jobDir, {recursive: true});
	const browser = launch(jobDir);
	let blocked = 0;
	let timer;
	try {
		const work = (async () => {
			const {targetId} = await browser.send("Target.createTarget", {url: "about:blank"});
			const {sessionId} = await browser.send("Target.attachToTarget", {targetId, flatten: true});
			const send = (method, params) => browser.send(method, params, sessionId);
			const mainFrameId = (await send("Page.getFrameTree")).frameTree.frame.id;

			// 読み込みは全てこちらで受け止める。文書そのもの以外は通さない
			browser.on((message) => {
				if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
				const {requestId, request} = message.params;
				if (request.url === DOCUMENT_URL) {
					send("Fetch.fulfillRequest", {
						requestId,
						responseCode: 200,
						responseHeaders: [
							{name: "Content-Type", value: "text/html; charset=utf-8"},
							{name: "Content-Security-Policy", value: DOCUMENT_CSP}
						],
						body: html.toString("base64")
					}).catch(() => {});
					return;
				}
				blocked++;
				if (message.params.resourceType === "Document" && message.params.frameId === mainFrameId) {
					// 文書が自分を別のページへ移そうとしている(meta refresh など)。失敗させると
					// エラーページに置き換わり、白紙のPDFになる。「内容なし(204)」で応えると、
					// 移動だけが取り消されて、いまの文書が残る
					send("Fetch.fulfillRequest", {requestId, responseCode: 204}).catch(() => {});
					return;
				}
				send("Fetch.failRequest", {requestId, errorReason: "BlockedByClient"}).catch(() => {});
			});
			await send("Fetch.enable", {patterns: [{urlPattern: "*"}]});
			await send("Page.enable");
			// 総称(sans-serif・serif・monospace)と、何も指定が無いときのフォントを決める。
			// Chromiumの既定は Arial / Times New Roman で、コンテナでは Liberation に置き換わる。
			// そのままだと日本語は「足りない字の控え」として1文字ずつ探され、太字が別のフォント
			// (Noto。図形として埋め込まれPDFが膨らむ)になった。system-ui の落ち先は fonts.conf で決める
			await send("Page.setFontFamilies", {fontFamilies: GENERIC_FONTS});
			await send("Emulation.setScriptExecutionDisabled", {value: true});
			await send("Emulation.setDeviceMetricsOverride", {width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false});
			// 印刷用ではなく、画面用の見た目で描く(印刷用のCSSで配置が変わるのを避ける)
			await send("Emulation.setEmulatedMedia", {media: "screen"});

			const loaded = browser.waitFor("Page.loadEventFired", sessionId);
			await send("Page.navigate", {url: DOCUMENT_URL});
			await loaded;

			const {executionContextId} = await send("Page.createIsolatedWorld", {frameId: mainFrameId, worldName: "prepare"});
			const prepared = await send("Runtime.evaluate", {
				expression: `(${PREPARE.toString()})(${VIEWPORT_WIDTH}, ${VIEWPORT_HEIGHT})`,
				contextId: executionContextId,
				returnByValue: true
			});
			if (prepared.exceptionDetails) throw new Error(`下ごしらえに失敗しました: ${JSON.stringify(prepared.exceptionDetails).slice(0, 300)}`);
			const notes = prepared.result.value;

			// 内容の大きさに合わせた1枚のページにする
			const {cssContentSize} = await send("Page.getLayoutMetrics");
			const contentWidth = Math.max(Math.ceil(cssContentSize.width), Number(notes.scrollWidth) || 0);
			const width = contentWidth > VIEWPORT_WIDTH ? contentWidth + WIDENED_RIGHT_MARGIN : VIEWPORT_WIDTH;
			const contentHeight = Math.max(1, Math.ceil(cssContentSize.height));
			const pageHeight = Math.min(contentHeight + PAGE_HEIGHT_SLACK, MAX_PAGE_PX);
			const {data} = await send("Page.printToPDF", {
				printBackground: true,
				preferCSSPageSize: false,
				paperWidth: width / CSS_PX_PER_INCH,
				paperHeight: pageHeight / CSS_PX_PER_INCH,
				marginTop: 0,
				marginBottom: 0,
				marginLeft: 0,
				marginRight: 0
			});
			return {pdf: Buffer.from(data, "base64"), width, contentHeight, pageHeight, notes};
		})();
		// 打ち切りで先に抜けたあと、止めたChromium側の失敗が「誰も受け取らない失敗」にならないようにする
		work.catch(() => {});
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error(`変換がタイムアウトしました(${TIMEOUT_MS / 1000}秒)`), {status: 504})), TIMEOUT_MS);
		});
		const result = await Promise.race([work, timeout]);
		return {...result, blocked};
	} finally {
		clearTimeout(timer);
		await terminate(browser.child);
		await fs.rm(jobDir, {recursive: true, force: true}).catch(() => {});
	}
};

/** 入っているChromiumの版(健全性の確認と、障害時の切り分け用)。1度取れたら覚えておく */
let knownChromiumVersion = null;
const chromiumVersion = () => new Promise((resolve) => {
	if (knownChromiumVersion != null) {
		resolve(knownChromiumVersion);
		return;
	}
	execFile(CHROMIUM, ["--version"], {timeout: 30000}, (err, stdout) => {
		knownChromiumVersion = err ? null : String(stdout).trim().split("\n")[0];
		resolve(knownChromiumVersion);
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
		sendJson(res, 200, {
			status: "ok",
			apiVersion: API_VERSION,
			chromium: await chromiumVersion(),
			// 実際に効いている設定。反映されているかを外から確認できるようにする
			maxBytes: MAX_BYTES,
			timeoutSeconds: TIMEOUT_MS / 1000,
			viewportWidth: VIEWPORT_WIDTH
		});
		return;
	}
	if (req.method !== "POST" || url.pathname !== "/convert") {
		sendJson(res, 404, {error: "not found"});
		return;
	}

	// ログにはファイル名ではなく文書ID(Document Manager側のID)を残す
	const documentId = String(req.headers["x-document-id"] || "").slice(0, 100);
	const started = Date.now();
	try {
		const buffer = await readBody(req);
		if (buffer.length === 0) throw Object.assign(new Error("本体が空です"), {status: 400});
		const result = await runExclusively(() => convert(buffer));
		log({
			documentId, bytes: buffer.length, pdfBytes: result.pdf.length,
			width: result.width, contentHeight: result.contentHeight, pageHeight: result.pageHeight,
			// 読み込ませなかった外部の部品の数(画像が抜けた、という問い合わせの切り分け用)
			blocked: result.blocked, notes: result.notes, ms: Date.now() - started
		}, "converted");
		res.writeHead(200, {
			"Content-Type": "application/pdf",
			"Content-Length": result.pdf.length,
			"X-Blocked-Requests": String(result.blocked)
		});
		res.end(result.pdf);
	} catch (err) {
		const status = err.status || 500;
		log({documentId, ms: Date.now() - started, status, error: err.message}, "convert failed");
		sendJson(res, status, {error: err.message});
	}
});

server.requestTimeout = TIMEOUT_MS + 60000;
server.headersTimeout = 60000;

const main = async () => {
	await fs.mkdir(WORK_DIR, {recursive: true});
	// 前回の異常終了で残った作業ディレクトリを掃除する
	for (const name of await fs.readdir(WORK_DIR).catch(() => [])) {
		await fs.rm(path.join(WORK_DIR, name), {recursive: true, force: true}).catch(() => {});
	}
	server.listen(PORT, () => log({port: PORT, apiVersion: API_VERSION}, "pdf-converter listening"));
};

main();
