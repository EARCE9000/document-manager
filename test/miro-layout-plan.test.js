/*!
 * miro-layout-plan.test.js : 型ごとの並べ方(app/lib/miro-layout-plan.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * どの型でも、全部の資料を 1 回ずつ、枠の中に、重ならずに置くこと。型ごとの区画の並び(左右・上下)と、
 * 「ほか n 件」の中身の段・中心の概要カード・「無し」のマスを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Plan = require("../app/lib/miro-layout-plan.js");
const Layout = require("../app/lib/miro-layout.js");

const geometry = {itemWidth: 360, gapX: 60, gapY: 60, captionHeight: 80, padding: 80, headerHeight: 70, defaultAspect: 297 / 210};
const CARD_HEIGHT = 360 * 297 / 210;

let seq = 0;
const doc = (entryFile, extra = {}) => ({
	documentId: `d-${++seq}`, entryFile, modified: "2026-10-10T03:00:00.000Z", tags: [], folderNames: [], topFolder: null, subFolders: [], ...extra
});

// 十字型・マトリクス型・棚型のどれにも当てはまる資料を混ぜる(未分類・ほか n 件も出るように)
const mixed = () => {
	const design = {id: "f-design", name: "設計"};
	return [
		...Array.from({length: 6}, (_, i) => doc(`要件定義 ${i}.md`, {tags: ["機能:認証"]})),
		doc("基本設計書.md", {tags: ["工程:基本設計", "機能:認証", "段階:準備"], topFolder: design, folderNames: ["設計"]}),
		doc("画面設計.md", {tags: ["機能:検索"], topFolder: design, subFolders: ["画面"], folderNames: ["画面", "設計"]}),
		doc("結合テスト仕様 2026-09-20.md", {tags: ["機能:検索", "段階:実施"]}),
		doc("リリース手順.md", {tags: ["段階:実施後"]}),
		...Array.from({length: 11}, (_, i) => doc(`課題一覧 ${i}.md`)),
		doc("定例 2026-10-05.md"),
		doc("定例 2026-10-15.md"),
		doc("打合せ 2026-10-18.md"),
		doc("メモ.txt"),
		doc("写真.png")
	];
};

// 見出しの分も含めた、カードの上端と下端
const span = (item, sizes) => {
	const height = sizes.get(item.documentId)?.height ?? CARD_HEIGHT;
	return {top: item.y - height / 2, bottom: item.y + height / 2 + geometry.captionHeight};
};
const overlaps = (a, b, sizes) => {
	const sa = span(a, sizes);
	const sb = span(b, sizes);
	return Math.abs(a.x - b.x) < 360 && sa.top < sb.bottom - 1 && sb.top < sa.bottom - 1;
};

for (const layout of Layout.LAYOUT_IDS) {
	test(`${layout}: 全部の資料を 1 回ずつ、枠の中に、重ならずに置く(縦長の資料があっても)`, () => {
		const documents = mixed();
		// 縦長の画像(A4 縦の 2.5 倍)と横長の画像を混ぜる
		const sizes = new Map(documents.filter((_, i) => i % 5 === 0).map((d) => [d.documentId, {width: 360, height: 1300}]));
		for (const d of documents.filter((_, i) => i % 7 === 3)) sizes.set(d.documentId, {width: 360, height: 200});
		const plan = Plan.buildPlan(layout, {project: {id: "p", name: "試し"}, documents, featureOrder: []}, {geometry, sizes, projectUrl: "https://dm.example/?project=p"});
		const ids = plan.items.map((i) => i.documentId);
		assert.equal(new Set(ids).size, ids.length, "同じ資料を 2 回置いている");
		assert.deepEqual([...ids].sort(), documents.map((d) => d.documentId).sort(), "置いていない資料がある");
		for (const item of plan.items) {
			assert.ok(item.x - 180 >= 0 && item.x + 180 <= plan.frame.width, `${item.documentId} が枠の横にはみ出す`);
			const {top, bottom} = span(item, sizes);
			assert.ok(top >= 0 && bottom <= plan.frame.height, `${item.documentId} が枠の下にはみ出す`);
		}
		for (let i = 0; i < plan.items.length; i++) {
			for (let j = i + 1; j < plan.items.length; j++) {
				assert.ok(!overlaps(plan.items[i], plan.items[j], sizes), `${plan.items[i].documentId} と ${plan.items[j].documentId} が重なる`);
			}
		}
		for (const s of plan.shapes) {
			assert.ok(s.x + s.width / 2 <= plan.frame.width + 1 && s.y + s.height / 2 <= plan.frame.height + 1, "図形が枠からはみ出す");
		}
	});
}

const planOf = (layout, documents) => Plan.buildPlan(layout, {project: {id: "p", name: "試し"}, documents, featureOrder: []}, {geometry, projectUrl: "https://dm.example/?project=p"});
const itemOf = (plan, d) => plan.items.find((i) => i.documentId === d.documentId);

test("フォルダ列型: 一番上のフォルダごとの列が左から並び、「その他」列は右端。下の階層は ▼ の小見出し", () => {
	const a = doc("a.md", {topFolder: {id: "f1", name: "要件"}});
	const b = doc("b.md", {topFolder: {id: "f2", name: "設計"}, subFolders: ["画面"]});
	const loose = doc("c.md");
	const plan = planOf("folder-columns", [loose, a, b]);
	assert.ok(itemOf(plan, a).x < itemOf(plan, b).x);
	assert.ok(itemOf(plan, b).x < itemOf(plan, loose).x);
	assert.ok(plan.labels.some((l) => l.text === "▼ 画面"));
	assert.ok(plan.labels.some((l) => l.text === "■ その他"));
	assert.ok(plan.items.every((i) => i.color === null));
});

test("時系列型: 上が古い月。月の中は 7 枚で折り返し、区分・工程の色を付ける", () => {
	const docs = Array.from({length: 8}, (_, i) => doc(`設計 2026-07-${String(i + 1).padStart(2, "0")}.md`, {tags: ["工程:基本設計"]}));
	const later = doc("定例 2026-09-04.md");
	const plan = planOf("timeline", [later, ...docs]);
	assert.ok(itemOf(plan, docs[7]).y > itemOf(plan, docs[0]).y, "8 枚目は次の段へ折り返す");
	assert.equal(itemOf(plan, docs[7]).x, itemOf(plan, docs[0]).x);
	assert.ok(itemOf(plan, later).y > itemOf(plan, docs[7]).y);
	assert.equal(itemOf(plan, docs[0]).color, Plan.COLORS.purple);
	assert.equal(itemOf(plan, later).color, Plan.COLORS.green);
	// 資料の無い 8 月も行として残す
	assert.ok(plan.labels.some((l) => l.text === "2026-08"));
});

test("十字型: 左上・左下・右上・右下に分け、入りきらない分は「ほか n 件」の段へ。中心に概要カード", () => {
	const documents = mixed();
	const plan = planOf("quadrant-cross", documents);
	const req = itemOf(plan, documents[0]);
	const test2 = itemOf(plan, documents.find((d) => d.entryFile.startsWith("結合テスト")));
	const issue = itemOf(plan, documents.find((d) => d.entryFile.startsWith("課題一覧 0")));
	const meeting = itemOf(plan, documents.find((d) => d.entryFile.startsWith("定例 2026-10-05")));
	assert.ok(req.x < issue.x && req.y < test2.y, "左上と左下・右上");
	assert.ok(meeting.x > test2.x && meeting.y > issue.y, "右下");
	assert.ok(plan.shapes.some((s) => s.text === "ほか 3 件" && s.link === "https://dm.example/?project=p"), "要件定義の段の「ほか n 件」");
	assert.ok(plan.shapes.some((s) => s.text === "ほか 3 件"), "右上の「ほか n 件」");
	assert.ok(plan.labels.some((l) => l.text === "工程:要件定義 のほか 3 件"));
	assert.ok(plan.labels.some((l) => l.text === "右上: 管理系 のほか 3 件"));
	const centre = plan.labels.find((l) => l.text.startsWith("試し / 資料"));
	assert.equal(centre.link, "https://dm.example/?project=p");
	// 中の資料は、ほかの区画より下(枠の下の段)
	const hidden = itemOf(plan, documents[5]);
	assert.ok(hidden.y > meeting.y);
});

test("マトリクス型: 資料の無いマスに「無し」、対象外のマスは灰色。表の下に 管理 → 会議 → 未分類", () => {
	const a = doc("認証の要件.md", {tags: ["機能:認証", "工程:要件定義", "対象外:基本設計"]});
	const b = doc("検索の設計.md", {tags: ["機能:検索", "工程:基本設計"]});
	const plan = planOf("matrix", [a, b, doc("WBS.md"), doc("定例 10月7日.md"), doc("メモ.md")]);
	assert.equal(plan.shapes.filter((s) => s.text === "無し").length, 1);
	assert.equal(plan.shapes.filter((s) => s.text === "対象外").length, 1);
	const titles = plan.labels.map((l) => l.text);
	assert.ok(titles.indexOf("管理") < titles.indexOf("会議") && titles.indexOf("会議") < titles.indexOf("未分類"));
});
