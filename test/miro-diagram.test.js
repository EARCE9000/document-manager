/*!
 * miro-diagram.test.js : Miro に描くフロー図の指示の検めと並べ方(app/lib/miro-diagram.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * AI が渡す「箱と線の一覧」を検め(正しくないところは理由の一覧)、線をたどった段数で箱を並べること、
 * レーン(担当ごとの帯)・流れの向き(右・下)・戻る線(ループ)・段数の指定で、箱が重ならずにフレームに収まることを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Diagram = require("../app/lib/miro-diagram.js");

const overlaps = (a, b) => a.x - a.width / 2 < b.x + b.width / 2 && b.x - b.width / 2 < a.x + a.width / 2
	&& a.y - a.height / 2 < b.y + b.height / 2 && b.y - b.height / 2 < a.y + a.height / 2;
const layout = (spec) => {
	const {errors, diagram} = Diagram.normalizeDiagram(spec);
	assert.deepEqual(errors, []);
	return Diagram.layoutDiagram(diagram);
};
const assertTidy = (result) => {
	for (let i = 0; i < result.nodes.length; i++) {
		const n = result.nodes[i];
		// フレームの中に収まる
		assert.ok(n.x - n.width / 2 >= 0 && n.y - n.height / 2 >= 0 && n.x + n.width / 2 <= result.width && n.y + n.height / 2 <= result.height, `${n.key} がフレームからはみ出す`);
		for (let j = i + 1; j < result.nodes.length; j++) assert.ok(!overlaps(n, result.nodes[j]), `${n.key} と ${result.nodes[j].key} が重なる`);
	}
};

test("指示を検める: 正しくないところは、場所つきの理由の一覧で返す", () => {
	const {errors, diagram} = Diagram.normalizeDiagram({
		flow: "斜め",
		lanes: [{key: "a", title: "営業"}, {key: "a", title: "重複"}],
		nodes: [{key: "x", text: "受注", type: "なにか", lane: "a"}, {key: "x", text: "", lane: "z"}, {key: "y", text: "出荷", color: "red"}],
		edges: [{from: "x", to: "nai"}, {from: "y", to: "y"}, {from: "x", to: "y", line: "zigzag", arrow: "up"}]
	});
	assert.equal(diagram, null);
	const has = (part) => assert.ok(errors.some((e) => e.includes(part)), `${part} の理由が無い: ${errors.join(" | ")}`);
	has("diagram.flow");
	has("diagram.lanes[1].key「a」が 2 回");
	has("diagram.nodes[0].type");
	has("diagram.nodes[1].key「x」が 2 回");
	has("diagram.nodes[1].text が要ります");
	has("diagram.nodes[1].lane「z」は lanes にありません");
	has("diagram.nodes[2].lane が要ります");
	has("diagram.nodes[2].color");
	has("diagram.edges[0].to「nai」");
	has("diagram.edges[1] は同じものどうし");
	has("diagram.edges[2].line");
	has("diagram.edges[2].arrow");
	assert.ok(Diagram.normalizeDiagram({nodes: []}).errors.some((e) => e.includes("1 つ以上")));
	assert.ok(Diagram.normalizeDiagram("箱").errors.length > 0);
});

test("段数: 線をたどって最初の箱から数える。戻る線(ループ)は数えず、rank を書いた箱はその段にする", () => {
	const nodes = ["a", "b", "c", "d", "e"].map((key) => ({key}));
	const edges = [{from: "a", to: "b"}, {from: "b", to: "c"}, {from: "a", to: "c"}, {from: "c", to: "b"}, {from: "c", to: "d"}];
	const rank = Diagram.ranksOf(nodes, edges);
	// a→b→c→d(c→b は戻る線)。つながっていない e は 0 段目
	assert.deepEqual(["a", "b", "c", "d", "e"].map((k) => rank.get(k)), [0, 1, 2, 3, 0]);
	const fixed = Diagram.ranksOf([{key: "a"}, {key: "b", rank: 4}, {key: "c"}], [{from: "a", to: "b"}, {from: "b", to: "c"}]);
	// a は前から線が来ないので、つながる先(b: 4 段目)の 1 つ手前に寄せる
	assert.deepEqual(["a", "b", "c"].map((k) => fixed.get(k)), [3, 4, 5]);
	// 前から線が来ない箱(メモ)は、つながる先の 1 つ手前の段に寄せる。始まりの箱は 0 段目のまま
	const memo = Diagram.ranksOf([{key: "s", type: "start"}, {key: "x"}, {key: "y"}, {key: "memo"}, {key: "s2", type: "start"}],
		[{from: "s", to: "x"}, {from: "x", to: "y"}, {from: "memo", to: "y"}, {from: "s2", to: "y"}]);
	assert.deepEqual(["s", "x", "y", "memo", "s2"].map((k) => memo.get(k)), [0, 1, 2, 1, 0]);
});

test("流れが右: 段ごとに左から右へ並び、分かれ道は縦に並べる。箱の種類で図形と色が決まる", () => {
	const result = layout({
		nodes: [
			{key: "start", text: "受注", type: "start"},
			{key: "check", text: "在庫はあるか", type: "decision"},
			{key: "ship", text: "出荷"},
			{key: "order", text: "仕入れ", type: "subprocess"},
			{key: "end", text: "完了", type: "end"}
		],
		edges: [
			{from: "start", to: "check"}, {from: "check", to: "ship", label: "ある"}, {from: "check", to: "order", label: "ない", style: "dashed"},
			{from: "order", to: "ship"}, {from: "ship", to: "end"}
		]
	});
	const at = Object.fromEntries(result.nodes.map((n) => [n.key, n]));
	assert.ok(at.start.x < at.check.x && at.check.x < at.order.x && at.order.x < at.ship.x && at.ship.x < at.end.x);
	assert.equal(at.check.shape, "rhombus");
	assert.equal(at.order.shape, "flow_chart_predefined_process");
	assert.equal(at.start.shape, "round_rectangle");
	assert.equal(at.check.fill, Diagram.NODE_TYPES.decision.fill);
	const dashed = result.edges.find((e) => e.label === "ない");
	assert.deepEqual(dashed.style, {strokeColor: "#4a5568", strokeWidth: "2", strokeStyle: "dashed", startStrokeCap: "none", endStrokeCap: "arrow"});
	assert.equal(result.lanes.length, 0);
	assertTidy(result);
});

test("レーン: 担当ごとの帯に分け、同じ段・同じレーンに複数あれば積む。流れが下ならレーンは縦の帯", () => {
	const spec = {
		lanes: [{key: "sales", title: "営業"}, {key: "warehouse", title: "倉庫"}],
		nodes: [
			{key: "a", text: "受注", type: "start", lane: "sales"},
			{key: "b", text: "出荷指示", lane: "sales"},
			{key: "c", text: "ピッキング", lane: "warehouse"},
			{key: "d", text: "検品", lane: "warehouse"},
			{key: "e", text: "請求", lane: "sales"}
		],
		edges: [{from: "a", to: "b"}, {from: "b", to: "c"}, {from: "b", to: "d"}, {from: "c", to: "e"}, {from: "d", to: "e"}]
	};
	for (const flow of ["right", "down"]) {
		const result = layout({...spec, flow});
		assertTidy(result);
		assert.equal(result.lanes.length, 2);
		const at = Object.fromEntries(result.nodes.map((n) => [n.key, n]));
		const inside = (n, band) => Math.abs(n.x - band.x) <= band.width / 2 && Math.abs(n.y - band.y) <= band.height / 2;
		const [sales, warehouse] = result.lanes;
		for (const key of ["a", "b", "e"]) assert.ok(inside(at[key], sales.band), `${flow}: ${key} が営業の帯の外`);
		for (const key of ["c", "d"]) assert.ok(inside(at[key], warehouse.band), `${flow}: ${key} が倉庫の帯の外`);
		// 同じ段(c・d)は流れと直角に積む
		if (flow === "right") {
			assert.equal(at.c.x, at.d.x);
			assert.ok(at.a.x < at.b.x && at.b.x < at.c.x && at.c.x < at.e.x);
			assert.ok(sales.band.y < warehouse.band.y);
			assert.ok(sales.header.x < at.a.x);
		} else {
			assert.equal(at.c.y, at.d.y);
			assert.ok(at.a.y < at.b.y && at.b.y < at.c.y && at.c.y < at.e.y);
			assert.ok(sales.band.x < warehouse.band.x);
			assert.ok(sales.header.y < at.a.y);
		}
	}
});

test("箱の大きさ: 長い文字は箱を広げ(上限まで)、それでも入らなければ高くする。幅・高さを書けばそのまま", () => {
	const result = layout({nodes: [
		{key: "short", text: "出荷"},
		{key: "long", text: "取引先からの注文書を受け取り、内容と在庫を確認して受注登録する"},
		{key: "fixed", text: "固定", width: 300, height: 90}
	]});
	const at = Object.fromEntries(result.nodes.map((n) => [n.key, n]));
	assert.deepEqual([at.short.width, at.short.height], [240, 120]);
	assert.equal(at.long.width, Diagram.GEOMETRY.maxWidth);
	assert.ok(at.long.height > 120);
	assert.deepEqual([at.fixed.width, at.fixed.height], [300, 90]);
	assertTidy(result);
});

test("付箋の島: 島ごとに見出しと付箋をまとめ、島を左から右へ、行が埋まったら次の行へ並べる。色を書かなければ島ごとに順に色を変える", () => {
	const notes = (n, prefix) => Array.from({length: n}, (_, i) => ({text: `${prefix}${i + 1}`}));
	const result = layout({type: "stickies", columns: 2, groups: [
		{title: "良かった点", notes: notes(5, "良")},
		{title: "困った点", color: "light_pink", notes: [...notes(2, "困"), {key: "slow", text: "表示が遅い", color: "orange"}]},
		{title: "次に試すこと", notes: notes(1, "次")}
	]});
	assertTidy(result);
	assert.equal(result.islands.length, 3);
	const [good, bad, next] = result.islands;
	// 1 行に 2 島(columns)。3 つ目は次の行(1 行目でいちばん高い島の下)
	assert.equal(good.band.y - good.band.height / 2, bad.band.y - bad.band.height / 2);
	assert.ok(good.band.x < bad.band.x);
	assert.ok(next.band.y - next.band.height / 2 > Math.max(good.band.y + good.band.height / 2, bad.band.y + bad.band.height / 2));
	// 付箋は島の中。5 枚は 3 列(√5 を切り上げ)、key を省くと「島の番号-付箋の番号」
	const inside = (n, band) => Math.abs(n.x - band.x) + n.width / 2 <= band.width / 2 && Math.abs(n.y - band.y) + n.height / 2 <= band.height / 2;
	const at = Object.fromEntries(result.nodes.map((n) => [n.key, n]));
	for (const key of ["1-1", "1-2", "1-3", "1-4", "1-5"]) assert.ok(inside(at[key], good.band), `${key} が島の外`);
	assert.ok(inside(at.slow, bad.band));
	assert.equal(at["1-1"].y, at["1-3"].y);
	assert.ok(at["1-4"].y > at["1-1"].y);
	// 色: 島の色を書かなければ順に(1 つ目は light_yellow)、付箋の色は島の色より付箋に書いた色
	assert.equal(at["1-1"].color, "light_yellow");
	assert.equal(at["2-1"].color, "light_pink");
	assert.equal(at.slow.color, "orange");
	assert.equal(at["3-1"].color, "light_blue");
	assert.equal(at["1-1"].item, "sticky");
	assert.equal(at["1-1"].height, Math.round(Diagram.STICKY.width * Diagram.STICKY.aspect));
	// 見出しは島の上の端の近く
	assert.ok(good.titleAt.y < at["1-1"].y);
});

test("付箋の島: 島に分けないなら notes だけ。線でつなげる。誤りは理由の一覧", () => {
	const plain = layout({type: "stickies", notes: [{key: "a", text: "案A"}, {key: "b", text: "案B"}], edges: [{from: "a", to: "b", label: "比べる"}]});
	assert.equal(plain.islands.length, 1);
	assert.equal(plain.islands[0].titleAt, null);
	assert.deepEqual(plain.edges.map((e) => [e.from, e.to, e.label]), [["a", "b", "比べる"]]);
	const {errors} = Diagram.normalizeDiagram({type: "stickies", groups: [{title: "x", color: "金色", notes: [{text: ""}, {key: "k", text: "y"}, {key: "k", text: "z"}]}],
		notes: [{text: "両方"}], edges: [{from: "k", to: "nai"}], columns: 9});
	const has = (part) => assert.ok(errors.some((e) => e.includes(part)), `${part} の理由が無い: ${errors.join(" | ")}`);
	has("groups(島ごと)か notes(島に分けない)のどちらか一方");
	has("diagram.groups[0].color は付箋の色");
	has("diagram.groups[0].notes[0].text が要ります");
	has("diagram.groups[0].notes[2].key「k」が 2 回");
	has("diagram.edges[0].to「nai」は付箋の key");
	has("diagram.columns");
	assert.ok(Diagram.normalizeDiagram({type: "表"}).errors[0].includes("diagram.type"));
});
