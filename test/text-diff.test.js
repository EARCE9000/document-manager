/*!
 * text-diff.test.js : 2 つの本文の差分(app/lib/text-diff.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 行の番号、行の中の変わった文字(日本語は文字ごと)、まるで違う行には文字の色分けをしないこと、
 * 前後の行の数、返す行の上限(clipped)を確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {diffTexts, MAX_OUTPUT_LINES} = require("../app/lib/text-diff.js");

test("同じ本文は same(改行の書き方と末尾の改行は数えない)", () => {
	assert.deepEqual(diffTexts("a\r\nb\r\n", "a\nb"), {status: "same", added: 0, removed: 0, hunks: [], clipped: false});
	assert.equal(diffTexts("", "").status, "same");
});

test("足した行・消した行と行の番号、行の中の変わった文字", () => {
	const result = diffTexts("見出し\n本文はこれです。\n終わり", "見出し\n本文はこちらです。\n足した行\n終わり");
	assert.equal(result.status, "changed");
	assert.equal(result.added, 2);
	assert.equal(result.removed, 1);
	const lines = result.hunks[0].lines;
	assert.deepEqual(lines.map((l) => [l.type, l.oldNo, l.newNo]), [["same", 1, 1], ["del", 2, null], ["add", null, 2], ["add", null, 3], ["same", 3, 4]]);
	assert.deepEqual(lines[1].segments, [{text: "本文はこ", changed: false}, {text: "れ", changed: true}, {text: "です。", changed: false}]);
	assert.deepEqual(lines[2].segments.filter((s) => s.changed).map((s) => s.text), ["ちら"]);
	// 組になる相手のいない「足した行」には、文字の色分けを付けない
	assert.equal(lines[3].segments, undefined);
});

test("まるで違う行の組には、文字の色分けを付けない", () => {
	const lines = diffTexts("あいうえお\n", "かきくけこ\n").hunks[0].lines;
	assert.deepEqual(lines.map((l) => l.type), ["del", "add"]);
	assert.equal(lines[0].segments, undefined);
	assert.equal(lines[1].segments, undefined);
});

test("前後に付ける行の数(既定 3、all で全文、上限 50)", () => {
	const base = Array.from({length: 100}, (_, i) => `行${i + 1}`);
	const changed = [...base];
	changed[49] = "行50(直した)";
	const count = (context) => diffTexts(base.join("\n"), changed.join("\n"), {context}).hunks.flatMap((h) => h.lines).length;
	assert.equal(count(undefined), 3 + 2 + 3);
	assert.equal(count(0), 2);
	assert.equal(count("all"), 101);
	assert.equal(count(1000), 50 + 2 + 49);
});

test("返す行が多すぎるときは途中までにして clipped を立てる(数は全体で数える)", () => {
	const before = Array.from({length: MAX_OUTPUT_LINES + 500}, (_, i) => `old ${i}`).join("\n");
	const after = Array.from({length: MAX_OUTPUT_LINES + 500}, (_, i) => (i % 2 === 0 ? `new ${i}` : `old ${i}`)).join("\n");
	const result = diffTexts(before, after);
	assert.equal(result.clipped, true);
	assert.equal(result.hunks.flatMap((h) => h.lines).length, MAX_OUTPUT_LINES);
	assert.equal(result.added, Math.ceil((MAX_OUTPUT_LINES + 500) / 2));
});
