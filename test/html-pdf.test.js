/*!
 * html-pdf.test.js : 「PDFでダウンロード」のアプリ側の部品(lib/html-pdf.js)と、構成の約束ごと
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 変換そのものは別コンテナ(pdf-converter)で、無くても・落ちていてもアプリは動き続ける。
 * 「無い環境では機能ごと消える」「落ちていても巻き込まれない」を、ここで固定する。
 * あわせて、他人が作ったHTMLをブラウザのエンジンで開くコンテナの隔離(compose)と、
 * 画面・サーバ・変換サービスに散っている値の食い違いを見張る。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf-8");

/** 環境変数を変えて読み込み直す(設定はrequire時に読まれるため) */
const load = (url) => {
	if (url == null) delete process.env.HTML_PDF_URL;
	else process.env.HTML_PDF_URL = url;
	delete require.cache[require.resolve("../app/lib/html-pdf.js")];
	return require("../app/lib/html-pdf.js");
};

test("接続先が未設定なら、機能ごと無効になる", async () => {
	const HtmlPdf = load(null);
	assert.equal(HtmlPdf.isEnabled(), false);
	// 対象の形式でも、変換できるとは答えない(画面にボタンを出さない)
	assert.equal(HtmlPdf.isConvertible(".html"), false);
	assert.equal(await HtmlPdf.checkHealth(), null);
	await assert.rejects(HtmlPdf.convertToPdf(Buffer.from("<p>x</p>"), "202610_x"), (err) => err.status === 404);
});

test("対象は HTML・Markdown・MHTML・draw.io だけ", () => {
	const HtmlPdf = load("http://127.0.0.1:19918");
	for (const extension of [".html", ".htm", ".md", ".markdown", ".mhtml", ".mht", ".drawio", ".HTML", ".Md", ".DRAWIO"]) {
		assert.equal(HtmlPdf.isConvertible(extension), true, extension);
	}
	// CSVやOfficeの概要表示もプレビューはHTMLだが、渡すなら原本のほうが相手の役に立つ
	for (const extension of [".csv", ".tsv", ".txt", ".xlsx", ".docx", ".pdf", ".svg", ".mmd", "", null, undefined]) {
		assert.equal(HtmlPdf.isConvertible(extension), false, String(extension));
	}
	// draw.io だけは、プレビューではなく元ファイル(XML)を渡して描かせる
	assert.equal(HtmlPdf.isDrawio(".drawio"), true);
	assert.equal(HtmlPdf.isDrawio(".html"), false);
});

