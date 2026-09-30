/*!
 * upload-accept.test.js : 画面の accept と、サーバが受け入れる拡張子が一致しているか
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 対応形式を増やすときはサーバ側(app/server.js)の一覧を直すが、画面のファイル選択には
 * `accept` 属性という**別の一覧**がある。ここがずれると、次のどちらかが静かに起きる。
 *
 *   - サーバは受けるのに、ファイル選択のダイアログで**その拡張子が出てこない**
 *     (ドラッグ&ドロップなら置けるので、「たまに置けない」という分かりにくい形で出る)
 *   - 選べるのにアップロードすると400
 *
 * どちらも画面を眺めていて気づけないため、一致を機械で見る。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf-8");

/** app/server.js から `const <名前> = [ ... ];` の配列を取り出す(コメント行は落とす) */
const listOf = (source, name) => {
	const matched = source.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
	assert.ok(matched, `${name} が app/server.js に見つからない`);
	return matched[1]
		.replace(/\/\/[^\n]*/g, "")
		.match(/"\.[a-z0-9]+"/g)
		.map((quoted) => quoted.replace(/"/g, ""));
};

test("ファイル選択の accept が、サーバの受け入れ拡張子と一致している", () => {
	const server = read("app", "server.js");
	const html = read("app", "static", "index.html");

	const groups = ["NATIVE_PREVIEW_EXTENSIONS", "MHTML_EXTENSIONS", "MARKDOWN_EXTENSIONS",
		"IMAGE_EXTENSIONS", "CSV_EXTENSIONS", "PLAIN_TEXT_EXTENSIONS", "DRAWIO_EXTENSIONS"];
	const accepted = new Set(groups.flatMap((name) => listOf(server, name)));
	// Office は lib/office.js 側で持っているため、ここでは実際に受ける値を直接使う
	for (const ext of [".xlsx", ".xlsm", ".docx", ".docm", ".pptx", ".pptm"]) accepted.add(ext);

	const matched = html.match(/id="uploadfile"[^>]*accept="([^"]+)"/);
	assert.ok(matched, "画面に accept 属性が見つからない");
	const onScreen = new Set(matched[1].split(",").map((item) => item.trim()));

	const missing = [...accepted].filter((ext) => !onScreen.has(ext)).sort();
	const extra = [...onScreen].filter((ext) => !accepted.has(ext)).sort();

	assert.deepEqual(missing, [], `サーバは受けるのにファイル選択に出てこない: ${missing.join(" ")}`);
	assert.deepEqual(extra, [], `選べるのにサーバが受けない: ${extra.join(" ")}`);
});

test("対応形式のTipsが、実際に受け入れる拡張子だけを挙げている", () => {
	const server = read("app", "server.js");
	const html = read("app", "static", "index.html");

	const groups = ["NATIVE_PREVIEW_EXTENSIONS", "MHTML_EXTENSIONS", "MARKDOWN_EXTENSIONS",
		"IMAGE_EXTENSIONS", "CSV_EXTENSIONS", "PLAIN_TEXT_EXTENSIONS", "DRAWIO_EXTENSIONS"];
	const accepted = new Set(groups.flatMap((name) => listOf(server, name)));
	for (const ext of [".xlsx", ".xlsm", ".docx", ".docm", ".pptx", ".pptm"]) accepted.add(ext);

	const body = html.match(/<div id="uploadFormatsBody">([\s\S]*?)<\/div>/);
	assert.ok(body, "対応形式のTipsが見つからない");
	const listed = [...new Set((body[1].match(/\.[a-z0-9]+/g) || []))];

	// 書いてあるのに置けない、が一番困る
	const wrong = listed.filter((ext) => !accepted.has(ext)).sort();
	assert.deepEqual(wrong, [], `Tipsに載っているが受け入れない: ${wrong.join(" ")}`);

	// 逆に、受け入れるのにどこにも書いていないものも無いようにする
	const undocumented = [...accepted].filter((ext) => !listed.includes(ext)).sort();
	assert.deepEqual(undocumented, [], `受け入れるのにTipsに無い: ${undocumented.join(" ")}`);
});

// 説明が置き場所そのものを押しつぶしていた(4行の説明で埋まっていた)ので外へ出した
test("ドラッグ&ドロップ欄に、形式の説明を戻していない", () => {
	const html = read("app", "static", "index.html");
	const zone = html.match(/<div id="uploadDropZone">([\s\S]*?)<\/div>\s*<!--/);
	assert.ok(zone, "ドラッグ&ドロップ欄が見つからない");
	assert.ok(!zone[1].includes("uploadExt"), "形式の説明が置き場所の中に戻っている");
	assert.ok(!/<details/.test(zone[1]), "Tipsが置き場所の中にある(開閉のクリックでファイル選択が開いてしまう)");
});
