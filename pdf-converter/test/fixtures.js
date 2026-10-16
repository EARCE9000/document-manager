/*!
 * fixtures.js : PDF変換のテストに使うHTMLと、できたPDFの中身を確かめる道具
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * smoke.js(変換サービス単体)と test/integration-pdf.js(アプリと繋いだ結合テスト)の両方で使う。
 * PDFを読むための依存は足さない。確かめたいのは「ページ数・ページの大きさ・埋め込まれたフォント・
 * 文字として入っている字」で、どれもPDFの中を直接読めば分かる。
 */

const zlib = require("node:zlib");

const PX_PER_PT = 96 / 72;

/** PDFの各ページの大きさ(px)。Chromiumの出すPDFは MediaBox を平文で持つ */
const pageSizes = (pdf) => [...pdf.toString("latin1").matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)]
	.map((m) => ({width: Math.round(Number(m[1]) * PX_PER_PT), height: Math.round(Number(m[2]) * PX_PER_PT)}));

/** 埋め込まれたフォントの名前(サブセットの接頭辞 "ABCDEF+" は外す) */
const fontNames = (pdf) => [...new Set([...pdf.toString("latin1").matchAll(/\/BaseFont \/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map((m) => m[1]))];

/** 図形として埋め込まれたフォント(Type3)の数。多いとPDFが大きくなる */
const type3FontCount = (pdf) => (pdf.toString("latin1").match(/\/Subtype \/Type3/g) || []).length;

/**
 * PDFに「文字として」入っている字の集合。
 *
 * 文字の並びそのものは取り出さない(圧縮された描画命令を解釈する必要がある)。代わりに、
 * フォントごとの対応表(ToUnicode)を読んで「どの字が使われているか」を得る。
 * 「日本語が画像ではなく文字として入っている」「動いてはいけないスクリプトが書いた字が無い」
 * を確かめるには、これで足りる。
 */
const usedCharacters = (pdf) => {
	const latin = pdf.toString("latin1");
	const chars = new Set();
	const decode = (hex) => {
		// 対応先はUTF-16BE
		let out = "";
		for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
		return out;
	};
	for (const match of latin.matchAll(/stream\r?\n/g)) {
		const start = match.index + match[0].length;
		const end = latin.indexOf("endstream", start);
		if (end < 0) continue;
		let text;
		try {
			text = zlib.inflateSync(pdf.subarray(start, end)).toString("latin1");
		} catch {
			continue;
		}
		if (!text.includes("beginbfchar") && !text.includes("beginbfrange")) continue;
		for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
			for (const pair of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
				for (const ch of decode(pair[2])) chars.add(ch);
			}
		}
		for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
			for (const range of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
				const count = parseInt(range[2], 16) - parseInt(range[1], 16);
				const first = parseInt(range[3].slice(-4), 16);
				for (let i = 0; i <= count && i < 65536; i++) chars.add(String.fromCharCode(first + i));
			}
		}
	}
	return chars;
};

/** 指定した文字列の字が、すべて文字として入っているか(空白は除く) */
const containsAll = (chars, text) => [...text.replace(/\s/g, "")].every((ch) => chars.has(ch));

// 1x1 の PNG(中身は問わない。data: の画像は出ることの確認用)
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/yWWk2QAAAABJRU5ErkJggg==";

const page = (style, body) => `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`;

// 印刷用のCSSでは消える注記。PDFは画面用の見た目で作るので、これが入っていること
const SCREEN_ONLY_TEXT = "画面だけに出す注記";

/**
 * 凝ったレイアウトの文書(見出しの帯・カードの並び・図・表・2段組み)。
 * フォントの指定は、実際に登録されている文書に多い形にしてある。この形で、既定のフォント
 * 構成では本文がまるごと等幅フォントになった(system-ui の落ち先が決まっていなかった)。
 */
const LAYOUT = page(
	`*{box-sizing:border-box}body{margin:0;font-family:"Yu Gothic UI","Hiragino Sans","Noto Sans JP",Meiryo,system-ui,sans-serif;color:#1f2933;background:#f3f5f8}
header{position:sticky;top:0;background:linear-gradient(90deg,#1a56db,#6f9b16);color:#fff;padding:18px 32px;display:flex;gap:16px;align-items:center}
header h1{margin:0;font-size:22px}main{padding:28px 32px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.card{background:#fff;border-radius:10px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{padding:9px 12px;border-bottom:1px solid #e3e7ee;text-align:left}
.cols{column-count:2;column-gap:28px;line-height:1.8;margin-top:20px}code{font-family:Consolas,Menlo,monospace}
@media print{.screenOnly{display:none}header{position:static;background:none;color:#000}}`,
	`<header><img src="data:image/png;base64,${TINY_PNG}" width="40" height="40" alt=""><h1>月次レポート</h1></header><main>
<div class="cards"><div class="card">受注件数<b>1,284</b></div><div class="card">売上高<b>48.2M</b></div><div class="card">平均単価<b>37,540</b></div><div class="card">解約率<b>2.1%</b></div></div>
<svg viewBox="0 0 520 120" width="100%"><rect x="20" y="40" width="60" height="70" fill="#9cc2ff"/><rect x="100" y="20" width="60" height="90" fill="#6f9b16"/><text x="20" y="20" font-size="12">売上の推移</text></svg>
<table><thead><tr><th>地域</th><th>件数</th><th>状態</th></tr></thead><tbody><tr><td>東京</td><td>512</td><td>達成</td></tr><tr><td>大阪</td><td>301</td><td>未達</td></tr></tbody></table>
<div class="cols">${"今月は新規の引き合いが増え、首都圏で大口の案件が続きました。".repeat(6)}</div><p>設定は <code>compose.env</code> に書きます。</p><p class="screenOnly">${SCREEN_ONLY_TEXT}</p></main>`
);
const LAYOUT_TEXT = "月次レポート受注件数売上高平均単価解約率地域東京大阪達成未達";