/** 変換サービスの代わり。受けたパスと種類を記録し、決めた応答を返す */
const withStubConverter = async (respond, run) => {
	const http = require("node:http");
	const received = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			received.push({path: req.url, contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString()});
			respond(req, res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(load(`http://127.0.0.1:${server.address().port}`), received);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
};
const pdfResponse = (req, res) => {
	res.writeHead(200, {"Content-Type": "application/pdf", "X-Blocked-Requests": "1"});
	res.end("%PDF-1.7 stub");
};

test("draw.io は draw.io 用の受け口へ、元のXMLのまま送る", async () => {
	await withStubConverter(pdfResponse, async (HtmlPdf, received) => {
		const {pdf, blocked} = await HtmlPdf.convertToPdf(Buffer.from("<mxfile/>"), "202610_x", {format: "drawio"});
		assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
		assert.equal(blocked, 1);
		await HtmlPdf.convertToPdf(Buffer.from("<p>x</p>"), "202610_y");
		assert.deepEqual(received.map((r) => [r.path, r.contentType, r.body]), [
			["/convert-drawio", "application/xml", "<mxfile/>"],
			["/convert", "text/html; charset=utf-8", "<p>x</p>"]
		]);
	});
});

// draw.io に対応する前のイメージ・draw.io を止めている変換サービスは /convert-drawio を持たない(404)。
// 「変換に失敗した」だけでは、何をすればよいか分からない
test("draw.io に対応していない変換サービスなら、その理由を伝える", async () => {
	await withStubConverter((req, res) => {
		res.writeHead(404, {"Content-Type": "application/json"});
		res.end(JSON.stringify({error: "not found"}));
	}, async (HtmlPdf) => {
		await assert.rejects(HtmlPdf.convertToPdf(Buffer.from("<mxfile/>"), "202610_x", {format: "drawio"}), (err) => {
			assert.equal(err.status, 502);
			assert.match(err.message, /draw\.io に対応していません/);
			assert.match(err.message, /イメージが古い/);
			assert.match(err.message, /DRAWIO_DISABLED/);
			return true;
		});
	});
});

test("図として読めない(422)は、そのまま利用者へ伝える", async () => {
	await withStubConverter((req, res) => {
		res.writeHead(422, {"Content-Type": "application/json"});
		res.end(JSON.stringify({error: "図を描けませんでした: draw.io のファイルとして読めません"}));
	}, async (HtmlPdf) => {
		await assert.rejects(HtmlPdf.convertToPdf(Buffer.from("x"), "202610_x", {format: "drawio"}), (err) => {
			assert.equal(err.status, 422);
			assert.match(err.message, /draw\.io のファイルとして読めません/);
			return true;
		});
	});
});

test("保存名は、元の名前の拡張子を .pdf に替えたもの", () => {
	const HtmlPdf = load("http://127.0.0.1:19918");
	assert.equal(HtmlPdf.pdfFileName("報告書.html"), "報告書.pdf");
	assert.equal(HtmlPdf.pdfFileName("議事録 10月.md"), "議事録 10月.pdf");
	// 途中の点は名前の一部
	assert.equal(HtmlPdf.pdfFileName("v1.2 設計.mhtml"), "v1.2 設計.pdf");
	assert.equal(HtmlPdf.pdfFileName("拡張子なし"), "拡張子なし.pdf");
	assert.equal(HtmlPdf.pdfFileName(""), "document.pdf");
	assert.equal(HtmlPdf.pdfFileName(null), "document.pdf");
});

test("到達できない変換サービスでも例外を投げず、状態確認は null を返す", async () => {
	// 何も待ち受けていないポートを指す
	const HtmlPdf = load("http://127.0.0.1:19918");
	assert.equal(HtmlPdf.isEnabled(), true);
	assert.equal(await HtmlPdf.checkHealth(), null, "到達できなければ null(例外ではない)");
});

test("到達できないときの変換は、502として失敗する(500でアプリの不具合に見せない)", async () => {
	const HtmlPdf = load("http://127.0.0.1:19918");
	await assert.rejects(HtmlPdf.convertToPdf(Buffer.from("<p>x</p>"), "202610_x"), (err) => {
		assert.equal(err.status, 502);
		assert.match(err.message, /接続できません/);
		return true;
	});
});

test("大きすぎる文書は、変換サービスへ送る前に413で断る", async () => {
	process.env.HTML_PDF_MAX_BYTES = "10";
	try {
		const HtmlPdf = load("http://127.0.0.1:19918");
		await assert.rejects(HtmlPdf.convertToPdf(Buffer.alloc(11), "202610_x"), (err) => err.status === 413);
	} finally {
		delete process.env.HTML_PDF_MAX_BYTES;
	}
});

// 対象の形式は、サーバ(ボタンを押したあとの判定)と画面(ボタンを出すかの判定)の2か所にある。
// ずれると「ボタンは出るのに押すと400」「使えるのにボタンが出ない」になる
test("対象の形式が、サーバと画面で一致している", () => {
	const HtmlPdf = load("http://127.0.0.1:19918");
	const matched = read("app", "static", "index.html").match(/const PDF_SOURCE_EXTENSIONS = (\[[^\]]+\]);/);
	assert.ok(matched, "画面側の一覧が見つからない");
	assert.deepEqual(JSON.parse(matched[1]), [...HtmlPdf.SOURCE_EXTENSIONS]);
});

// AIエージェント用のクライアント(download --pdf)も、同じ一覧を持って先に断っている。
// ずれると、サーバでは変換できる文書を、クライアントが「できません」と断ってしまう
test("対象の形式が、同梱クライアント(Python版・Node.js版)とも一致している", () => {
	const HtmlPdf = load("http://127.0.0.1:19918");
	const python = read("tools", "claude-skill", "document-manager", "scripts", "dm_client.py").match(/^PDF_SOURCE_EXTENSIONS = \(([^)]+)\)/m);
	const node = read("tools", "claude-skill", "document-manager", "scripts", "dm_client.mjs").match(/^const PDF_SOURCE_EXTENSIONS = (\[[^\]]+\]);/m);
	assert.ok(python && node, "クライアント側の一覧が見つからない");
	assert.deepEqual(JSON.parse(`[${python[1]}]`), [...HtmlPdf.SOURCE_EXTENSIONS], "Python版");
	assert.deepEqual(JSON.parse(node[1]), [...HtmlPdf.SOURCE_EXTENSIONS], "Node.js版");
});

