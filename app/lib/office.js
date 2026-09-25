/*!
 * office.js : Office文書(.xlsx/.docx/.pptx)から概要プレビュー用HTMLと全文検索用テキストを作る純関数
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * これらはいずれも「ZIP + XML」(OOXML)で、中の必要なXMLだけを読めば文章・セル・スライドの
 * テキストを取り出せる。ブラウザはこれらの形式を描画できないため、サーバ側で簡易HTMLへ変換し、
 * 既存のプレビュー(preview.html)の仕組みにそのまま乗せる。
 *
 * 目的は「どんな内容かを概要として確認できること」であり、元の体裁の再現ではない。
 * フォント・色・セル書式・図形の配置・グラフは再現しない(画像も現時点では取り込まない)。
 * 体裁の確認が必要な場合は、ダウンロードして元のアプリで開いてもらう。
 *
 * 外部I/Oは行わない。壊れた入力でも例外を投げず、取れた範囲を返すか null を返す。
 * マクロ(.xlsm等のvbaProject)は読まないし実行もしない(このサーバがファイルを開くことはない)。
 */

const zlib = require("zlib");

// 展開後のサイズ上限。ZIP爆弾(小さな書庫が巨大に展開される)でメモリを食い潰さないための歯止め
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;

// プレビューに出す量の上限(概要が分かれば十分なため、大きな文書は途中で打ち切る)
const LIMITS = Object.freeze({
	sheets: 30,
	rowsPerSheet: 300,
	columnsPerSheet: 50,
	paragraphs: 3000,
	tableRows: 300,
	slides: 200
});

const OFFICE_KINDS = Object.freeze({
	".xlsx": "sheet", ".xlsm": "sheet",
	".docx": "document", ".docm": "document",
	".pptx": "slides", ".pptm": "slides"
});

module.exports.OFFICE_EXTENSIONS = Object.freeze(Object.keys(OFFICE_KINDS));
module.exports.LIMITS = LIMITS;

/* _/_/_/ ZIP(必要なエントリだけを展開する最小の読み取り) _/_/_/ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

// 書庫末尾のEnd of Central Directoryを後ろから探す(コメントは最大64KB)
const findEndOfCentralDirectory = (buffer) => {
	const from = Math.max(0, buffer.length - (0xffff + 22));
	for (let offset = buffer.length - 22; offset >= from; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return -1;
};

/**
 * ZIPの中央ディレクトリを読み、wantsが真を返す名前のエントリだけを展開する。
 * @param {Buffer} buffer ZIP全体
 * @param {(name: string) => boolean} wants 読みたいエントリか
 * @param {{maxEntryBytes?: number, maxTotalBytes?: number}} limits 展開後サイズの上限(テストから差し替える)
 * @returns {Map<string, Buffer>|null} 名前→中身。ZIPとして読めなければ null
 */
const readZipEntries = (buffer, wants, limits = {}) => {
	const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_BYTES;
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) return null;
	let entryCount = buffer.readUInt16LE(eocd + 10);
	let directoryOffset = buffer.readUInt32LE(eocd + 16);
	// ZIP64(サイズ・件数が32bitに収まらない)の書庫は対象外にする(Office文書では通常発生しない)
	if (entryCount === 0xffff || directoryOffset === 0xffffffff) return null;

	const entries = new Map();
	let total = 0;
	let offset = directoryOffset;
	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;

		if (!wants(name)) continue;
		// ヘッダーの展開後サイズは「申告値」で、書庫を作る側が自由に書ける。
		// ここで弾けるのは正直に申告された大きいエントリだけで、嘘をつかれたら通ってしまう。
		// 実際の歯止めは下の maxOutputLength(実際に出てきた量で打ち切る)のほう
		if (uncompressedSize > maxEntryBytes || total + uncompressedSize > maxTotalBytes) continue;
		// ローカルヘッダーは可変長(名前・拡張領域)なので、そこを読み飛ばして中身の先頭を求める
		if (localOffset + 30 > buffer.length) return null;
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const data = buffer.subarray(dataStart, dataStart + compressedSize);
		try {
			// 展開の上限を zlib 自身に渡す。申告値ではなく実際に出てきた量で打ち切るため、
			// 「小さいと申告して大きく膨らむ」書庫(ZIP爆弾)を止められる。
			// 上限に達すると ERR_BUFFER_TOO_LARGE で失敗し、そのエントリは読み飛ばされる。
			// 残り容量ぶんだけを許すことで、エントリ数で稼ぐ手口も合計側で頭打ちになる
			const remaining = Math.max(0, maxTotalBytes - total);
			const allowed = Math.min(maxEntryBytes, remaining);
			if (allowed === 0) continue;
			const content = method === 0
				// 無圧縮のエントリは膨らまないが、宣言サイズと実データの食い違いを避けるため同じ上限で切る
				? Buffer.from(data.subarray(0, allowed))
				: zlib.inflateRawSync(data, {maxOutputLength: allowed});
			total += content.length;
			entries.set(name, content);
		} catch {
			// 壊れたエントリ・上限を超えたエントリは読み飛ばす(残りから取れるだけ取る)
		}
	}
	return entries;
};

