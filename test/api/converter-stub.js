/*!
 * converter-stub.js : 体裁つき表示(PDF変換)のテスト用スタブ
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 本物のconverterはLibreOffice入りで1GB超あり、CIやテストのたびに動かすのは重い。
 * アプリ側の振る舞い(変換の起動・保存・状態の記録・失敗時の退避・再実行)を確かめるには、
 * 「PDFを返すHTTPサービス」があれば足りるため、ここで最小限のものを用意する。
 * 本物との整合は converter/test/smoke.js(実物のLibreOfficeに対する結合テスト)が担保する。
 *
 * テストから振る舞いを変えられる(失敗・遅延の検証用):
 *   POST /__control {"mode":"ok"|"fail"|"slow","delayMs":3000}  次回以降の応答を変える
 *   GET  /__requests                                            受け取ったリクエストの記録を返す
 *                                                               (ファイル名を渡していないことの確認に使う)
 */

const http = require("node:http");

// 最小のPDF(1ページ・空)。中身は問わないので、PDFとして妥当な最小構成にする
const MINIMAL_PDF = Buffer.from(
	"%PDF-1.4\n"
	+ "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
	+ "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
	+ "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
	+ "trailer<</Root 1 0 R>>\n%%EOF\n",
	"latin1"
);

module.exports.start = (port) => new Promise((resolve) => {
	const requests = [];
	let mode = "ok";
	let delayMs = 3000;

	const server = http.createServer((req, res) => {
		if (req.method === "POST" && req.url === "/__control") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				try {
					const control = JSON.parse(body || "{}");
					if (control.mode != null) mode = control.mode;
					if (control.delayMs != null) delayMs = Number(control.delayMs);
					if (control.reset) requests.length = 0;
				} catch {}
				res.writeHead(200, {"Content-Type": "application/json"});
				res.end(JSON.stringify({mode, delayMs, recorded: requests.length}));
			});
			return;
		}
		if (req.method === "GET" && req.url === "/__requests") {
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify(requests));
			return;
		}
		if (req.url === "/health") {
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify({status: "ok", apiVersion: "stub", libreOffice: "stub", maxBytes: 50 * 1024 * 1024, timeoutSeconds: 120}));
			return;
		}
		const documentId = String(req.headers["x-document-id"] || "");
		const extension = String(req.headers["x-extension"] || "");
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
		});
		req.on("end", () => {
			// 受け取った内容を記録しておく(ファイル名が渡っていないことの確認にも使う)
			requests.push({documentId, extension, size, headerNames: Object.keys(req.headers).sort()});
			if (mode === "fail") {
				res.writeHead(500, {"Content-Type": "application/json"});
				res.end(JSON.stringify({error: "スタブが意図的に失敗しました"}));
				return;
			}
			const respond = () => {
				res.writeHead(200, {"Content-Type": "application/pdf", "Content-Length": MINIMAL_PDF.length});
				res.end(MINIMAL_PDF);
			};
			if (mode === "slow") setTimeout(respond, delayMs);
			else respond();
		});
	});
	server.listen(port, "127.0.0.1", () => resolve({server, requests, port: server.address().port}));
});

module.exports.MINIMAL_PDF = MINIMAL_PDF;
