/*!
 * miro-layout.test.js : Miro に十字で書き出すときの振り分け(app/lib/miro-layout.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 仕様は docs/miro-layouts/layout-spec.md。タグの読み方・推定・日付の取り方と、十字の 4 つの区画への振り分け
 * (報告 layout-report の中身)を確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Layout = require("../app/lib/miro-layout.js");

let seq = 0;
const doc = (entryFile, extra = {}) => ({
	documentId: `d-${++seq}`, entryFile, modified: "2026-10-10T03:00:00.000Z", tags: [], folderNames: [], topFolder: null, subFolders: [], ...extra
});
const report = (documents) => Layout.buildCrossReport({project: {id: "p1", name: "試し"}, documents});
const placementOf = (r, d) => r.placements.find((p) => p.documentId === d.documentId);

test("タグは : の前を見出し・後ろを値として読み、共通の見出しでないタグは見ない", () => {
	const {values, unknown} = Layout.readTags(["区分:管理", "工程：基本設計", "重要", "段階:実施2回目", "工程:設計"]);
	assert.deepEqual(values["区分"], ["管理"]);
	assert.deepEqual(values["工程"], ["基本設計"]);
	assert.deepEqual(values["段階"], ["実施 2 回目"]);
	assert.deepEqual(unknown, [{tag: "工程:設計", heading: "工程", value: "設計"}]);
});

test("付けたタグは推定より勝つ。同じ見出しが 2 つあれば表の順で最初の 1 つを使い、報告に出す", () => {
	const c = Layout.classify(doc("会議の議事録.md", {tags: ["工程:詳細設計", "工程:基本設計"]}));
	assert.equal(c.values["工程"].value, "基本設計");
	assert.equal(c.values["工程"].basis, "tag");
	// 工程のタグがあるので、題名の「会議」から 区分:会議 は推定しない
	assert.equal(c.values["区分"], undefined);
	assert.deepEqual(c.duplicates, [{heading: "工程", used: "工程:基本設計", ignored: ["工程:詳細設計"]}]);
});

test("タグが無ければ、題名 → フォルダ名の言葉から推定する(全角・空白・大文字小文字は区別しない)", () => {
	assert.equal(Layout.classify(doc("ＡＰＩ一覧.pdf")).values["工程"].value, "詳細設計");
	assert.equal(Layout.classify(doc("DB 設計.pdf")).values["工程"].value, "詳細設計");
	assert.equal(Layout.classify(doc("顧客一覧.pdf", {folderNames: ["受入テスト"]})).values["工程"].source, "folder");
	const meeting = Layout.classify(doc("10月定例.md"));
	assert.equal(meeting.values["区分"].value, "会議");
	assert.equal(meeting.values["会議"].value, "定例");
	assert.equal(Layout.classify(doc("mtg メモ.md")).values["会議"].value, "臨時");
	// 段階・機能は推定しない
	const plain = Layout.classify(doc("準備の手順.md"));
	assert.equal(plain.values["段階"], undefined);
	assert.equal(plain.values["機能"], undefined);
});

test("表に無い値のタグしか無い見出しは推定しない。近い値の候補を出す", () => {
	const c = Layout.classify(doc("要件メモ.md", {tags: ["工程:設計"]}));
	assert.equal(c.values["工程"], undefined);
	assert.deepEqual(Layout.candidatesFor("工程", "設計").sort(), ["工程:基本設計", "工程:詳細設計"].sort());
	assert.deepEqual(Layout.candidatesFor("工程", "UAT"), ["工程:受入テスト"]);
});

test("会議: のタグだけでも会議とみなし、区分:会議 だけなら臨時", () => {
	assert.equal(Layout.classify(doc("a.md", {tags: ["会議:定例"]})).values["区分"].value, "会議");
	const adhoc = Layout.classify(doc("a.md", {tags: ["区分:会議"]}));
	assert.equal(adhoc.values["会議"].value, "臨時");
	assert.equal(adhoc.values["会議"].basis, "default");
});

test("日付は題名の最初の日付。年の無いものは登録日の年を補い、登録日より後なら前の年にする", () => {
	const base = "2026-10-10";
	assert.equal(Layout.findDate("定例 2026/09/04 議事録", base), "2026-09-04");
	assert.equal(Layout.findDate("20260704_計画", base), "2026-07-04");
	assert.equal(Layout.findDate("2026年8月1日 打合せ", base), "2026-08-01");
	assert.equal(Layout.findDate("定例 10/07", base), "2026-10-07");
	assert.equal(Layout.findDate("定例 12月24日", base), "2025-12-24");
	assert.equal(Layout.findDate("v1.2 設計", base), null);
	assert.equal(Layout.findDate("2026-13-01", base), null);
	// 題名に無ければ初版の登録日(版を上げても変わらない)
	assert.deepEqual(Layout.documentDate(doc("設計.md", {modified: "2026-10-10T03:00:00.000Z", firstUploaded: "2026-08-03T03:00:00.000Z"})), {date: "2026-08-03", dateSource: "first_upload"});
	// 年の無い日付は初版の登録日の年を補う
	assert.deepEqual(Layout.documentDate(doc("定例 12月24日.md", {modified: "2027-01-10T03:00:00.000Z", firstUploaded: "2026-12-25T03:00:00.000Z"})), {date: "2026-12-24", dateSource: "title"});
});

test("十字: 工程で左上・左下、管理は右上、会議は右下(日付順)。どれにも当たらなければ未分類", () => {
	const docs = [
		doc("基本設計書.md", {tags: ["工程:基本設計"]}),
		doc("実装メモ.md", {tags: ["工程:実装"]}),
		doc("運用手順.md", {tags: ["工程:運用"]}),
		doc("定例 2026-10-15.md", {tags: ["区分:会議", "会議:定例"]}),
		doc("打合せ 2026-10-01.md"),
		doc("計画書.md", {tags: ["区分:管理", "工程:基本設計"]}),
		doc("メモ.md", {tags: ["工程:設計"]}),
		doc("ばらばら.md"),
		doc("要件定義書.md")
	];
	const r = report(docs);
	assert.equal(r.layout, "cross");
	assert.deepEqual(r.summary.areas, {upper_left: 3, upper_right: 1, lower_left: 1, lower_right: 2, unclassified: 2});
	// 左上は工程の順(要件定義 → 基本設計 → 詳細設計)。実装は詳細設計の段
	assert.deepEqual(r.placements.filter((p) => p.area === "upper_left").map((p) => p.documentId), [docs[8].documentId, docs[0].documentId, docs[1].documentId]);
	assert.equal(placementOf(r, docs[1]).step, "詳細設計");
	assert.equal(placementOf(r, docs[2]).area, "lower_left");
	// 右下は日付順。題名の「打合せ」から会議と推定する
	assert.deepEqual(r.placements.filter((p) => p.area === "lower_right").map((p) => p.documentId), [docs[4].documentId, docs[3].documentId]);
	assert.equal(placementOf(r, docs[4]).basis, "inferred");
	assert.deepEqual(r.unclassified.map((u) => u.reason), ["unknown_value", "no_process_tag"]);
	assert.deepEqual(r.unknownValues[0].candidates.sort(), ["工程:基本設計", "工程:詳細設計"].sort());
	assert.deepEqual(r.overriddenTags, [{documentId: docs[5].documentId, title: "計画書", used: "区分:管理", ignored: ["工程:基本設計"]}]);
	assert.equal(r.summary.unclassifiedRatio, 0.22);
	assert.equal(r.summary.reviewRecommended, false);
	assert.equal(r.areaTitles.upper_left, "要件定義〜設計");
});

test("未分類が多ければ、書き出す前のタグの見直しを勧める", () => {
	const r = report([doc("a.md"), doc("b.md"), doc("要件定義書.md")]);
	assert.equal(r.summary.unclassifiedRatio, 0.67);
	assert.equal(r.summary.reviewRecommended, true);
});

test("タグ体系に登録する共通の値(機能: は入れない)", () => {
	const tags = Layout.commonTags();
	assert.equal(tags[0], "区分:管理");
	assert.ok(tags.includes("工程:受入テスト"));
	assert.ok(tags.includes("会議:臨時"));
	assert.ok(!tags.some((t) => t.startsWith("機能:")));
});
