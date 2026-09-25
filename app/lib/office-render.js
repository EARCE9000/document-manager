/*!
 * office-render.js : Office文書を「体裁つき」で見るためのPDF変換(converterサービスの呼び出し)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 画面の既定のプレビューは、依存も待ち時間も無いアプリ内蔵の概要表示(lib/office.js)。
 * こちらは元の体裁(フォント・図形・グラフ)を確認したいときのための追加機能で、
 * LibreOfficeを積んだ別コンテナ(converter/)へHTTPで投げてPDFを受け取る。
 *
 * OFFICE_RENDER_URL が未設定なら、この機能は丸ごと無効になる(従来どおり概要表示だけ)。
 * 変換に失敗しても、文書の登録・検索・概要表示には影響させない。
 *
 * converterへはファイル名を渡さない。ファイル名自体に患者名・施設名等が入り得るため、
 * 渡すのは拡張子と、ログ用の文書IDだけにしている(converter/README.md参照)。
 */

const path = require("path");
// 他のモジュールと同じく、ファクトリを名前付きで呼ぶこと。呼び忘れるとファクトリ関数そのものが
// 入り、logger.warn 等が存在しないまま実行時に落ちる(変換サービスに到達できないときだけ
// 通る経路だったため、長く気づけなかった)
const logger = require("./logger.js")(path.basename(__filename));

const RENDER_URL = (process.env.OFFICE_RENDER_URL || "").replace(/\/+$/, "");
// 変換対象の上限。converter側の上限(既定50MB)より大きくしても意味がないため揃える
const MAX_BYTES = Number(process.env.OFFICE_RENDER_MAX_BYTES || 50 * 1024 * 1024);
// 応答を待つ上限。converter側の打ち切り(既定120秒)より少し長く取る
const TIMEOUT_MS = Number(process.env.OFFICE_RENDER_TIMEOUT_SECONDS || 150) * 1000;

// 体裁つき表示の対象。マクロ付き(.xlsm/.docm/.pptm)は変換に出さない
// (LibreOfficeは既定でマクロを実行しないが、信用できないファイルを開くソフトに渡す理由がない)
const RENDERABLE_EXTENSIONS = Object.freeze([".xlsx", ".docx", ".pptx"]);

// 変換結果の保存名。プレビュー(preview.html)とは別に、同じ文書フォルダへ置く
const RENDER_FILENAME = "render.pdf";

module.exports.RENDERABLE_EXTENSIONS = RENDERABLE_EXTENSIONS;
module.exports.RENDER_FILENAME = RENDER_FILENAME;
module.exports.MAX_BYTES = MAX_BYTES;

/** 体裁つき表示が使える構成か(converterの接続先が設定されているか) */
module.exports.isEnabled = () => RENDER_URL !== "";

/** この拡張子・大きさの文書を変換に出すか */
module.exports.isRenderable = (extension, size) =>
	RENDER_URL !== "" && RENDERABLE_EXTENSIONS.includes(String(extension || "").toLowerCase()) && Number(size) <= MAX_BYTES;

/**
 * converterへ文書を渡してPDFを受け取る。
 * @param {Buffer} buffer 文書の中身
 * @param {string} extension 小文字の拡張子
 * @param {string} documentId ログ用(converter側のログに残る)
 * @returns {Promise<Buffer>} PDF。失敗時は例外(理由をmessageに持つ)
 */
module.exports.renderToPdf = async (buffer, extension, documentId) => {
	if (RENDER_URL === "") throw new Error("体裁つき表示は無効です(OFFICE_RENDER_URL が未設定)");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${RENDER_URL}/convert`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Extension": extension,
				"X-Document-Id": documentId
			},
			body: buffer,
			signal: controller.signal
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			let message = detail.slice(0, 300);
			try {
				message = JSON.parse(detail).error || message;
			} catch {}
			throw new Error(`変換サービスがエラーを返しました(HTTP ${res.status}): ${message}`);
		}
		const pdf = Buffer.from(await res.arrayBuffer());
		if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("変換サービスの応答がPDFではありません");
		return pdf;
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`変換サービスが${TIMEOUT_MS / 1000}秒以内に応答しませんでした`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
};

/** converterの稼働確認(起動時のログ用。失敗してもアプリは動く) */
module.exports.checkHealth = async () => {
	if (RENDER_URL === "") return null;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		try {
			const res = await fetch(`${RENDER_URL}/health`, {signal: controller.signal});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		logger.warn({err: err.message, url: RENDER_URL}, "体裁つき表示: 変換サービスに接続できません(概要プレビューのみで動作します)");
		return null;
	}
};
