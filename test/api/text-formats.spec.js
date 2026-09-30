/*!
 * text-formats.spec.js : プレーンテキストとして扱う形式
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 設定(.yaml/.xml/.toml…)・字幕(.srt/.vtt)・文書記法(.rst/.adoc/.tex)・テキストで書く図
 * (.mmd/.puml/.dot/.bpmn)・手順のスクリプト(.sh/.ps1) を受け入れている。
 *
 * どれも**変換せずそのまま出す**ので、確かめることは3つだけ。
 *
 *   1. 受け付けること(拡張子の一覧から漏れていないか)
 *   2. **text/plain で返すこと**。ここが崩れると、.xml や .sh がブラウザに解釈される。
 *      特に .xml は application/xml で返すとXSLTの処理命令でスクリプトが動く余地がある
 *   3. 中身が全文検索に載ること(置けるのに探せないのでは意味がない)
 *
 * 鍵・証明書は意図的に受け付けていない。これは「入れ忘れ」ではなく判断なので、
 * 弾いていること自体をテストで固定する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const STAMP = Date.now();

// 拡張子 → その形式らしい中身(検索で引ける目印を必ず1つ入れる)
const SAMPLES = {
	".yaml": "services:\n  app:\n    image: example\n",
	".yml": "version: 2\n",
	".xml": '<?xml version="1.0"?><root><item>設定の控え</item></root>',
	".sql": "SELECT id, name FROM documents WHERE deleted_at IS NULL;",
	".ini": "[section]\nkey = value\n",
	".conf": "listen 8080;\n",
	".cfg": "[main]\nmode = production\n",
	".properties": "app.name=example\n",
	".toml": '[tool]\nname = "example"\n',
	".jsonl": '{"a":1}\n{"a":2}\n',
	".ndjson": '{"b":1}\n',
	".srt": "1\n00:00:01,000 --> 00:00:03,000\n本日の議題です\n",
	".vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n本日の議題です\n",
	".rst": "見出し\n======\n\n本文です。\n",
	".adoc": "= 見出し\n\n本文です。\n",
	".asciidoc": "= 見出し\n",
	".tex": "\\section{見出し}\n本文です。\n",
	".mmd": "graph TD;\n  A-->B;\n",
	".mermaid": "sequenceDiagram\n  A->>B: 依頼\n",
	".puml": "@startuml\nA -> B\n@enduml\n",
	".plantuml": "@startuml\n@enduml\n",
	".pu": "@startuml\n@enduml\n",
	".dot": "digraph G { A -> B; }",
	".gv": "graph G { A -- B; }",
	".bpmn": '<?xml version="1.0"?><definitions><process id="p"/></definitions>',
	".excalidraw": '{"type":"excalidraw","elements":[]}',
	".sh": "#!/usr/bin/env bash\nset -euo pipefail\napt-get update\n",
	".ps1": "Set-StrictMode -Version Latest\nWrite-Output 'ok'\n"
};

const upload = (request, name, body) => request.post("api/documents", {
	headers: rw,
	multipart: {uploadfile: {name, mimeType: "application/octet-stream", buffer: Buffer.from(body, "utf-8")}}
});

test.describe("プレーンテキストとして扱う形式", () => {
	for (const [ext, body] of Object.entries(SAMPLES)) {
		test(`${ext} を受け付けて、text/plain で返す`, async ({request}) => {
			const name = `見本${STAMP}${ext}`;
			const res = await upload(request, name, body);
			expect(res.status(), `${ext} が受け付けられていない`).toBe(200);
			const doc = await res.json();

			// 変換はしない。元のファイルがそのままプレビューになる
			expect(doc.previewFile, `${ext} がプレビュー不可になっている`).toBe(name);

			const served = await request.get(`api/documents/${doc.id}/file`, {headers: ro});
			expect(served.status()).toBe(200);
			expect(served.headers()["content-type"], `${ext} がブラウザに解釈される型で返っている`)
				.toContain("text/plain");
			expect(await served.text()).toBe(body);
		});
	}

	// 置けるのに探せないのでは意味がない
	test("中身が全文検索に載る", async ({request}) => {
		const marker = `よこはま${STAMP}`;
		await upload(request, `検索用${STAMP}.yaml`, `memo: ${marker}\n`);
		await upload(request, `検索用${STAMP}.srt`, `1\n00:00:01,000 --> 00:00:02,000\n${marker}\n`);

		const found = await (await request.get(`api/documents?q=${encodeURIComponent(marker)}`, {headers: ro})).json();
		const names = found.map((d) => d.entryFile);
		expect(names).toContain(`検索用${STAMP}.yaml`);
		expect(names, "字幕の中身が検索に載っていない").toContain(`検索用${STAMP}.srt`);
	});

	// .xml をブラウザに解釈させると、XSLTの処理命令でスクリプトが動く余地がある
	test("XMLに仕掛けを入れても、文字として返るだけ", async ({request}) => {
		const evil = '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="evil.xsl"?><root/>';
		const doc = await (await upload(request, `仕掛け${STAMP}.xml`, evil)).json();
		const served = await request.get(`api/documents/${doc.id}/file`, {headers: ro});
		expect(served.headers()["content-type"]).toContain("text/plain");
		expect(served.headers()["content-type"]).not.toContain("xml");
		expect(await served.text()).toBe(evil);
	});

	// 入れ忘れではなく判断なので、弾いていること自体を固定する
	test("鍵・証明書は受け付けない", async ({request}) => {
		for (const ext of [".env", ".pem", ".key", ".p12", ".crt", ".pfx"]) {
			const res = await upload(request, `秘密${STAMP}${ext}`, "SECRET=1");
			expect(res.status(), `${ext} が置けてしまう`).toBe(400);
		}
	});

	// スクリプトは「読むためのもの」。実行できる形で返さない
	test("スクリプトはダウンロードでも添付扱いになる", async ({request}) => {
		const doc = await (await upload(request, `手順${STAMP}.sh`, "#!/bin/sh\necho ok\n")).json();
		const downloaded = await request.get(`api/documents/${doc.id}/file?download`, {headers: ro});
		expect(downloaded.headers()["content-disposition"]).toContain("attachment");
	});
});
