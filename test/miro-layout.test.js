/*!
 * miro-layout.test.js : Miro に並べる型の振り分け(app/lib/miro-layout.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 仕様は docs/miro-layouts/layout-spec.md。タグの読み方・推定・日付の取り方と、型ごとの区画の振り分け
 * (報告 layout-report の中身)を確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Layout = require("../app/lib/miro-layout.js");

let seq = 0;
const doc = (entryFile, extra = {}) => ({
	documentId: `d-${++seq}`, entryFile, modified: "2026-10-10T03:00:00.000Z", tags: [], folderNames: [], topFolder: null, subFolders: [], ...extra
});
const report = (layout, documents, extra = {}) => Layout.buildReport(layout, {project: {id: "p1", name: "試し"}, documents, ...extra});
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
	// 題名に無ければ最新版の登録日
	assert.deepEqual(Layout.documentDate(doc("設計.md", {modified: "2026-10-10T03:00:00.000Z"})), {date: "2026-10-10", dateSource: "upload"});
});

test("フォルダ列型: 一番上のフォルダごとの列、下の階層は小見出し、フォルダに入っていない資料は右端の「その他」列", () => {
	const loose = doc("メモ.md");
	const req = doc("要件.md", {topFolder: {id: "f1", name: "要件"}, folderNames: ["要件"]});
	const sub = doc("画面.md", {topFolder: {id: "f2", name: "設計"}, subFolders: ["画面"], folderNames: ["画面", "設計"]});
	const r = report("folder-columns", [loose, req, sub]);
	assert.deepEqual(Object.keys(r.summary.areas), ["要件", "設計", "その他"]);
	assert.equal(placementOf(r, sub).slot, "画面");
	assert.equal(placementOf(r, loose).area, "その他");
	assert.deepEqual(r.notes.map((n) => n.kind), ["no_folder"]);
	assert.equal(r.summary.unclassified, 1);
	assert.equal(r.summary.reviewRecommended, false);
	assert.equal(r.unclassified, undefined);
});

test("時系列型: 1 か月 = 1 行で資料の無い月も残し、月の中は日付順。色は区分・工程で付ける", () => {
	const a = doc("計画書 2026-07-10.md");
	const b = doc("要件定義書 2026-07-03.md");
	const c = doc("結合テスト仕様 2026-10-06.md");
	const d = doc("定例 2026-09-04.md");
	const r = report("timeline", [a, b, c, d]);
	assert.deepEqual(Object.keys(r.summary.areas), ["2026-07", "2026-08", "2026-09", "2026-10"]);
	assert.equal(r.summary.areas["2026-08"], 0);
	assert.deepEqual(r.placements.map((p) => p.documentId), [b.documentId, a.documentId, d.documentId, c.documentId]);
	assert.equal(placementOf(r, a).color, "gray");
	assert.equal(placementOf(r, b).color, "purple");
	assert.equal(placementOf(r, c).color, "pink");
	assert.equal(placementOf(r, d).color, "green");
});

test("棚型: 管理は左、段階ごとの棚(準備 → 実施 n 回目 → 実施後)、段階の無い会議は会議の棚、それ以外は未分類", () => {
	const plan = doc("体制図.md", {tags: ["区分:管理", "段階:準備"]});
	const second = doc("作業記録.md", {tags: ["段階:実施 2 回目"]});
	const first = doc("当日の進行表.md", {tags: ["段階:実施1回目"]});
	const prep = doc("手順書.md", {tags: ["段階:準備"]});
	const meet = doc("打合せ 10月16日.md");
	const lost = doc("メモ.md");
	const r = report("split-shelves", [plan, second, first, prep, meet, lost]);
	assert.equal(placementOf(r, plan).area, "left");
	assert.deepEqual(r.shelves, ["準備", "実施 1 回目", "実施 2 回目"]);
	assert.equal(placementOf(r, meet).area, "meeting");
	assert.equal(placementOf(r, meet).basis, "inferred");
	assert.deepEqual(r.unclassified, [{documentId: lost.documentId, title: "メモ", reason: "no_phase_tag"}]);
	assert.deepEqual(r.overriddenTags, [{documentId: plan.documentId, title: "体制図", used: "区分:管理", ignored: ["段階:準備"]}]);
	assert.equal(r.summary.unclassifiedRatio, 0.17);
});

test("十字型: 工程で左上・左下、管理は右上、会議は右下(週 × 曜日)。上の区画は「ほか n 件」にまとめる", () => {
	const docs = [
		doc("基本設計書.md", {tags: ["工程:基本設計"]}),
		doc("実装メモ.md", {tags: ["工程:実装"]}),
		doc("運用手順.md", {tags: ["工程:運用"]}),
		doc("定例 2026-10-15.md", {tags: ["区分:会議", "会議:定例"]}),
		doc("メモ.md", {tags: ["工程:設計"]}),
		...Array.from({length: 5}, (_, i) => doc(`要件定義 ${i}.md`))
	];
	const r = report("quadrant-cross", docs);
	assert.equal(r.summary.areas.upper_left, 7);
	assert.equal(r.summary.areas.lower_left, 1);
	assert.equal(r.summary.areas.lower_right, 1);
	assert.equal(placementOf(r, docs[1]).step, "詳細設計");
	assert.equal(placementOf(r, docs[2]).area, "lower_left");
	const meeting = placementOf(r, docs[3]);
	assert.equal(meeting.week, "2026-10-12");
	assert.equal(meeting.weekday, "木");
	assert.deepEqual(r.unclassified.map((u) => u.reason), ["unknown_value"]);
	assert.deepEqual(r.unknownValues[0].candidates.sort(), ["工程:基本設計", "工程:詳細設計"].sort());
	// 要件定義の段は 4 枚まで: 3 枚を出し、残りの 2 枚を「ほか 2 件」に
	assert.deepEqual(r.overflow, [{area: "upper_left", slot: "工程:要件定義", count: 2, documentIds: [docs[8].documentId, docs[9].documentId]}]);
	assert.deepEqual(r.weeks, ["2026-10-12"]);
});

test("マトリクス型: 行 = 機能、列 = 資料のある工程。無いマスは gaps、対象外は除く。1 マス 2 枚まで", () => {
	const docs = [
		doc("認証の要件.md", {tags: ["機能:認証", "工程:要件定義"]}),
		doc("認証の基本設計.md", {tags: ["機能:認証", "工程:基本設計", "対象外:運用"]}),
		doc("検索の要件.md", {tags: ["機能:検索", "工程:要件定義"]}),
		doc("検索の運用.md", {tags: ["機能:検索", "工程:運用"]}),
		doc("版管理 1.md", {tags: ["機能:資料管理", "工程:詳細設計"]}),
		doc("版管理 2.md", {tags: ["機能:資料管理", "工程:詳細設計"]}),
		doc("版管理 3.md", {tags: ["機能:資料管理", "工程:詳細設計"]}),
		doc("WBS.md"),
		doc("ばらばら.md", {tags: ["工程:基本設計"]})
	];
	const r = report("matrix", docs, {featureOrder: ["検索"]});
	assert.deepEqual(r.features, ["検索", "認証", "資料管理"]);
	assert.deepEqual(r.processes, ["要件定義", "基本設計", "詳細設計", "運用"]);
	assert.deepEqual(r.excludedCells, [{feature: "認証", process: "運用"}]);
	assert.ok(r.gaps.some((g) => g.feature === "認証" && g.process === "詳細設計"));
	assert.ok(!r.gaps.some((g) => g.feature === "認証" && g.process === "運用"));
	assert.equal(placementOf(r, docs[7]).area, "management");
	assert.deepEqual(r.unclassified.map((u) => u.reason), ["no_feature_tag"]);
	assert.deepEqual(r.overflow, [{area: "table", slot: "機能:資料管理 × 工程:詳細設計", count: 2, documentIds: [docs[5].documentId, docs[6].documentId]}]);
});

test("知らない型は断る", () => {
	assert.throws(() => report("kanban", []), /型は/);
});

test("タグ体系に登録する共通の値(機能: は入れない)", () => {
	const tags = Layout.commonTags();
	assert.equal(tags[0], "区分:管理");
	assert.ok(tags.includes("工程:受入テスト"));
	assert.ok(tags.includes("会議:臨時"));
	assert.ok(!tags.some((t) => t.startsWith("機能:")));
});
