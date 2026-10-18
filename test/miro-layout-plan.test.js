/*!
 * miro-layout-plan.test.js : 書き出すフレームの形と置き場所(app/lib/miro-layout-plan.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 目印を基準にした向き(右・左・上・下・斜め・十字)で、フレームを目印にもほかのものにも重ねずに置くこと、
 * フレームの中は向きにかかわらず読む順で、資料が重ならずにフレームに収まることを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Plan = require("../app/lib/miro-layout-plan.js");

const G = {itemWidth: 360, gapX: 60, gapY: 60, captionHeight: 80, padding: 80, defaultAspect: 297 / 210, anchorGap: 120, frameGap: 200};
const A4 = 360 * 297 / 210;
const ANCHOR = {left: 1000, top: 1000, right: 1200, bottom: 1200};

let seq = 0;
const doc = (entryFile, extra = {}) => ({
	documentId: `d-${++seq}`, entryFile, modified: "2026-10-10T03:00:00.000Z", tags: [], folderNames: [], topFolder: null, subFolders: [], ...extra
});
const sized = (documents, height = A4) => documents.map((d) => ({documentId: d.documentId, height}));
const boxOf = (frame) => ({left: frame.left, top: frame.top, right: frame.left + frame.width, bottom: frame.top + frame.height});
const plan = (groups, extra = {}) => Plan.planExport({groups, anchor: ANCHOR, obstacles: [], input: {project: {id: "p", name: "試し"}, documents: []}, geometry: G, ...extra});

test("向きの書き方を読む(付箋のかっこ・「右側」「右へ」・矢印・英語)。読めなければ null", () => {
	const cases = {
		"(右側)": "right", "（右へ）": "right", "→": "right", "左": "left", "上方向": "up", "↓": "down",
		"右上": "upper-right", "(左下に)": "lower-left", "↖": "upper-left", "十字": "cross", "lower-right": "lower-right", "UP": "up"
	};
	for (const [text, expected] of Object.entries(cases)) assert.equal(Plan.parseDirection(text), expected, text);
	for (const text of ["ななめ", "", "右左", "(真ん中)"]) assert.equal(Plan.parseDirection(text), null, text);
});

test("フレームの中は読む順で並べ、行の上の端をそろえる。横は 8 枚、上下は 3 枚、斜めは正方形に近く折り返す", () => {
	assert.equal(Plan.columnsFor("right", 20), 8);
	assert.equal(Plan.columnsFor("left", 3), 3);
	assert.equal(Plan.columnsFor("down", 20), 3);
	assert.equal(Plan.columnsFor("upper-right", 9), 3);
	assert.equal(Plan.columnsFor("lower-left", 10), 4);
	const docs = Array.from({length: 5}, (_, i) => doc(`${i}.pdf`));
	const sizes = sized(docs).map((d, i) => (i === 1 ? {...d, height: 900} : d));
	const frame = Plan.planFrame("down", sizes, G);
	assert.deepEqual(frame.items.map((i) => i.documentId), docs.map((d) => d.documentId));
	// 1 行目: 3 枚(上の端が 80)。2 行目は 1 行目のいちばん高い資料の下から
	for (const [index, item] of frame.items.slice(0, 3).entries()) {
		assert.equal(item.x, 80 + index * 420 + 180);
		assert.ok(Math.abs(item.y - sizes[index].height / 2 - 80) < 1e-6);
	}
	assert.ok(Math.abs(frame.items[3].y - A4 / 2 - (80 + 900 + 80 + 60)) < 1e-6);
	assert.equal(frame.width, 80 * 2 + 3 * 360 + 2 * 60);
	const bottom = Math.max(...frame.items.map((item, i) => item.y + sizes[i].height / 2 + 80));
	assert.ok(bottom <= frame.height - 80 + 1);
});

test("8 つの向き: 目印の横・上下・斜めの方へ置き、目印とは重ねない。横は上の端、上下は左の端を目印にそろえる", () => {
	const docs = sized([doc("a.pdf"), doc("b.pdf")]);
	const at = (direction) => boxOf(plan([{direction, title: "t", documents: docs}]).frames[0]);
	assert.equal(at("right").left, ANCHOR.right + 120);
	assert.equal(at("right").top, ANCHOR.top);
	assert.equal(at("left").right, ANCHOR.left - 120);
	assert.equal(at("left").top, ANCHOR.top);
	assert.equal(at("down").top, ANCHOR.bottom + 120);
	assert.equal(at("down").left, ANCHOR.left);
	assert.equal(at("up").bottom, ANCHOR.top - 120);
	// 斜めの 1 つ目は、付箋を真ん中にしたマスの横(右上・右下は右、左上・左下は左)。高さは付箋の真ん中にそろう
	const centerOf = (b) => ({x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2});
	const frame = Plan.planFrame("upper-right", docs, G);
	assert.deepEqual(centerOf(at("upper-right")), {x: 1100 + frame.width + 120, y: 1100});
	assert.deepEqual(centerOf(at("lower-left")), {x: 1100 - frame.width - 120, y: 1100});
	for (const direction of ["right", "left", "up", "down", "upper-right", "lower-right", "upper-left", "lower-left"]) {
		const box = at(direction);
		assert.ok(!(box.left < ANCHOR.right && ANCHOR.left < box.right && box.top < ANCHOR.bottom && ANCHOR.top < box.bottom), `${direction} が目印に重なる`);
	}
});

test("ほかのもの(フレーム・付箋)と重なるときは、向きの外側へずらす。同じ向きの組を続けると、前の組の外側に出す", () => {
	const docs = sized([doc("a.pdf")]);
	const obstacle = {left: 1300, top: 900, right: 2500, bottom: 2000};
	const moved = boxOf(plan([{direction: "right", title: "t", documents: docs}], {obstacles: [obstacle]}).frames[0]);
	assert.equal(moved.left, obstacle.right + 200);
	assert.equal(moved.top, ANCHOR.top);
	const down = boxOf(plan([{direction: "down", title: "t", documents: docs}], {obstacles: [{left: 900, top: 1300, right: 1500, bottom: 1800}]}).frames[0]);
	assert.equal(down.top, 1800 + 200);
	const twice = plan([{direction: "right", title: "1", documents: docs}, {direction: "right", title: "2", documents: sized([doc("b.pdf")])}]).frames.map(boxOf);
	assert.ok(twice[1].left >= twice[0].right + 200);
	// 斜めは、ふさがっているマスを飛ばして、輪の順で次のマスへ(左上の 1 つ目は左。ふさがっていれば上)
	const leftCell = {left: 0, top: 900, right: 900, bottom: 1300};
	const diagonal = boxOf(plan([{direction: "upper-left", title: "t", documents: docs}], {obstacles: [leftCell]}).frames[0]);
	assert.ok(diagonal.bottom <= ANCHOR.top, "上のマスに置く");
	assert.equal((diagonal.left + diagonal.right) / 2, 1100);
});

test("目印が無いとき(free): 向きの形のまま、まとめて空いている所(ボードの中身の右)へ出す", () => {
	const result = Plan.planExport({
		groups: [{direction: "left", title: "a", documents: sized([doc("a.pdf")])}, {direction: "down", title: "b", documents: sized([doc("b.pdf")])}],
		anchor: null, free: {left: 5000, top: -300}, obstacles: [{left: 0, top: 0, right: 4800, bottom: 4000}], input: {documents: []}, geometry: G
	});
	const boxes = result.frames.map(boxOf);
	assert.equal(Math.min(...boxes.map((b) => b.left)), 5000);
	assert.equal(Math.min(...boxes.map((b) => b.top)), -300);
	assert.ok(!(boxes[0].left < boxes[1].right && boxes[1].left < boxes[0].right && boxes[0].top < boxes[1].bottom && boxes[1].top < boxes[0].bottom));
});

test("十字: タグで 4 つに分け、目印の斜め 4 つのフレームに出す。目印の下に概要カード、未分類はその下。区画ごとに見出しの色", () => {
	const docs = [
		doc("要件定義書.pdf", {tags: ["工程:要件定義"]}),
		doc("結合テスト.pdf", {tags: ["工程:結合テスト"]}),
		doc("計画書.pdf", {tags: ["区分:管理"]}),
		doc("定例 2026-10-05.pdf", {tags: ["会議:定例"]}),
		doc("臨時 2026-10-07.pdf", {tags: ["会議:臨時"]}),
		doc("ばらばら.pdf")
	];
	const result = Plan.planExport({
		groups: [{direction: "cross", title: "定例", documents: sized(docs)}], anchor: ANCHOR, obstacles: [],
		input: {project: {id: "p", name: "受注管理", description: "作り直し"}, documents: docs}, geometry: G
	});
	const byArea = Object.fromEntries(result.frames.map((f) => [f.area, f]));
	assert.deepEqual(Object.keys(byArea).sort(), ["lower_left", "lower_right", "unclassified", "upper_left", "upper_right"]);
	assert.equal(byArea.upper_left.title, "定例 / 要件定義〜設計");
	assert.equal(byArea.upper_left.direction, "upper-left");
	const box = (area) => boxOf(byArea[area]);
	assert.ok(box("upper_left").right <= ANCHOR.left && box("upper_left").bottom <= ANCHOR.top);
	assert.ok(box("upper_right").left >= ANCHOR.right && box("upper_right").bottom <= ANCHOR.top);
	assert.ok(box("lower_left").right <= ANCHOR.left && box("lower_left").top >= ANCHOR.bottom);
	assert.ok(box("lower_right").left >= ANCHOR.right && box("lower_right").top >= ANCHOR.bottom);
	assert.ok(box("unclassified").top >= Math.max(box("lower_left").bottom, box("lower_right").bottom));
	// 概要カードは目印のすぐ下(真ん中)。下の 2 つのフレームはその下から
	assert.equal(result.cards.length, 1);
	const card = result.cards[0];
	assert.equal(card.x, (ANCHOR.left + ANCHOR.right) / 2);
	assert.equal(card.text, "受注管理\n作り直し\n資料 6 件 / 最終更新 2026-10-10");
	assert.ok(card.y - card.height / 2 >= ANCHOR.bottom);
	assert.ok(box("lower_left").top >= card.y + card.height / 2);
	// 区画ごとの見出しの色(会議は定例と臨時で分ける)
	assert.equal(byArea.upper_right.items[0].color, Plan.COLORS.gray);
	assert.deepEqual(byArea.lower_right.items.map((i) => i.color), [Plan.COLORS.green, Plan.COLORS.orange]);
	assert.equal(byArea.unclassified.items[0].color, null);
	assert.equal(result.reports.length, 1);
});

test("十字: ぶつかるものがあれば、目印のまわりのまとまり(4 つのフレームと概要カード)ごと右へずらす", () => {
	const docs = [doc("要件定義書.pdf", {tags: ["工程:要件定義"]}), doc("計画書.pdf", {tags: ["区分:管理"]})];
	const input = {project: {id: "p", name: "p"}, documents: docs};
	const first = Plan.planExport({groups: [{direction: "cross", title: "1", documents: sized(docs)}], anchor: ANCHOR, obstacles: [], input, geometry: G});
	const obstacles = first.frames.map(boxOf);
	const second = Plan.planExport({groups: [{direction: "cross", title: "2", documents: sized(docs)}], anchor: ANCHOR, obstacles, input, geometry: G});
	for (const frame of second.frames.map(boxOf)) {
		for (const old of obstacles) assert.ok(!(frame.left < old.right && old.left < frame.right && frame.top < old.bottom && old.top < frame.bottom));
	}
	const dx = second.frames[0].left - first.frames[0].left;
	assert.ok(dx > 0);
	assert.equal(second.cards[0].x - first.cards[0].x, dx);
	assert.equal(second.frames[0].top, first.frames[0].top);
});

test("概要カードの文字: 説明があれば 3 行(100 文字で切って …)、無ければ 1 行", () => {
	assert.equal(Plan.summaryText({name: "P"}, 3, "2026-10-01"), "P / 資料 3 件 / 最終更新 2026-10-01");
	const long = "あ".repeat(120);
	assert.equal(Plan.summaryText({name: "P", description: long}, 1, ""), `P\n${"あ".repeat(100)}…\n資料 1 件`);
	assert.equal(Plan.summaryText({name: "P", description: "  改行\nあり  "}, 2, ""), "P\n改行 あり\n資料 2 件");
});

test("斜め: 付箋のまわりを輪を広げるように埋める(右上なら 右 → 上 → 右上 → 右右 → 右右上 → 上上 …)。右下・左上・左下は向きを変えただけ", () => {
	assert.deepEqual(Plan.ringCells(2), [[1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
	const sized1 = () => sized([doc("a.pdf")]);
	const frame = Plan.planFrame("upper-right", sized1(), G);
	const stepX = frame.width + 120;
	const stepY = frame.height + 120;
	const cellOf = (b, sx, sy) => [Math.round(((b.left + b.right) / 2 - 1100) / stepX) * sx + 0, Math.round(((b.top + b.bottom) / 2 - 1100) / stepY) * sy + 0];
	for (const [direction, sx, sy] of [["upper-right", 1, -1], ["lower-right", 1, 1], ["upper-left", -1, -1], ["lower-left", -1, 1]]) {
		// 同じ目印に 5 回続けて書き出す(前のフレームはボードにあるもの)
		const groups = Array.from({length: 5}, (_, i) => ({direction, title: String(i), documents: sized1()}));
		const cells = plan(groups).frames.map((f) => cellOf(boxOf(f), sx, sy));
		assert.deepEqual(cells, [[1, 0], [0, 1], [1, 1], [2, 0], [2, 1]], direction);
	}
});