/* _/_/_/ XML(必要な要素だけを正規表現で拾う。依存を増やさないための割り切り) _/_/_/ */

const decodeEntities = (value) => String(value ?? "")
	.replace(/&lt;/g, "<")
	.replace(/&gt;/g, ">")
	.replace(/&quot;/g, '"')
	.replace(/&#39;/g, "'")
	.replace(/&apos;/g, "'")
	.replace(/&#x?([0-9a-fA-F]+);/g, (whole, code) => {
		const point = whole.includes("x") || whole.includes("X") ? parseInt(code, 16) : Number(code);
		return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
	})
	// &amp; は最後に戻す(二重復元を避ける)
	.replace(/&amp;/g, "&");

const escapeHtml = (value) => String(value ?? "")
	.replace(/&/g, "&amp;")
	.replace(/</g, "&lt;")
	.replace(/>/g, "&gt;")
	.replace(/"/g, "&quot;");

// 指定タグの中身を順に返す(<w:t>等。属性は無視し、自己終了タグは空として扱う)
const matchAll = (xml, tagName) => {
	const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tagName}>)`, "g");
	const results = [];
	let match;
	while ((match = pattern.exec(xml)) != null) results.push(match[1] ?? "");
	return results;
};

const attributeOf = (tag, name) => {
	const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
	return match == null ? null : decodeEntities(match[1]);
};

// <a:t>/<w:t>等のテキストノードを連結する
const textOf = (xml, tagName) => matchAll(xml, tagName).map(decodeEntities).join("");

/* _/_/_/ Excel _/_/_/ */

// 列参照(A, B, ..., AA)を0始まりの列番号にする
const columnIndexOf = (cellRef) => {
	const letters = /^([A-Z]+)/.exec(String(cellRef || "").toUpperCase());
	if (letters == null) return -1;
	let index = 0;
	for (const character of letters[1]) index = index * 26 + (character.charCodeAt(0) - 64);
	return index - 1;
};

// Excelの日付は1900年1月0日からの連番。1900年をうるう年とみなす歴史的な仕様のため基準は1899-12-30
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const formatExcelDate = (serial, showsTime) => {
	const date = new Date(EXCEL_EPOCH_MS + Math.round(serial * 24 * 60 * 60 * 1000));
	if (!Number.isFinite(date.getTime())) return String(serial);
	const pad = (value) => String(value).padStart(2, "0");
	const day = `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
	if (!showsTime) return day;
	return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

// スタイル定義から「そのセルが日付として表示されているか」を引けるようにする
const readDateStyles = (stylesXml) => {
	if (stylesXml == null) return [];
	const customFormats = new Map();
	for (const tag of stylesXml.match(/<numFmt\b[^>]*\/?>/g) || []) {
		const id = Number(attributeOf(tag, "numFmtId"));
		const code = attributeOf(tag, "formatCode") || "";
		if (Number.isFinite(id)) customFormats.set(id, code);
	}
	const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
	if (cellXfs == null) return [];
	return (cellXfs[1].match(/<xf\b[^>]*\/?>/g) || []).map((tag) => {
		const id = Number(attributeOf(tag, "numFmtId"));
		if (!Number.isFinite(id)) return null;
		if (BUILTIN_DATE_FORMATS.has(id)) return {date: true, time: id === 45 || id === 46 || id === 47 || id === 22};
		const code = customFormats.get(id);
		// 書式文字列に年月日が含まれていれば日付とみなす("[$-ja-JP]yyyy年m月d日" 等)
		if (code != null && /[yYdD]/.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, ""))) {
			return {date: true, time: /[hH]/.test(code)};
		}
		return null;
	});
};

