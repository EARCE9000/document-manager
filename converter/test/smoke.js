/*!
 * smoke.js : 変換サービス(converter)の結合テスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 起動済みのコンテナに対して、実際のOfficeファイル(test/fixtures/office/)を投げて確かめる。
 * CIとローカルの両方で使う。所要時間も出すので、サーバー選定・タイムアウト調整の材料になる。
 *
 * 実行:
 *   docker run -d --name dm-converter -p 3010:3000 --tmpfs /tmp dm-converter:local
 *   node converter/test/smoke.js            (CONVERTER_URL で接続先を変えられる)
 */

const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.CONVERTER_URL || "http://127.0.0.1:3010";
const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "office");

let failures = 0;
const check = (condition, message) => {
	console.log(`${condition ? "  ok   " : "  FAIL "}${message}`);
	if (!condition) failures++;
};

const convert = async (filename, buffer) => {
	const started = Date.now();
	const res = await fetch(new URL("/convert", BASE_URL), {
		method: "POST",
		headers: {"Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(filename)},
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
		const result = await convert(name, input);
		check(result.status === 200, `${name}: 200が返る`);
		check(result.contentType === "application/pdf", `${name}: application/pdf で返る`);
		check(result.body.subarray(0, 4).toString("latin1") === "%PDF", `${name}: PDFとして始まる`);
		console.log(`         ${name}: ${(input.length / 1024).toFixed(0)}KB → ${(result.body.length / 1024).toFixed(0)}KB / ${(result.ms / 1000).toFixed(1)}秒`);
	}

	// 2回目以降は起動済みの資源を使い回せるか(初回だけ遅いのか、毎回遅いのかを見る)
	const again = await convert("sample.pptx", fs.readFileSync(path.join(FIXTURES, "sample.pptx")));
	console.log(`         sample.pptx(2回目): ${(again.ms / 1000).toFixed(1)}秒`);

	console.log("[異常系]");
	const unsupported = await convert("memo.txt", Buffer.from("text"));
	check(unsupported.status === 400, "対応していない拡張子は400");
	const broken = await convert("broken.docx", Buffer.from("this is not a docx"));
	check(broken.status >= 400, `壊れたファイルはエラーになる (${broken.status})`);
	const stillAlive = await (await fetch(new URL("/health", BASE_URL))).json();
	check(stillAlive.status === "ok", "異常系のあとも稼働し続ける");

	console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
