/*!
 * smoke.js : 変換サービス(converter)の結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 起動済みのコンテナに対して、実際のOfficeファイル(test/fixtures/office/)を投げて確かめる。
 * CIとローカルの両方で使う。所要時間も出すので、サーバー選定・タイムアウト調整の材料になる。
 *
 * 上限・タイムアウトの検証は、小さい値で起動したもう1つのインスタンスに対して行う
 * (既定値は50MB・120秒で、そのまま試すには時間もデータ量も大きすぎるため)。
 *
 * 実行:
 *   docker run -d --name dm-converter -p 3010:3000 --tmpfs /tmp dm-converter:local
 *   docker run -d --name dm-converter-limits -p 3011:3000 --tmpfs /tmp  *     -e CONVERT_MAX_BYTES=1048576 -e CONVERT_TIMEOUT_SECONDS=2 dm-converter:local
 *   node converter/test/smoke.js
 *     (CONVERTER_URL / CONVERTER_LIMITS_URL で接続先を変えられる。
 *      CONVERTER_LIMITS_URL を指定しない場合、上限まわりの検証は飛ばす)
 */

const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.CONVERTER_URL || "http://127.0.0.1:3010";
// 小さい上限・短いタイムアウトで起動したインスタンス(省略可)
const LIMITS_URL = process.env.CONVERTER_LIMITS_URL || "";
const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "office");

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "  ok   " : "  FAIL "}${message}`);
	if (!condition) failures++;
};

const convert = async (extension, buffer, documentId = "202609_test", baseUrl = BASE_URL) => {
	const started = Date.now();
	const res = await fetch(new URL("/convert", baseUrl), {
		method: "POST",
		headers: {
			"Content-Type": "application/octet-stream",
			"X-Extension": extension,
			"X-Document-Id": documentId
		},
		body: buffer
	});
	const body = Buffer.from(await res.arrayBuffer());
	return {status: res.status, body, ms: Date.now() - started, contentType: res.headers.get("content-type")};
};

const main = async () => {
	console.log("[health]");
	const health = await (await fetch(new URL("/health", BASE_URL))).json();
	check(health.status === "ok", `稼働している (apiVersion ${health.apiVersion})`);
	check(typeof health.libreOffice === "string" && health.libreOffice.length > 0, `LibreOfficeを起動できる (${health.libreOffice})`);

	console.log("[変換]");
	for (const name of ["sample.xlsx", "sample.docx", "sample.pptx"]) {
		const input = fs.readFileSync(path.join(FIXTURES, name));
		const result = await convert(path.extname(name), input);
		check(result.status === 200, `${name}: 200が返る`);
		check(result.contentType === "application/pdf", `${name}: application/pdf で返る`);
		check(result.body.subarray(0, 4).toString("latin1") === "%PDF", `${name}: PDFとして始まる`);
		console.log(`         ${name}: ${(input.length / 1024).toFixed(0)}KB → ${(result.body.length / 1024).toFixed(0)}KB / ${(result.ms / 1000).toFixed(1)}秒`);
	}

	// 2回目以降は起動済みの資源を使い回せるか(初回だけ遅いのか、毎回遅いのかを見る)
	const again = await convert(".pptx", fs.readFileSync(path.join(FIXTURES, "sample.pptx")));
	console.log(`         sample.pptx(2回目): ${(again.ms / 1000).toFixed(1)}秒`);

	console.log("[異常系]");
	const unsupported = await convert(".txt", Buffer.from("text"));
	check(unsupported.status === 400, "対応していない拡張子は400");
	// マクロ付きは受け付けない(中身が正しいxlsxでも、拡張子で拒否する)
	const macro = await convert(".xlsm", fs.readFileSync(path.join(FIXTURES, "sample.xlsx")));
	check(macro.status === 400, "マクロ付きの拡張子は400");
	check(/マクロ/.test(macro.body.toString("utf-8")), "マクロを理由に拒否したと分かる");
	const broken = await convert(".docx", Buffer.from("this is not a docx"));
	check(broken.status >= 400, `壊れたファイルはエラーになる (${broken.status})`);
	const stillAlive = await (await fetch(new URL("/health", BASE_URL))).json();
	check(stillAlive.status === "ok", "異常系のあとも稼働し続ける");

	if (LIMITS_URL === "") {
		console.log("[上限・タイムアウト] CONVERTER_LIMITS_URL が未設定のため省略");
	} else {
		console.log("[上限・タイムアウト]");
		const limits = await (await fetch(new URL("/health", LIMITS_URL))).json();
		check(limits.maxBytes > 0 && limits.timeoutSeconds > 0,
			`設定した上限が効いている (${(limits.maxBytes / 1024 / 1024).toFixed(0)}MB / ${limits.timeoutSeconds}秒)`);

		// 上限を超える送信は413。中身を読み込む前に止まるので、実ファイルである必要はない
		const tooLarge = Buffer.alloc(limits.maxBytes + 1024, 0x50);
		const over = await convert(".xlsx", tooLarge, "202609_limit", LIMITS_URL);
		check(over.status === 413, `上限を超えたファイルは413 (${over.status})`);

		// 時間のかかる文書はタイムアウトで打ち切る(sofficeを確実に殺し、次の変換は通る)
		const heavy = fs.readFileSync(path.join(FIXTURES, "large.xlsx"));
		const timedOut = await convert(".xlsx", heavy, "202609_timeout", LIMITS_URL);
		check(timedOut.status === 504, `打ち切り時間を超えた変換は504 (${timedOut.status} / ${(timedOut.ms / 1000).toFixed(1)}秒)`);

		const afterTimeout = await convert(".pptx", fs.readFileSync(path.join(FIXTURES, "sample.pptx")), "202609_after", LIMITS_URL);
		check(afterTimeout.status === 200, "タイムアウトのあとも次の変換ができる(プロセスが残っていない)");
	}

	console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