const readSharedStrings = (xml) => {
	if (xml == null) return [];
	// <si> ごとに、中の <t> を連結する(書式の切れ目で <r><t> に分かれることがある)
	return matchAll(xml, "si").map((item) => textOf(item, "t"));
};

const parseSheet = (xml, sharedStrings, dateStyles) => {
	const rows = [];
	let truncated = false;
	const rowPattern = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
	let rowMatch;
	while ((rowMatch = rowPattern.exec(xml)) != null) {
		if (rows.length >= LIMITS.rowsPerSheet) {
			truncated = true;
			break;
		}
		const cells = [];
		const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
		let cellMatch;
		while ((cellMatch = cellPattern.exec(rowMatch[2])) != null) {
			const attributes = cellMatch[1];
			const inner = cellMatch[2] ?? "";
			const type = attributeOf(attributes, "t");
			const columnIndex = columnIndexOf(attributeOf(attributes, "r"));
			let value = "";
			if (type === "s") {
				const index = Number(textOf(inner, "v"));
				value = sharedStrings[index] ?? "";
			} else if (type === "inlineStr") {
				value = textOf(inner, "t");
			} else if (type === "b") {
				value = textOf(inner, "v") === "1" ? "TRUE" : "FALSE";
			} else if (type === "e") {
				value = textOf(inner, "v");
			} else {
				// 数値(または数式の計算結果)。日付書式のセルは日付として見せる
				const raw = textOf(inner, "v");
				value = raw;
				const style = dateStyles[Number(attributeOf(attributes, "s"))];
				if (style != null && style.date && raw !== "" && Number.isFinite(Number(raw))) {
					value = formatExcelDate(Number(raw), style.time);
				}
			}
			if (value === "") continue;
			const target = columnIndex >= 0 ? columnIndex : cells.length;
			if (target >= LIMITS.columnsPerSheet) {
				truncated = true;
				continue;
			}
			cells[target] = value;
		}
		if (cells.length === 0) continue;
		rows.push(Array.from(cells, (cell) => cell ?? ""));
	}
	return {rows, truncated};
};

const convertWorkbook = (entries) => {
	const decode = (name) => (entries.has(name) ? entries.get(name).toString("utf8") : null);
	const workbookXml = decode("xl/workbook.xml");
	if (workbookXml == null) return null;
	const sharedStrings = readSharedStrings(decode("xl/sharedStrings.xml"));
	const dateStyles = readDateStyles(decode("xl/styles.xml"));

	// シート名とXMLファイルの対応は workbook.xml(名前と関係ID) と rels(関係IDとパス)で決まる
	const relationships = new Map();
	for (const tag of (decode("xl/_rels/workbook.xml.rels") || "").match(/<Relationship\b[^>]*\/?>/g) || []) {
		relationships.set(attributeOf(tag, "Id"), attributeOf(tag, "Target"));
	}
	const sheets = [];
	for (const tag of (workbookXml.match(/<sheet\b[^>]*\/?>/g) || [])) {
		if (sheets.length >= LIMITS.sheets) break;
		const target = relationships.get(attributeOf(tag, "r:id"));
		if (target == null) continue;
		const path = `xl/${String(target).replace(/^\/?xl\//, "").replace(/^\//, "")}`;
		const sheetXml = decode(path);
		if (sheetXml == null) continue;
		sheets.push({name: attributeOf(tag, "name") || "(名前なし)", ...parseSheet(sheetXml, sharedStrings, dateStyles)});
	}
	if (sheets.length === 0) return null;

	const bodyHtml = sheets.map((sheet) => {
		const rowsHtml = sheet.rows.map((row) => {
			const width = Math.max(row.length, 1);
			const cells = [];
			for (let i = 0; i < width; i++) cells.push(`<td>${escapeHtml(row[i] ?? "")}</td>`);
			return `<tr>${cells.join("")}</tr>`;
		}).join("");
		const note = sheet.truncated ? `<p class="note">(大きいため、先頭${LIMITS.rowsPerSheet}行・${LIMITS.columnsPerSheet}列までを表示しています)</p>` : "";
		const table = sheet.rows.length === 0
			? `<p class="note">(空のシートです)</p>`
			: `<div class="tableWrap"><table>${rowsHtml}</table></div>`;
		return `<section><h2>${escapeHtml(sheet.name)}</h2>${table}${note}</section>`;
	}).join("");

	const text = sheets.map((sheet) => `${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}`).join("\n\n");
	return {bodyHtml, text};
};

