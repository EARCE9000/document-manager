/*!
 * smoke.js : HTML→PDF変換サービス(pdf-converter)の結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 起動済みのコンテナに対してHTMLを投げ、できたPDFの中身まで確かめる。CIとローカルの両方で使う。
 * 「PDFが返った」だけでは足りない。このサービスの価値は「崩れない・欠けない・動かさない」に
 * あるので、ページ数・ページの大きさ・埋め込まれたフォント・文字として入っている字を見る。
 *
 * 実行(運用と同じ絞り方で立てること。ここで動かないものは運用でも動かない):
 *   docker build -f pdf-converter/Dockerfile -t dm-pdf-converter:local .
 *   docker run -d --name dm-pdf-converter -p 127.0.0.1:3012:3000 --tmpfs /tmp:rw,size=512m \
 *     --read-only --security-opt no-new-privileges:true --cap-drop ALL dm-pdf-converter:local
 *   docker run -d --name dm-pdf-converter-limits -p 127.0.0.1:3013:3000 --tmpfs /tmp:rw,size=512m \
 *     --read-only -e CONVERT_MAX_BYTES=1048576 -e CONVERT_TIMEOUT_SECONDS=1 dm-pdf-converter:local
 *   PDF_CONVERTER_LIMITS_URL=http://127.0.0.1:3013 PDF_CONVERTER_CONTAINER=dm-pdf-converter \
 *     node pdf-converter/test/smoke.js
 *
 *   PDF_CONVERTER_URL         接続先(既定 http://127.0.0.1:3012)
 *   PDF_CONVERTER_LIMITS_URL  小さい上限・短い打ち切りで起動したインスタンス(省略すると、その検証を飛ばす)
 *   PDF_CONVERTER_CONTAINER   コンテナ名(指定すると、変換後にChromiumが残っていないことも確かめる)
 */

const {execFileSync} = require("node:child_process");
const F = require("./fixtures.js");