/** アプリがMarkdownから作るプレビューと同じ作り。横に長い表と、1行が長いコードを持つ */
const MARKDOWN = page(
	`body{font-family:-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",Meiryo,sans-serif;max-width:800px;margin:2em auto;padding:0 1em;line-height:1.7}
pre{background:#f6f8fa;padding:1em;overflow-x:auto;border-radius:4px}.tableWrap{overflow-x:auto;max-width:100%}.tableWrap table{width:max-content}
table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.4em .8em;max-width:640px}`,
	`<h1>導入手順書</h1><p>本書は運用サーバへ導入する手順です。</p>
<pre><code>docker run --rm --network document_manager_convert --read-only --tmpfs /tmp:size=512m --security-opt no-new-privileges:true example/image:latest node -e 'console.log(1)'  # 右端の印 END_OF_LINE</code></pre>
<div class="tableWrap"><table><thead><tr>${["環境変数", "既定値", "意味", "変更が要る場面", "備考", "関連する設定", "導入した版", "右端の列"].map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody><tr>${["SESSION_MAX_AGE_HOURS", "16", "ログインの有効時間", "終業をまたいで使う運用のとき", "長くするほど、置き忘れた端末の危険が増す", "SESSION_SECRET", "20260901.1200", "ここまで見えること"].map((c) => `<td>${c}</td>`).join("")}</tr></tbody></table></div>`
);

/** 「画面いっぱい」の見出し(100vh)のあとに本文が続く。1枚に収まり、見出しは画面の高さのままであること */
const VIEWPORT_UNITS = page(
	`body{margin:0;font-family:sans-serif}.hero{height:100vh;background:#fde68a}.rest{height:400px;background:#dbeafe}`,
	`<div class="hero">画面いっぱいの見出し</div><div class="rest">続きの本文</div>`
);
const VIEWPORT_UNITS_HEIGHT = 800 + 400;

/** 高さを区切ってスクロールさせている枠。PDFでは開いて、中身が全部見えること */
const SCROLL_BOX = page(
	`body{margin:0;font-family:sans-serif}.box{height:100px;overflow-y:auto}.row{height:50px}`,
	`<div class="box">${Array.from({length: 20}, (_, i) => `<div class="row">行 ${i + 1}</div>`).join("")}</div>`
);
const SCROLL_BOX_HEIGHT = 20 * 50;

/** 1ページの上限(200インチ = 19200px)を超える長さ */
const LONG = page(
	`body{margin:0;font-family:sans-serif}section{height:500px;border-bottom:1px solid #ccc}`,
	Array.from({length: 50}, (_, i) => `<section>手順 ${i + 1}</section>`).join("")
);
const LONG_HEIGHT = 50 * 500;

/**
 * 高さに端数が出る文書(900.4px の箱のあとに1行)。内容の高さは切り捨てて伝えられるため、
 * ページの高さを内容ぴったりにすると、最後の1行がページの境目にかかって2ページ目へ回る
 * (実際の文書で、末尾の著作権表示だけが2ページ目に出た)。
 */
const FRACTIONAL = page(
	`body{margin:0;font-family:sans-serif}p{margin:0;line-height:20px}`,
	`<div style="height:900.4px"></div><p class="copyright">末尾の著作権表示</p>`
);

/**
 * してはいけないことを一通り試みる文書。見える文字にASCIIの小文字は使っていない
 * (コンテナ内のファイルが読めてしまったら、その中身の英小文字がPDFに現れる)。
 * スクリプトが動いた場合は「㊙」が書き込まれる。
 */
const HOSTILE_MARK = "㊙";
const HOSTILE = page(
	`body{font-family:sans-serif}iframe{width:100%;height:80px}`,
	`<link rel="stylesheet" href="https://cdn.example.com/style.css">
<p id="t">文書の本文</p>
<img src="https://example.com/photo.png" width="10" height="10" alt="">
<script>document.getElementById("t").textContent = "${HOSTILE_MARK}"; fetch("http://169.254.169.254/latest/meta-data/");</script>
<img src="x" onerror="document.getElementById('t').textContent='${HOSTILE_MARK}'" width="1" height="1" alt="">
<iframe src="file:///etc/passwd"></iframe>
<iframe src="http://127.0.0.1:3000/health"></iframe>
<iframe src="http://10.0.0.1/"></iframe>
<meta http-equiv="refresh" content="0;url=https://example.com/">`
);