// スクリプトを止める指定は、アプリの配信と変換サービスの両方にある。変換サービス側だけ
// 緩むと、プレビューでは動かないスクリプトがPDFを作るときだけ動く
test("変換サービスは、アプリが文書を配信するときと同じ指定でスクリプトを止める", () => {
	const pick = (text, name) => {
		const matched = text.match(new RegExp(`const ${name} = "([^"]+)";`));
		assert.ok(matched, `${name} が見つからない`);
		return matched[1];
	};
	assert.equal(pick(read("pdf-converter", "server.js"), "DOCUMENT_CSP"), pick(read("app", "server.js"), "ACTIVE_CONTENT_CSP"));
});

// ---- 運用構成(deploy/compose.yml) ----
const composeLines = read("deploy", "compose.yml").split(/\r?\n/);
const blockOf = (headingPattern) => {
	const start = composeLines.findIndex((line) => headingPattern.test(line));
	if (start < 0) return [];
	const indent = composeLines[start].search(/\S/);
	const block = [];
	for (let i = start + 1; i < composeLines.length; i++) {
		const line = composeLines[i];
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (line.search(/\S/) <= indent) break;
		block.push(line);
	}
	return block;
};
const listNetworks = (block) => {
	const start = block.findIndex((line) => /^\s*networks:\s*$/.test(line));
	if (start < 0) return [];
	const indent = block[start].search(/\S/);
	const names = [];
	for (let i = start + 1; i < block.length; i++) {
		if (block[i].search(/\S/) <= indent) break;
		const item = /^\s*-?\s*([A-Za-z0-9_-]+):?\s*$/.exec(block[i]);
		if (item) names.push(item[1]);
	}
	return names;
};

test("compose: pdf-converterは専用ネットワークにしか参加しない", () => {
	const service = blockOf(/^ {2}pdf-converter:\s*$/);
	assert.ok(service.length > 0, "pdf-converterサービスが定義されている");
	assert.deepEqual(listNetworks(service), ["document_manager_pdf"],
		"Office用の変換サービスやWeaviateが居るネットワークに参加していない");
});

test("compose: PDF用のネットワークは外部へ出られない(internal)", () => {
	const networks = blockOf(/^networks:\s*$/);
	const start = networks.findIndex((line) => /^\s*document_manager_pdf:\s*$/.test(line));
	assert.ok(start >= 0, "document_manager_pdf が定義されている");
	assert.match(networks[start + 1] || "", /internal:\s*true/, "internal: true が無いと、文書に書かれた外部の宛先へ取りに行ける");
});

test("compose: Office用の変換サービスとは、互いに届かない", () => {
	const converter = listNetworks(blockOf(/^ {2}converter:\s*$/));
	const pdfConverter = listNetworks(blockOf(/^ {2}pdf-converter:\s*$/));
	assert.deepEqual(converter.filter((name) => pdfConverter.includes(name)), [], "同じネットワークに同居している");
});

test("compose: アプリはpdf-converterと通信でき、無くても起動する", () => {
	const app = blockOf(/^ {2}app:\s*$/);
	assert.ok(listNetworks(app).includes("document_manager_pdf"), "アプリはPDF用のネットワークに参加する");
	assert.match(app.join("\n"), /HTML_PDF_URL:\s*http:\/\/pdf-converter:3000/);
	const dependsStart = app.findIndex((line) => /^\s*depends_on:/.test(line));
	const depends = dependsStart < 0 ? "" : app.slice(dependsStart).join("\n");
	assert.doesNotMatch(depends, /pdf-converter/, "依存に入れると、変換サービスの取得に失敗したときにアプリまで起動しなくなる");
});

test("compose: pdf-converterは書き込み不可・権限昇格不可で動かす", () => {
	const service = blockOf(/^ {2}pdf-converter:\s*$/).join("\n");
	assert.match(service, /read_only:\s*true/, "ファイルシステムは読み取り専用");
	assert.match(service, /no-new-privileges:true/, "権限昇格を禁止する");
	assert.match(service, /tmpfs:/, "作業場所はメモリ上の一時領域にする");
	assert.doesNotMatch(service, /^\s*volumes:/m, "ホストのディレクトリを渡さない");
	assert.doesNotMatch(service, /^\s*ports:/m, "ホストにポートを公開しない");
	assert.match(service, /mem_limit:/, "メモリの上限を持つ");
});