/* _/_/_/ Word _/_/_/ */

const headingLevelOf = (paragraphXml) => {
	const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(paragraphXml);
	if (style == null) return 0;
	const value = decodeEntities(style[1]);
	const match = /^(?:Heading|heading|見出し)\s*([1-6])$/.exec(value) || /^([1-6])$/.exec(value);
	return match == null ? 0 : Number(match[1]);
};

const paragraphTextOf = (paragraphXml) => {
	// 改行・タブは空白に潰す(概要表示のため、体裁は再現しない)
	const withBreaks = paragraphXml.replace(/<w:br\b[^>]*\/?>/g, " ").replace(/<w:tab\b[^>]*\/?>/g, " ");
	return textOf(withBreaks, "w:t").replace(/\s+/g, " ").trim();
};

const convertDocument = (entries) => {
	const xml = entries.has("word/document.xml") ? entries.get("word/document.xml").toString("utf8") : null;
	if (xml == null) return null;
	const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
	if (body == null) return null;

	const blocks = [];
	const textLines = [];
	let truncated = false;
	// 段落(w:p)と表(w:tbl)を、文書に現れる順で拾う
	const blockPattern = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b(?:[^>]*)(?:\/>|>[\s\S]*?<\/w:p>)/g;
	let match;
	while ((match = blockPattern.exec(body[1])) != null) {
		if (blocks.length >= LIMITS.paragraphs) {
			truncated = true;
			break;
		}
		const chunk = match[0];
		if (chunk.startsWith("<w:tbl")) {
			const rows = matchAll(chunk, "w:tr").slice(0, LIMITS.tableRows).map((row) =>
				matchAll(row, "w:tc").map((cell) => matchAll(cell, "w:p").map(paragraphTextOf).filter(Boolean).join(" "))
			);
			if (rows.length === 0) continue;
			blocks.push(`<div class="tableWrap"><table>${rows.map((row) =>
				`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table></div>`);
			for (const row of rows) textLines.push(row.join("\t"));
			continue;
		}
		const text = paragraphTextOf(chunk);
		if (text === "") continue;
		const level = headingLevelOf(chunk);
		if (level > 0) {
			blocks.push(`<h${Math.min(level + 1, 6)}>${escapeHtml(text)}</h${Math.min(level + 1, 6)}>`);
		} else if (/<w:numPr\b/.test(chunk) || /<w:pStyle\b[^>]*w:val="(?:List[A-Za-z]*|リスト[^"]*)"/.test(chunk)) {
			blocks.push(`<ul><li>${escapeHtml(text)}</li></ul>`);
		} else {
			blocks.push(`<p>${escapeHtml(text)}</p>`);
		}
		textLines.push(text);
	}
	if (blocks.length === 0) return null;
	const note = truncated ? `<p class="note">(長いため、先頭${LIMITS.paragraphs}段落までを表示しています)</p>` : "";
	// 連続する箇条書きは1つのリストにまとめる(見た目の間延びを防ぐ)
	const bodyHtml = blocks.join("").replace(/<\/ul><ul>/g, "") + note;
	return {bodyHtml, text: textLines.join("\n")};
};

/* _/_/_/ PowerPoint _/_/_/ */

const slideNumberOf = (name) => {
	const match = /(\d+)\.xml$/.exec(name);
	return match == null ? 0 : Number(match[1]);
};

const convertSlides = (entries) => {
	const slideNames = [...entries.keys()]
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((a, b) => slideNumberOf(a) - slideNumberOf(b))
		.slice(0, LIMITS.slides);
	if (slideNames.length === 0) return null;

	const sections = [];
	const textLines = [];
	slideNames.forEach((name, index) => {
		const xml = entries.get(name).toString("utf8");
		// 図形(sp)と表(graphicFrame内のa:tbl)を、スライドに現れる順で拾う。
		// タイトルのプレースホルダは見出しとして扱う
		let title = null;
		const blocks = [];
		const shapePattern = /<p:sp>[\s\S]*?<\/p:sp>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g;
		let shapeMatch;
		while ((shapeMatch = shapePattern.exec(xml)) != null) {
			const shape = shapeMatch[0];
			if (shape.startsWith("<p:graphicFrame")) {
				// 表。グラフ・SmartArt等のテキストを持たないものは空になるので読み飛ばす
				for (const table of matchAll(shape, "a:tbl")) {
					const rows = matchAll(table, "a:tr").slice(0, LIMITS.tableRows).map((row) =>
						matchAll(row, "a:tc").map((cell) =>
							matchAll(cell, "a:p").map((paragraph) => textOf(paragraph, "a:t").trim()).filter(Boolean).join(" ")));
					if (rows.some((row) => row.some(Boolean))) blocks.push({rows});
				}
				continue;
			}
			const lines = matchAll(shape, "a:p").map((paragraph) => textOf(paragraph, "a:t").trim()).filter(Boolean);
			if (lines.length === 0) continue;
			if (title == null && /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape)) {
				title = lines.join(" ");
				continue;
			}
			blocks.push({lines});
		}
		if (title == null) {
			const firstText = blocks.findIndex((block) => block.lines != null);
			if (firstText >= 0) title = blocks.splice(firstText, 1)[0].lines.join(" ");
		}

		// 発表者ノート。ノート用スライドにはスライド番号やサムネイルの枠も含まれるため、
		// 本文のプレースホルダ(ph type="body")だけを拾う(拾わないとノートが「1」等になる)
		const notesName = `ppt/notesSlides/notesSlide${slideNumberOf(name)}.xml`;
		const notes = !entries.has(notesName) ? "" : matchAll(entries.get(notesName).toString("utf8"), "p:sp")
			.filter((shape) => /<p:ph\b[^>]*type="body"/.test(shape))
			.map((shape) => matchAll(shape, "a:p").map((paragraph) => textOf(paragraph, "a:t").trim()).filter(Boolean).join(" "))
			.filter(Boolean)
			.join(" ");

		const bodyBlocks = blocks.map((block) => {
			if (block.rows != null) {
				return `<div class="tableWrap"><table>${block.rows.map((row) =>
					`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table></div>`;
			}
			return `<ul>${block.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
		}).join("");
		const notesHtml = notes === "" ? "" : `<p class="note">ノート: ${escapeHtml(notes)}</p>`;
		sections.push(`<section class="slide"><h2>${index + 1}. ${escapeHtml(title || "(タイトルなし)")}</h2>${bodyBlocks}${notesHtml}</section>`);
		const blockText = blocks.map((block) => block.rows != null
			? block.rows.map((row) => row.join("\t")).join("\n")
			: block.lines.join("\n"));
		textLines.push([title || "", ...blockText, notes].filter(Boolean).join("\n"));
	});

	return {bodyHtml: sections.join(""), text: textLines.join("\n\n")};
};

/* _/_/_/ 入口 _/_/_/ */

// 種類ごとに、読み込むZIPエントリを必要最小限に絞る(マクロ・画像・メディアは読まない)
const WANTED_ENTRIES = {
	sheet: (name) => name === "xl/workbook.xml" || name === "xl/sharedStrings.xml" || name === "xl/styles.xml"
		|| name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/[^/]+\.xml$/.test(name),
	document: (name) => name === "word/document.xml",
	slides: (name) => /^ppt\/(?:slides|notesSlides)\/[^/]+\.xml$/.test(name)
};

/**
 * Office文書から、概要プレビュー用のHTML本体と全文検索用テキストを作る。
 * @param {Buffer} buffer ファイルの中身
 * @param {string} extension 小文字の拡張子(".xlsx"等)
 * @param {{maxEntryBytes?: number, maxTotalBytes?: number}} limits 展開後サイズの上限(テスト用。通常は省略する)
 * @returns {{bodyHtml: string, text: string}|null} 読めなければ null
 */
module.exports.convertOfficeDocument = (buffer, extension, limits = {}) => {
	const kind = OFFICE_KINDS[String(extension || "").toLowerCase()];
	if (kind == null || !Buffer.isBuffer(buffer)) return null;
	try {
		const entries = readZipEntries(buffer, WANTED_ENTRIES[kind], limits);
		if (entries == null || entries.size === 0) return null;
		if (kind === "sheet") return convertWorkbook(entries);
		if (kind === "document") return convertDocument(entries);
		return convertSlides(entries);
	} catch {
		return null;
	}
};