const BASE_URL = process.env.PDF_CONVERTER_URL || "http://127.0.0.1:3012";
const LIMITS_URL = process.env.PDF_CONVERTER_LIMITS_URL || "";
const CONTAINER = process.env.PDF_CONVERTER_CONTAINER || "";
const CONTAINER_CLI = process.env.CONTAINER_CLI || "docker";

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "  ok   " : "  FAIL "}${message}`);
	if (!condition) failures++;
};

const convert = async (html, baseUrl = BASE_URL) => {
	const started = Date.now();
	const res = await fetch(new URL("/convert", baseUrl), {
		method: "POST",
		headers: {"Content-Type": "text/html; charset=utf-8", "X-Document-Id": "202610_smoke"},
		body: Buffer.isBuffer(html) ? html : Buffer.from(html, "utf-8")
	});
	const body = Buffer.from(await res.arrayBuffer());
	return {
		status: res.status, body, ms: Date.now() - started,
		contentType: res.headers.get("content-type"),
		blocked: Number(res.headers.get("x-blocked-requests") || 0)
	};
};

/** コンテナの中で動いているChromiumの数(終了済みで後始末待ちのものも数える) */
const chromiumProcesses = () => {
	const out = execFileSync(CONTAINER_CLI, ["exec", CONTAINER, "sh", "-c",
		"n=0; for p in /proc/[0-9]*; do case \"$(cat $p/comm 2>/dev/null)\" in chromium*|headless*) n=$((n+1));; esac; done; echo $n"
	], {encoding: "utf-8"});
	return Number(out.trim());
};

const main = async () => {
	console.log("[health]");
	const health = await (await fetch(new URL("/health", BASE_URL))).json();
	check(health.status === "ok", `稼働している (apiVersion ${health.apiVersion})`);
	check(typeof health.chromium === "string" && /\d+\./.test(health.chromium), `Chromiumを起動できる (${health.chromium})`);
	check(health.viewportWidth === 1280, `画面として描く幅は1280px (${health.viewportWidth})`);

	console.log("[レイアウト]");
	const layout = await convert(F.LAYOUT);
	check(layout.status === 200 && layout.contentType === "application/pdf", "200 / application/pdf で返る");
	check(layout.body.subarray(0, 4).toString("latin1") === "%PDF", "PDFとして始まる");
	const layoutPages = F.pageSizes(layout.body);
	check(layoutPages.length === 1, `1枚のページに収まる (${layoutPages.length}ページ)`);
	check(layoutPages[0]?.width === 1280, `幅は画面と同じ1280px (${layoutPages[0]?.width})`);
	check(layoutPages[0]?.height > 300 && layoutPages[0]?.height < 1500, `高さは内容なり (${layoutPages[0]?.height}px)`);
	check(layout.blocked === 0, "data: の画像は読み込みを断られない");
	console.log(`         ${(Buffer.byteLength(F.LAYOUT) / 1024).toFixed(0)}KB → ${(layout.body.length / 1024).toFixed(0)}KB / ${(layout.ms / 1000).toFixed(2)}秒`);

	console.log("[文字とフォント]");
	const layoutChars = F.usedCharacters(layout.body);
	check(F.containsAll(layoutChars, F.LAYOUT_TEXT), "日本語が画像ではなく文字として入っている(検索・コピーできる)");
	// 印刷用のCSS(@media print)は使わない。使うと、画面で見ていたものと配置や中身が変わる
	check(F.containsAll(layoutChars, F.SCREEN_ONLY_TEXT), "画面用の見た目で描いている(印刷用のCSSで消える部分も入る)");
	const layoutFonts = F.fontNames(layout.body);
	// 文書の指定は "Yu Gothic UI",…,system-ui,sans-serif。どれもコンテナに無いので、落ち先が問われる
	check(layoutFonts.some((name) => name.startsWith("BIZUDPGothic")), `本文は BIZ UDPゴシック で描かれる (${layoutFonts.join(", ")})`);
	check(layoutFonts.some((name) => name.startsWith("LiberationMono")), "コードは等幅フォントで描かれる");
	// 落ち先が決まっていないと、本文がまるごと等幅になる。等幅で描かれた字が本文の字を含まないこと、
	// までは追えないため、図形として埋め込まれたフォント(BIZ UD に無い字の控え)が増えていないことで見る
	check(F.type3FontCount(layout.body) === 0, `図形として埋め込まれたフォントが無い(PDFが膨らまない) (${F.type3FontCount(layout.body)})`);

	console.log("[横に長い表・コード]");
	const markdown = await convert(F.MARKDOWN);
	const markdownPages = F.pageSizes(markdown.body);
	check(markdownPages.length === 1, `1枚のページに収まる (${markdownPages.length}ページ)`);
	check(markdownPages[0]?.width > 1280, `ページを右へ広げて、はみ出す分を入れている (幅 ${markdownPages[0]?.width}px)`);
	const markdownChars = F.usedCharacters(markdown.body);
	check(F.containsAll(markdownChars, "右端の列ここまで見えること"), "表の右端の列まで文字が入っている");
	// こちらの指定は …,Meiryo,sans-serif(system-ui を含まない)。落ち先は総称の sans-serif で、
	// 決めておかないと太字の日本語だけが別のフォントになり、図形として埋め込まれる
	const markdownFonts = F.fontNames(markdown.body);
	check(markdownFonts.includes("BIZUDPGothic-Bold") && F.type3FontCount(markdown.body) === 0,
		`見出し(太字)も BIZ UDPゴシック で描かれる (${markdownFonts.join(", ")} / 図形 ${F.type3FontCount(markdown.body)})`);

	console.log("[画面いっぱいの指定(vh)]");
	const viewport = await convert(F.VIEWPORT_UNITS);
	const viewportPages = F.pageSizes(viewport.body);
	check(viewportPages.length === 1, `続きが2ページ目へ押し出されない (${viewportPages.length}ページ)`);
	check(Math.abs((viewportPages[0]?.height ?? 0) - F.VIEWPORT_UNITS_HEIGHT) <= 4,
		`見出しは画面の高さのまま (高さ ${viewportPages[0]?.height}px / 期待 ${F.VIEWPORT_UNITS_HEIGHT}px)`);

	console.log("[スクロールする枠]");
	const scrollBox = await convert(F.SCROLL_BOX);
	const scrollPages = F.pageSizes(scrollBox.body);
	check(scrollPages.length === 1 && Math.abs(scrollPages[0].height - F.SCROLL_BOX_HEIGHT) <= 4,
		`枠を開いて、中身を全部見せる (高さ ${scrollPages[0]?.height}px / 期待 ${F.SCROLL_BOX_HEIGHT}px)`);

	console.log("[端数の高さ]");
	const fractional = await convert(F.FRACTIONAL);
	check(F.pageSizes(fractional.body).length === 1, `最後の1行だけが2ページ目へ回らない (${F.pageSizes(fractional.body).length}ページ)`);

	console.log("[とても長い文書]");
	const long = await convert(F.LONG);
	const longPages = F.pageSizes(long.body);
	check(longPages.length === Math.ceil(F.LONG_HEIGHT / 19200), `上限を超えた分は次のページへ続く (${longPages.length}ページ)`);
	check(longPages.every((size) => size.height <= 19200), `どのページも200インチ(19200px)以内 (${longPages.map((size) => size.height).join(", ")})`);

	console.log("[してはいけないこと]");
	const hostile = await convert(F.HOSTILE);
	check(hostile.status === 200, "危ない書き方の文書でも変換できる");
	const hostileChars = F.usedCharacters(hostile.body);
	check(F.containsAll(hostileChars, "文書の本文"), "本文はそのまま出る");
	check(!hostileChars.has(F.HOSTILE_MARK), "スクリプト(<script>・onerror)は動かない");
	check(![...hostileChars].some((ch) => /[a-z]/.test(ch)), "コンテナ内のファイル・内部の宛先の中身がPDFに出ていない");
	check(hostile.blocked >= 3, `外部・内部への読み込みを断っている (${hostile.blocked}件)`);
	check(F.pageSizes(hostile.body).length === 1, "別のページへ飛ばされない(meta refresh)");

	console.log("[異常系]");
	const empty = await convert(Buffer.alloc(0));
	check(empty.status === 400, `空の本体は400 (${empty.status})`);
	const notFound = await fetch(new URL("/nothing", BASE_URL));
	check(notFound.status === 404, "知らないパスは404");
	const notHtml = await convert(Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x00]));
	check(notHtml.status === 200 || notHtml.status >= 400, `HTMLでないものを渡しても落ちない (${notHtml.status})`);
	const stillAlive = await (await fetch(new URL("/health", BASE_URL))).json();
	check(stillAlive.status === "ok", "異常系のあとも稼働し続ける");

	if (CONTAINER === "") {
		console.log("[後始末] PDF_CONVERTER_CONTAINER が未設定のため省略");
	} else {
		console.log("[後始末]");
		// 親だけ止めると描画用の子プロセスが残り、変換のたびにメモリを持ち続ける
		const remaining = chromiumProcesses();
		check(remaining === 0, `変換のあとにChromiumが残っていない (${remaining}個)`);
	}

	if (LIMITS_URL === "") {
		console.log("[上限・タイムアウト] PDF_CONVERTER_LIMITS_URL が未設定のため省略");
	} else {
		console.log("[上限・タイムアウト]");
		const limits = await (await fetch(new URL("/health", LIMITS_URL))).json();
		check(limits.maxBytes > 0 && limits.timeoutSeconds > 0,
			`設定した上限が効いている (${(limits.maxBytes / 1024 / 1024).toFixed(0)}MB / ${limits.timeoutSeconds}秒)`);
		const over = await convert(Buffer.alloc(limits.maxBytes + 1024, 0x20), LIMITS_URL);
		check(over.status === 413, `上限を超えた文書は413 (${over.status})`);
		const timedOut = await convert(F.HEAVY, LIMITS_URL);
		check(timedOut.status === 504, `打ち切り時間を超えた変換は504 (${timedOut.status} / ${(timedOut.ms / 1000).toFixed(1)}秒)`);
		const afterTimeout = await convert(F.VIEWPORT_UNITS, LIMITS_URL);
		check(afterTimeout.status === 200, "タイムアウトのあとも次の変換ができる");
	}

	console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