// ---- イメージ(pdf-converter/Dockerfile) ----
test("Dockerfile: 後始末とフォントの前提が入っている", () => {
	const dockerfile = read("pdf-converter", "Dockerfile");
	// 無いと、止めたChromiumの子プロセスが終了済みのまま溜まっていく
	assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
	assert.match(dockerfile, /^USER node$/m, "rootで動かさない");
	// 無いと、文書が指定するフォントが無いときの落ち先が環境まかせになる(本文が等幅になった)
	assert.match(dockerfile, /COPY pdf-converter\/fonts\.conf \/etc\/fonts\/local\.conf/);
	for (const family of ["BIZ UDPGothic", "BIZ UDPMincho"]) {
		assert.ok(read("pdf-converter", "fonts.conf").includes(`<family>${family}</family>`), `fonts.conf に ${family} が無い`);
		assert.ok(read("pdf-converter", "server.js").includes(`"${family}"`), `server.js の総称の割り当てに ${family} が無い`);
	}
});

// ---- 公開(CI) ----
test("pdf-converter-publish.yml: 版の決め方と古いタグの整理が、他のイメージと同じ", () => {
	const text = read(".github", "workflows", "pdf-converter-publish.yml");
	assert.match(text, /TZ=Asia\/Tokyo date \+%Y%m%d\.%H%M\)/, "版は YYYYMMDD.HHMM(JST)");
	assert.match(text, /earce9000\/document-manager-pdf-converter:latest/);
	const pattern = new RegExp(text.match(/grep -E '([^']+)'/)[1]);
	assert.ok(pattern.test("20261013.0930"));
	for (const keep of ["latest", "20261013", "v1.2.3"]) assert.equal(pattern.test(keep), false, `${keep} まで消してしまう`);
	// 公開の前に、実物での結合テストを通す
	assert.ok(text.indexOf("pdf-converter/test/smoke.js") < text.indexOf("push: true"), "テストより先に公開している");
	assert.match(text, /schedule:/, "コードが変わらなくても、Chromiumのセキュリティ修正を取り込む定期ビルドがある");
});

// ---- Docker Hubの説明文 ----
// Docker Hubは説明文を 25,000 バイトまでしか受け付けない。書き足して超えると、貼り付けたときに
// 初めて分かる(実際に、PDFの説明を足して 27,631 バイトになり、反映できなかった)
const DOCKERHUB_OVERVIEW_MAX_BYTES = 25000;
const DOCKERHUB_DESCRIPTION_MAX_CHARS = 100;

for (const file of ["dockerhub-overview.md", "dockerhub-pdf-converter-overview.md", "dockerhub-converter-overview.md"]) {
	test(`${file}: Docker Hubの上限に収まっている`, () => {
		const text = read("docs", file);
		const end = text.indexOf("-->");
		assert.ok(end > 0, "冒頭の注意書き(コメント)が見つからない");
		// 貼り付けるのはコメントより下。改行がCRLFになっていても収まること
		const body = text.slice(end + 3).trim().split(/\r?\n/).join("\r\n");
		const bytes = Buffer.byteLength(body, "utf-8");
		assert.ok(bytes <= DOCKERHUB_OVERVIEW_MAX_BYTES,
			`本文が ${bytes} バイトある(上限 ${DOCKERHUB_OVERVIEW_MAX_BYTES})。足した分だけ削ること`);

		// 短い説明(Description)欄は100文字まで。コメントの中の、英字で始まりピリオドで終わる1行がそれ
		const descriptions = text.slice(0, end).split(/\r?\n/).map((line) => line.trim())
			.filter((line) => /^[A-Z][A-Za-z]/.test(line) && line.endsWith("."));
		assert.equal(descriptions.length, 1, `短い説明の行が1つに決まらない(${descriptions.length}件)`);
		assert.ok(descriptions[0].length <= DOCKERHUB_DESCRIPTION_MAX_CHARS,
			`短い説明が ${descriptions[0].length} 文字ある(上限 ${DOCKERHUB_DESCRIPTION_MAX_CHARS})`);
	});
}
