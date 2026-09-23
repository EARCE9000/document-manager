/*!
 * deploy.test.js : 運用構成(deploy/compose.yml)のうち、安全に関わる設定を守るテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 変換サービス(converter)はLibreOfficeで「信用できないファイルを開く」ため、被害を
 * ネットワーク構成で封じ込めている。ここが崩れると、細工された文書に外部への通信や
 * 他サービスへの到達を許してしまう(SSRF)。設定は目に見えないうえ変更も容易なため、
 * 意図が失われないようテストで固定する。
 *
 * YAMLパーサは依存に無いため、インデントを見る簡易な読み取りで必要な箇所だけを取り出す。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const composeText = fs.readFileSync(path.join(__dirname, "..", "deploy", "compose.yml"), "utf-8");
const lines = composeText.split(/\r?\n/);

/** 指定した見出し(例: "services:" 直下の "  converter:")配下の行を、インデントが戻るまで返す */
const blockOf = (headingPattern) => {
	const start = lines.findIndex((line) => headingPattern.test(line));
	if (start < 0) return [];
	const indent = lines[start].search(/\S/);
	const block = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (line.search(/\S/) <= indent) break;
		block.push(line);
	}
	return block;
};

/** ブロック内の "networks:" に列挙されたネットワーク名(リスト記法・マッピング記法の両方) */
const networksOf = (block) => {
	const start = block.findIndex((line) => /^\s*networks:\s*$/.test(line));
	if (start < 0) return [];
	const indent = block[start].search(/\S/);
	const names = [];
	for (let i = start + 1; i < block.length; i++) {
		const line = block[i];
		if (line.search(/\S/) <= indent) break;
		const listItem = /^\s*-\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
		const mapItem = /^\s{6}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (listItem) names.push(listItem[1]);
		else if (mapItem) names.push(mapItem[1]);
	}
	return names;
};

test("compose: converterは変換専用ネットワークにしか参加しない", () => {
	const converter = blockOf(/^ {2}converter:\s*$/);
	assert.ok(converter.length > 0, "converterサービスが定義されている");
	assert.deepEqual(networksOf(converter), ["document_manager_convert"],
		"Weaviate等が居るネットワークに参加していない(細工された文書から到達させない)");
});

test("compose: 変換専用ネットワークは外部へ出られない(internal)", () => {
	const networks = blockOf(/^networks:\s*$/);
	const start = networks.findIndex((line) => /^\s*document_manager_convert:\s*$/.test(line));
	assert.ok(start >= 0, "document_manager_convert が定義されている");
	assert.match(networks[start + 1] || "", /internal:\s*true/,
		"internal: true が無いと、LibreOfficeが外部URLを取りに行けてしまう");
});

test("compose: アプリはconverterと通信できる", () => {
	const app = blockOf(/^ {2}app:\s*$/);
	assert.ok(networksOf(app).includes("document_manager_convert"), "アプリは変換専用ネットワークに参加する");
});

test("compose: converterは書き込み不可・権限昇格不可で動かす", () => {
	const converter = blockOf(/^ {2}converter:\s*$/).join("\n");
	assert.match(converter, /read_only:\s*true/, "ファイルシステムは読み取り専用");
	assert.match(converter, /no-new-privileges:true/, "権限昇格を禁止する");
	assert.match(converter, /tmpfs:/, "作業場所はメモリ上の一時領域にする");
	assert.doesNotMatch(converter, /^\s*volumes:/m, "ホストのディレクトリを渡さない");
	assert.doesNotMatch(converter, /^\s*ports:/m, "ホストにポートを公開しない");
});
