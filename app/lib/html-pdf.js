/*!
 * html-pdf.js : HTML・Markdown・MHTML・draw.io の文書を、PDFにして渡すための変換(pdf-converterサービスの呼び出し)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * HTMLで作った資料をメールに添付すると、相手の環境ではテキストとして出てしまうことがある。
 * そこで「画面で見たままの1枚の長いPDF」にして持ち出せるようにする。描画は、Chromiumを積んだ
 * 別コンテナ(pdf-converter/)へHTTPで投げて行う。
 *
 * HTML_PDF_URL が未設定なら、この機能は丸ごと無効になる(画面にボタンも出ない)。
 *
 * Office文書の体裁つき表示(lib/office-render.js)と違い、**変換結果は保存しない**。
 * 1件あたり1秒かからず、押されたときに作れば足りる。保存すると、版を上げたときや
 * プレビューの作りを変えたときに「古いPDFが出る」事故の元になる。
 *
 * pdf-converterへはファイル名を渡さない。ファイル名自体に患者名・施設名等が入り得るため、
 * 渡すのは中身と、ログ用の文書IDだけにしている(pdf-converter/README.md参照)。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const PDF_URL = (process.env.HTML_PDF_URL || "").replace(/\/+$/, "");
// 変換対象の上限。pdf-converter側の上限(既定50MB)より大きくしても意味がないため揃える
const MAX_BYTES = Number(process.env.HTML_PDF_MAX_BYTES || 50 * 1024 * 1024);
// 応答を待つ上限。pdf-converter側の打ち切り(既定60秒)より少し長く取る
const TIMEOUT_MS = Number(process.env.HTML_PDF_TIMEOUT_SECONDS || 90) * 1000;

// PDFにできる文書(元ファイルの拡張子)。いずれも、プレビューとして見せているものがHTML。
//   .html/.htm      元ファイルそのもの
//   .md/.markdown   見出しや表を整えたプレビュー(素のMarkdownではない)
//   .mhtml/.mht     保存されていた画像・スタイルごと1つのHTMLへ直したプレビュー
// CSVやOfficeの概要表示もHTMLだが対象にしない(表計算やOfficeの原本を渡すほうが相手の役に立つ)
const HTML_SOURCE_EXTENSIONS = Object.freeze([".html", ".htm", ".md", ".markdown", ".mhtml", ".mht"]);
// draw.io は元ファイル(XML)を渡し、pdf-converter が同梱のビューアで描く。図の1ページが紙1枚になる
const DRAWIO_SOURCE_EXTENSIONS = Object.freeze([".drawio"]);
const SOURCE_EXTENSIONS = Object.freeze([...HTML_SOURCE_EXTENSIONS, ...DRAWIO_SOURCE_EXTENSIONS]);

module.exports.SOURCE_EXTENSIONS = SOURCE_EXTENSIONS;
module.exports.DRAWIO_SOURCE_EXTENSIONS = DRAWIO_SOURCE_EXTENSIONS;
/** この拡張子が draw.io として変換するものか(元ファイルを渡す) */
module.exports.isDrawio = (extension) => DRAWIO_SOURCE_EXTENSIONS.includes(String(extension || "").toLowerCase());
module.exports.MAX_BYTES = MAX_BYTES;

/** PDFでの持ち出しが使える構成か(pdf-converterの接続先が設定されているか) */
module.exports.isEnabled = () => PDF_URL !== "";

/** この拡張子の文書をPDFにできるか(構成が有効で、対象の形式であること) */
module.exports.isConvertible = (extension) =>
	PDF_URL !== "" && SOURCE_EXTENSIONS.includes(String(extension || "").toLowerCase());

/**
 * PDFにしたときのファイル名。元の拡張子を .pdf に替える。
 * @param {string} entryFile 元のファイル名
 */
module.exports.pdfFileName = (entryFile) => {
	const name = String(entryFile || "document");
	const extension = path.extname(name);
	return `${extension === "" ? name : name.slice(0, -extension.length)}.pdf`;
};

/**
 * pdf-converterへHTML(または draw.io の図)を渡してPDFを受け取る。
 * @param {Buffer} html プレビューとして見せているHTML(UTF-8)。format が "drawio" なら .drawio の元ファイル
 * @param {string} documentId ログ用(pdf-converter側のログに残る)
 * @param {{format?: "html"|"drawio"}} [options]
 * @returns {Promise<{pdf: Buffer, blocked: number}>} blockedは、読み込ませなかった外部の部品の数。
 *   失敗時は例外(理由をmessageに、利用者へ返すHTTPステータスをstatusに持つ)
 */
module.exports.convertToPdf = async (html, documentId, {format = "html"} = {}) => {
	if (PDF_URL === "") throw Object.assign(new Error("PDFでの持ち出しは無効です(HTML_PDF_URL が未設定)"), {status: 404});
	if (html.length > MAX_BYTES) {
		throw Object.assign(new Error(`文書が大きすぎるためPDFにできません(上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB)`), {status: 413});
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const drawio = format === "drawio";
		const res = await fetch(`${PDF_URL}/${drawio ? "convert-drawio" : "convert"}`, {
			method: "POST",
			headers: {
				"Content-Type": drawio ? "application/xml" : "text/html; charset=utf-8",
				"X-Document-Id": documentId
			},
			body: html,
			signal: controller.signal
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			let message = detail.slice(0, 300);
			try {
				message = JSON.parse(detail).error || message;
			} catch {}
			// draw.io に対応する前の pdf-converter(1.0.x)と、draw.io の変換を止めている(DRAWIO_DISABLED)
			// pdf-converter は、draw.io の受け口を持たない。「変換に失敗した」ではなく、理由が分かるように伝える
			if (drawio && res.status === 404) {
				throw Object.assign(new Error("変換サービスが draw.io に対応していません(pdf-converter のイメージが古いか、DRAWIO_DISABLED で draw.io の変換を止めています)"), {status: 502});
			}
			// 大きすぎる・時間切れ・図として読めない(422)は、利用者が次に何をすればよいか分かるよう
			// そのまま伝える。それ以外(変換サービス側の不具合)は、こちらの都合なので502にまとめる
			const status = [413, 422, 504].includes(res.status) ? res.status : 502;
			throw Object.assign(new Error(`変換サービスがエラーを返しました(HTTP ${res.status}): ${message}`), {status});
		}
		const pdf = Buffer.from(await res.arrayBuffer());
		if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") {
			throw Object.assign(new Error("変換サービスの応答がPDFではありません"), {status: 502});
		}
		return {pdf, blocked: Number(res.headers.get("x-blocked-requests") || 0)};
	} catch (err) {
		if (err.name === "AbortError") {
			throw Object.assign(new Error(`変換サービスが${TIMEOUT_MS / 1000}秒以内に応答しませんでした`), {status: 504});
		}
		if (err.status == null) {
			// 接続できない(落ちている・名前が引けない)
			throw Object.assign(new Error(`変換サービスに接続できません: ${err.message}`), {status: 502});
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
};

/** pdf-converterの稼働確認(起動時のログと、管理画面の状態表示用。失敗してもアプリは動く) */
module.exports.checkHealth = async () => {
	if (PDF_URL === "") return null;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		try {
			const res = await fetch(`${PDF_URL}/health`, {signal: controller.signal});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		logger.warn({err: err.message, url: PDF_URL}, "PDFでの持ち出し: 変換サービスに接続できません(PDFのダウンロードだけが使えなくなります)");
		return null;
	}
};