/** 描くのに時間がかかる文書(打ち切りの確認用)。1MBの上限に収まる大きさにしてある */
const HEAVY = page(
	`i{display:block;height:3px;margin:1px;border:1px solid #333;border-radius:2px;box-shadow:0 0 2px #000,inset 0 0 1px #f00;background:linear-gradient(90deg,#fff,#eee)}`,
	"<i></i>".repeat(130000)
);

// ---- draw.io ----
// .drawio は <mxfile> の下に、ページ(<diagram>)ごとの図を持つXML
const drawioCell = (id, value, style, x, y, width, height) =>
	`<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
const drawioModel = (cells) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const drawioPage = (name, cells) => `<diagram id="${name}" name="${name}">${drawioModel(cells)}</diagram>`;
const drawioFile = (...pages) => `<mxfile>${pages.join("")}</mxfile>`;
const escapeXml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// 図の周りの余白(render.js の BORDER)。紙の大きさ = 図の右下 + 余白
const DRAWIO_BORDER = 12;

// 大きさの違う2ページ。どちらも紙が図の大きさぴったりになること、2ページ目が画面の幅(1280px)に
// 縮められないことを見る。1ページ目の抵抗は拡張図形(stencils)で、同梱が無いとただの四角に化ける
const DRAWIO_PAGES = drawioFile(
	drawioPage("構成図",
		drawioCell("a", "受付サーバー", "rounded=1;whiteSpace=wrap;html=1;", 40, 40, 160, 60)
		+ drawioCell("b", "データベース", "shape=cylinder3;whiteSpace=wrap;html=1;", 300, 40, 120, 80)
		+ drawioCell("r", "", "pointerEvents=1;html=1;shape=mxgraph.electrical.resistors.resistor_1;", 40, 160, 100, 20)),
	drawioPage("詳細", drawioCell("c", "二枚目のページ", "rounded=0;whiteSpace=wrap;html=1;", 0, 0, 1500, 900))
);
const DRAWIO_PAGES_TEXT = "受付サーバーデータベース二枚目のページ";
// 図の範囲は (40,40)-(420,180) と (0,0)-(1500,900)。紙は、その周りに余白を足した大きさ
const DRAWIO_PAGE_SIZES = [
	{width: 420 - 40 + 2 * DRAWIO_BORDER, height: 180 - 40 + 2 * DRAWIO_BORDER},
	{width: 1500 + 2 * DRAWIO_BORDER, height: 900 + 2 * DRAWIO_BORDER}
];

// ラベルにはHTMLを書ける。図に仕込まれたスクリプトは動かない(動くと HOSTILE_MARK が紙に出る)。
// 外部の画像は読み込まない
const DRAWIO_HOSTILE = drawioFile(drawioPage("p",
	drawioCell("t", "図の本文", "text;html=1;", 20, 20, 200, 30)
	+ drawioCell("x", escapeXml(`<img src="x" onerror="document.body.append('${HOSTILE_MARK}')"><script>document.body.append('${HOSTILE_MARK}')</script>`), "text;html=1;", 20, 60, 200, 30)
	+ drawioCell("i", "", "shape=image;image=https://example.com/a.png;", 20, 100, 40, 40)
));

// 紙の上限(200インチ = 19200px)を超える図は、比を保って縮めて1枚に収める
const DRAWIO_HUGE = drawioFile(drawioPage("p", drawioCell("w", "とても横に長い図", "rounded=0;whiteSpace=wrap;html=1;", 0, 0, 30000, 200)));

// 圧縮形式(base64(deflate(urlencode(XML))))のページ。古い版や Web 版の draw.io が保存する形
const DRAWIO_COMPRESSED = `<mxfile><diagram id="z" name="z">${zlib.deflateRawSync(Buffer.from(encodeURIComponent(
	drawioModel(drawioCell("c", "圧縮された図", "rounded=1;whiteSpace=wrap;html=1;", 0, 0, 200, 60))))).toString("base64")}</diagram></mxfile>`;

module.exports = {
	pageSizes, fontNames, type3FontCount, usedCharacters, containsAll,
	LAYOUT, LAYOUT_TEXT, SCREEN_ONLY_TEXT, MARKDOWN, VIEWPORT_UNITS, VIEWPORT_UNITS_HEIGHT, SCROLL_BOX, SCROLL_BOX_HEIGHT,
	LONG, LONG_HEIGHT, FRACTIONAL, HOSTILE, HOSTILE_MARK, HEAVY,
	DRAWIO_PAGES, DRAWIO_PAGES_TEXT, DRAWIO_PAGE_SIZES, DRAWIO_HOSTILE, DRAWIO_HUGE, DRAWIO_COMPRESSED
};
