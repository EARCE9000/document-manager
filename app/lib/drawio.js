/*!
 * drawio.js : draw.io(.drawio)ファイルから全文検索用のテキストを抽出する純関数
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * .drawio は <mxfile> 直下に1つ以上の <diagram> を持つXML。<diagram> の中身は
 *   (a) 生の <mxGraphModel>...</mxGraphModel>(非圧縮。近年の既定)
 *   (b) base64(deflate(urlencode(XML)))(圧縮。旧既定・Webの「図の編集」経由等)
 * のどちらか。(b)は base64 デコード → raw inflate → decodeURIComponent で (a) に戻せる。
 * 図形ラベルは mxCell の value 属性に入り、HTMLラベルの場合はHTMLエスケープされて格納される。
 * ここではページ名(diagramのname)と各value属性を集め、タグ除去・エンティティ復元して返す。
 * 外部I/Oは行わない。壊れた入力でも例外を投げず、取れた範囲のテキスト(無ければ空文字)を返す。
 */

const zlib = require("zlib");

// HTMLエンティティを最低限復元する(検索用なので主要なものだけで十分)
const decodeEntities = (value) => String(value ?? "")
	.replace(/&lt;/g, "<")
	.replace(/&gt;/g, ">")
	.replace(/&quot;/g, '"')
	.replace(/&#39;/g, "'")
	.replace(/&apos;/g, "'")
	.replace(/&nbsp;/g, " ")
	// &amp; は最後に戻す(二重復元を避ける)
	.replace(/&amp;/g, "&");

// タグを除去して可読テキストにする(HTMLラベル対策)
const stripTags = (value) => String(value ?? "").replace(/<[^>]*>/g, " ");

// <diagram> の中身が圧縮(base64)なら展開し、非圧縮ならそのまま返す。失敗時は null
const inflateDiagram = (inner) => {
	const trimmed = inner.trim();
	if (trimmed === "") return null;
	if (trimmed.includes("<mxGraphModel")) return trimmed; // 非圧縮
	try {
		const raw = zlib.inflateRawSync(Buffer.from(trimmed, "base64")).toString("utf8");
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
};

/**
 * .drawio のXML文字列から全文検索用テキストを抽出する。
 * @param {string} xml .drawioファイルの中身(UTF-8文字列)
 * @returns {string} 抽出テキスト(改行区切り)。抽出できない場合は空文字
 */
const extractDrawioText = (xml) => {
	const source = String(xml ?? "");
	const parts = [];

	// ページ名(<diagram name="...">)
	for (const m of source.matchAll(/<diagram\b[^>]*\bname="([^"]*)"/g)) {
		parts.push(decodeEntities(m[1]));
	}

	// 各 <diagram>...</diagram> の中身を集める(非圧縮はそのまま・圧縮は展開)
	const models = [];
	let matchedDiagram = false;
	for (const m of source.matchAll(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g)) {
		matchedDiagram = true;
		const model = inflateDiagram(m[1]);
		if (model != null) models.push(model);
	}
	// <diagram> が見つからない(断片XML等)場合はファイル全体を対象にする
	if (!matchedDiagram) models.push(source);

	// mxCell等の value 属性(=図形ラベル)を抽出
	for (const model of models) {
		for (const m of model.matchAll(/\bvalue="([^"]*)"/g)) {
			const label = stripTags(decodeEntities(m[1])).trim();
			if (label !== "") parts.push(label);
		}
	}

	// 連続空白を畳んで返す
	return parts.join("\n").replace(/[ \t]+/g, " ").trim();
};

module.exports = {extractDrawioText};
