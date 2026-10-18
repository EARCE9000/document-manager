/*!
 * miro-layout-plan.js : 書き出すフレームの形と置き場所を計算する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 書き出しは、ボードの目印(付箋)を基準にした向きで、毎回新しいフレームを置く。Miro には触らない。
 *   right / left / up / down                              目印の横・上・下
 *   upper-right / lower-right / upper-left / lower-left    目印の斜めの方へ、目印のまわりのマスを輪を広げるように埋める(右上なら 右 → 上 → 右上 → …)
 *   cross  十字。資料をタグで 4 つに分け(miro-layout.js)、斜め 4 つのフレームに出す。フレームの隙間が十字の線になる。
 *          プロジェクトを渡されたときは、プロジェクトの概要カード(名前・説明・件数)を目印のすぐ下に。どこにも当たらない資料は「未分類」のフレームを下に
 * フレームの中は向きにかかわらず読む順(左上から右へ、行が埋まったら次の行)。フレームの形は向きに合わせる
 * (横は横長、上下は縦長、斜めは正方形に近い)。
 *
 * ほかのもの(ボードにあるフレーム・付箋など)と重なるときは、向きの外側へずらす(同じ目印に何度書き出しても重ならない)。
 * 位置: フレーム・目印・概要カードはボードの上の位置、フレームの中の資料は枠の左上からの中心の位置。
 */

const MiroLayout = require("./miro-layout.js");

// カードの見出しの色(十字の区画ごと)
const COLORS = Object.freeze({
	purple: "#eeedfe",
	pink: "#fbeaf0",
	gray: "#f1efe8",
	green: "#e1f5ee",
	orange: "#faece7"
});
module.exports.COLORS = COLORS;

// ---- 向き ----
const DIRECTIONS = Object.freeze(["right", "left", "up", "down", "upper-right", "lower-right", "upper-left", "lower-left", "cross"]);
const DIRECTION_NAMES = Object.freeze({
	"right": "右", "left": "左", "up": "上", "down": "下",
	"upper-right": "右上", "lower-right": "右下", "upper-left": "左上", "lower-left": "左下",
	"cross": "十字"
});
const DEFAULT_DIRECTION = "right";
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.DIRECTION_NAMES = DIRECTION_NAMES;
module.exports.DEFAULT_DIRECTION = DEFAULT_DIRECTION;

// 向きの書き方(付箋の 2 行目・CLI)。「右側」「右へ」「→」なども読む
const DIRECTION_WORDS = Object.freeze({
	"右": "right", "→": "right", "➡": "right",
	"左": "left", "←": "left", "⬅": "left",
	"上": "up", "↑": "up", "⬆": "up",
	"下": "down", "↓": "down", "⬇": "down",
	"右上": "upper-right", "↗": "upper-right",
	"右下": "lower-right", "↘": "lower-right",
	"左上": "upper-left", "↖": "upper-left",
	"左下": "lower-left", "↙": "lower-left",
	"十字": "cross", "十字型": "cross", "+": "cross", "✚": "cross", "十": "cross"
});
/**
 * 向きの書き方を読む。読めなければ null
 * @param {string} text 例: 「右」「(右側)」「右へ」「→」「upper-right」
 */
const parseDirection = (text) => {
	let word = String(text ?? "").normalize("NFKC").trim().toLowerCase();
	word = word.replace(/^[(\[]\s*/, "").replace(/\s*[)\]]$/, "").trim();
	if (DIRECTIONS.includes(word)) return word;
	if (DIRECTION_WORDS[word] != null) return DIRECTION_WORDS[word];
	// 「右側」「右へ」「右に」「右方向」「右向き」「左上に出す」など
	const stem = word.replace(/(側|へ|に|方向|向き|に出す|へ出す|出し)+$/, "").replace(/(側|へ|に|方向|向き)+$/, "");
	return DIRECTION_WORDS[stem] ?? null;
};
module.exports.parseDirection = parseDirection;

// ---- 十字の中心の概要カード ----

// 概要カードに出す説明の長さの上限(超えたら切って「…」。カードからはみ出さないように)
const SUMMARY_DESCRIPTION_MAX = 100;
module.exports.SUMMARY_DESCRIPTION_MAX = SUMMARY_DESCRIPTION_MAX;
/**
 * 概要カードの文字。説明があれば「名前 / 説明 / 件数・最終更新」の 3 行、無ければ 1 行
 * (改行は Miro の文字の中で改行になる)
 */
const summaryText = (project, total, latest) => {
	const name = project?.name ?? "";
	const stats = `資料 ${total} 件${latest ? ` / 最終更新 ${latest}` : ""}`;
	const description = String(project?.description ?? "").replace(/\s+/g, " ").trim();
	if (description === "") return `${name} / ${stats}`;
	const chars = [...description];
	const short = chars.length > SUMMARY_DESCRIPTION_MAX ? `${chars.slice(0, SUMMARY_DESCRIPTION_MAX).join("")}…` : description;
	return `${name}\n${short}\n${stats}`;
};
module.exports.summaryText = summaryText;
const SUMMARY = Object.freeze({width: 900, fontSize: 28});

// ---- フレームの中の並び ----

/** 1 行に並べる枚数。横は横長(8 枚)、上下は縦長(3 枚)、斜めは正方形に近く */
const columnsFor = (direction, count) => {
	const n = Math.max(1, count);
	if (direction === "right" || direction === "left") return Math.min(8, n);
	if (direction === "up" || direction === "down") return Math.min(3, n);
	return Math.min(6, Math.ceil(Math.sqrt(n)));
};
module.exports.columnsFor = columnsFor;

/**
 * フレームの中に、読む順で並べる
 * @param {Array<{documentId: string, height: number, color?: ?string}>} documents
 * @returns {{items: Array<{documentId: string, x: number, y: number, color: ?string}>, width: number, height: number}}
 */
const planFrame = (direction, documents, G) => {
	const columns = columnsFor(direction, documents.length);
	const W = G.itemWidth;
	const items = [];
	let y = G.padding;
	for (let i = 0; i < documents.length; i += columns) {
		const row = documents.slice(i, i + columns);
		const rowHeight = Math.max(...row.map((d) => Number(d.height) || W * G.defaultAspect));
		row.forEach((d, index) => items.push({
			documentId: d.documentId,
			x: G.padding + index * (W + G.gapX) + W / 2,
			y: y + (Number(d.height) || W * G.defaultAspect) / 2,
			color: d.color ?? null
		}));
		y += rowHeight + G.captionHeight + G.gapY;
	}
	return {
		items,
		width: Math.ceil(G.padding * 2 + columns * W + (columns - 1) * G.gapX),
		height: Math.ceil(Math.max(y - G.gapY + G.padding, 400))
	};
};
module.exports.planFrame = planFrame;

// ---- 置き場所 ----

const boxOf = (left, top, width, height) => ({left, top, right: left + width, bottom: top + height, width, height});
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
module.exports.overlaps = overlaps;

/**
 * 目印に対するフレームの左上。横は上の端を、上下は左の端を目印にそろえ、斜めはフレームの角を目印の角に向ける
 * @param {{left: number, top: number, right: number, bottom: number}} anchor
 */
const slotFor = (anchor, direction, {width, height}, gap) => {
	switch (direction) {
		case "right": return {left: anchor.right + gap, top: anchor.top};
		case "left": return {left: anchor.left - gap - width, top: anchor.top};
		case "up": return {left: anchor.left, top: anchor.top - gap - height};
		case "down": return {left: anchor.left, top: anchor.bottom + gap};
		case "upper-right": return {left: anchor.right + gap, top: anchor.top - gap - height};
		case "lower-right": return {left: anchor.right + gap, top: anchor.bottom + gap};
		case "upper-left": return {left: anchor.left - gap - width, top: anchor.top - gap - height};
		case "lower-left": return {left: anchor.left - gap - width, top: anchor.bottom + gap};
		default: throw new Error(`unknown direction: ${direction}`);
	}
};

// ---- 斜めの置き場所(付箋のまわりを、輪を広げるように埋める) ----
// 付箋を真ん中にしたマス(フレームと同じ大きさ。資料は置かない)を 0 番目とし、フレームの大きさのマス目で数える。
// 右上なら 1 周目は 右 → 上 → 右上、2 周目は 右右 → 右右上 → 上上 → 右上上 → 右右上上 … と、付箋に近い所から外へ。
// 輪 k の中は、まず横へ k マスの列を付箋の高さから(j = 0..k-1)、次に縦へ k マスの段を付箋の列から(i = 0..k)。
// ふさがっているマス(ほかのフレーム・付箋がある)は飛ばす。右下・左上・左下は向きを変えただけ
const DIAGONALS = Object.freeze({"upper-right": [1, -1], "lower-right": [1, 1], "upper-left": [-1, -1], "lower-left": [-1, 1]});
const RING_LIMIT = 8;
/** 輪の順に並べたマス([横へ何マス, 縦へ何マス])。図の順番の表示にも使う */
const ringCells = (rings = RING_LIMIT) => {
	const cells = [];
	for (let k = 1; k <= rings; k++) {
		for (let j = 0; j < k; j++) cells.push([k, j]);
		for (let i = 0; i <= k; i++) cells.push([i, k]);
	}
	return cells;
};
module.exports.ringCells = ringCells;
/** 斜めの向きで、空いているいちばん近いマスの左上。どこも空いていなければ null */
const ringSlot = (anchor, direction, {width, height}, gap, obstacles) => {
	const [sx, sy] = DIAGONALS[direction];
	const cx = (anchor.left + anchor.right) / 2;
	const cy = (anchor.top + anchor.bottom) / 2;
	const margin = gap / 2;
	for (const [i, j] of ringCells()) {
		const left = cx + sx * i * (width + gap) - width / 2;
		const top = cy + sy * j * (height + gap) - height / 2;
		const grown = {left: left - margin, right: left + width + margin, top: top - margin, bottom: top + height + margin};
		if (!obstacles.some((o) => overlaps(grown, o))) return {left, top};
	}
	return null;
};

// ずらす向き(斜めは横へ。同じ段のまま外へ出す)
const PUSH = Object.freeze({
	"right": [1, 0], "left": [-1, 0], "up": [0, -1], "down": [0, 1],
	"upper-right": [1, 0], "lower-right": [1, 0], "upper-left": [-1, 0], "lower-left": [-1, 0], "cross": [1, 0]
});

/**
 * まとまり(フレームとカードの組)が何とも重ならなくなるまで、向きの外側へずらす
 * @param {Array<{left, top, right, bottom}>} boxes まとまりの中の範囲
 * @returns {{dx: number, dy: number}}
 */
const clearOf = (boxes, direction, obstacles, gap) => {
	const [px, py] = PUSH[direction];
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < 1000; i++) {
		const moved = boxes.map((b) => ({left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy}));
		let step = 0;
		for (const o of obstacles) {
			for (const b of moved) {
				if (!overlaps(b, o)) continue;
				// 重なりを抜けるのに要る長さ(間を gap 空ける)
				const need = px > 0 ? o.right + gap - b.left : px < 0 ? b.right - (o.left - gap) : py > 0 ? o.bottom + gap - b.top : b.bottom - (o.top - gap);
				step = Math.max(step, need);
			}
		}
		if (step <= 0) return {dx, dy};
		dx += px * Math.ceil(step);
		dy += py * Math.ceil(step);
	}
	return {dx, dy};
};

/**
 * 書き出しの配置をまとめて決める。
 * @param {object} options
 * @param {Array<{direction: string, title: string, documents: Array<{documentId: string, height: number}>}>} options.groups
 *   出す順。direction が cross のものは、input のタグで 4 つに分ける
 * @param {?{left: number, top: number, right: number, bottom: number}} options.anchor 目印の範囲(ボードの上)。
 *   null なら空いている所(free の左上)に、向きの形のまま出す
 * @param {?{left: number, top: number}} options.free 目印が無いときの置き場所(ボードの中身の右)
 * @param {Array<{left, top, right, bottom}>} options.obstacles ボードにあるもの(重ねない)。目印そのものは入れない
 * @param {{project: ?object, documents: object[]}} options.input miro-layout.js の loadDocumentsInput() の形(十字の振り分けに使う。project が無ければ概要カードを置かない)
 * @param {object} options.geometry miro-export.js の LAYOUT
 * @returns {{frames: Array<{title: string, direction: string, area: ?string, left: number, top: number, width: number, height: number,
 *            items: Array<{documentId: string, x: number, y: number, color: ?string}>}>,
 *            cards: Array<{text: string, x: number, y: number, width: number, fontSize: number}>, reports: object[]}}
 */
module.exports.planExport = ({groups, anchor = null, free = null, obstacles = [], input = {documents: []}, geometry: G}) => {
	const frames = [];
	const cards = [];
	const reports = [];
	const blocked = anchor == null ? [] : [...obstacles];
	// 目印が無いときは、仮の目印(大きさ 0)を原点に置いて組み、最後に空いている所へまとめて動かす
	const base = anchor ?? {left: 0, top: 0, right: 0, bottom: 0};
	const gap = G.anchorGap;
	const inputOf = new Map((input.documents ?? []).map((d) => [d.documentId, d]));

	for (const group of groups) {
		const unit = [];
		if (group.direction === "cross") {
			const docs = group.documents.map((d) => inputOf.get(d.documentId) ?? {documentId: d.documentId, entryFile: d.title ?? "", tags: [], folderNames: []});
			const report = MiroLayout.buildCrossReport({project: input.project, documents: docs});
			reports.push(report);
			const sizeOf = new Map(group.documents.map((d) => [d.documentId, d]));
			const colorOf = (p) => ({upper_left: COLORS.purple, lower_left: COLORS.pink, upper_right: COLORS.gray}[p.area]
				?? (p.area === "lower_right" ? (p.slot === "会議:定例" ? COLORS.green : COLORS.orange) : null));
			const planned = {};
			for (const area of MiroLayout.CROSS_AREAS) {
				const entries = report.placements.filter((p) => p.area === area);
				if (entries.length === 0) continue;
				const direction = {upper_left: "upper-left", upper_right: "upper-right", lower_left: "lower-left", lower_right: "lower-right", unclassified: "down"}[area];
				planned[area] = {direction, ...planFrame(direction, entries.map((p) => ({documentId: p.documentId, height: sizeOf.get(p.documentId)?.height, color: colorOf(p)})), G)};
			}
			// 概要カード(目印のすぐ下。プロジェクトを渡されたときだけ)。下の 2 つのフレームは、その下から
			let card = null;
			let cardBox = null;
			if (input.project != null) {
				const latest = docs.map((d) => String(d.modified ?? "")).sort().pop()?.slice(0, 10) ?? "";
				const text = summaryText(input.project, group.documents.length, latest);
				const cardHeight = text.split("\n").length * SUMMARY.fontSize * 1.6 + 40;
				const cx = (base.left + base.right) / 2;
				card = {text, x: cx, y: base.bottom + gap / 2 + cardHeight / 2, width: SUMMARY.width, height: Math.ceil(cardHeight), fontSize: SUMMARY.fontSize};
				cardBox = {left: cx - SUMMARY.width / 2, right: cx + SUMMARY.width / 2, top: base.bottom + gap / 2, bottom: base.bottom + gap / 2 + cardHeight};
			}
			const lowerAnchor = cardBox == null ? base : {...base, bottom: cardBox.bottom};
			const at = {};
			for (const area of ["upper_left", "upper_right", "lower_left", "lower_right"]) {
				if (planned[area] == null) continue;
				const ref = area.startsWith("lower") ? lowerAnchor : base;
				at[area] = slotFor(ref, planned[area].direction, planned[area], gap);
			}
			if (planned.unclassified != null) {
				const lowerBottom = Math.max(lowerAnchor.bottom, ...["lower_left", "lower_right"].filter((a) => at[a]).map((a) => at[a].top + planned[a].height));
				at.unclassified = {left: at.lower_left?.left ?? base.left - gap - planned.unclassified.width, top: lowerBottom + gap};
			}
			for (const area of MiroLayout.CROSS_AREAS) {
				if (planned[area] == null) continue;
				unit.push({
					kind: "frame", title: `${group.title} / ${MiroLayout.CROSS_AREA_TITLES[area]}`, direction: planned[area].direction, area,
					...boxOf(at[area].left, at[area].top, planned[area].width, planned[area].height), items: planned[area].items
				});
			}
			if (card != null) unit.push({kind: "card", ...cardBox, card});
		} else {
			const plan = planFrame(group.direction, group.documents, G);
			// 斜めは、付箋のまわりの空いているマスを輪の順に探す(無ければ斜めの角に置いて外へずらす)
			const slot = (DIAGONALS[group.direction] != null ? ringSlot(base, group.direction, plan, gap, anchor == null ? blocked : [...blocked, anchor]) : null)
				?? slotFor(base, group.direction, plan, gap);
			unit.push({kind: "frame", title: group.title, direction: group.direction, area: null, ...boxOf(slot.left, slot.top, plan.width, plan.height), items: plan.items});
		}
		// 重なるなら外側へずらす(十字はまとめて右へ。目印は真ん中にあるので、ぶつかる相手に数えない)
		const against = group.direction === "cross" || anchor == null ? blocked : [...blocked, anchor];
		const {dx, dy} = clearOf(unit, group.direction, against, G.frameGap);
		for (const u of unit) {
			const moved = {...u, left: u.left + dx, right: u.right + dx, top: u.top + dy, bottom: u.bottom + dy};
			blocked.push(moved);
			if (u.kind === "frame") frames.push(moved);
			else cards.push({...u.card, x: u.card.x + dx, y: u.card.y + dy});
		}
	}

	// 目印が無いとき: まとめて、ボードの中身の右の空いている所へ
	if (anchor == null && (frames.length > 0 || cards.length > 0)) {
		const all = [...frames, ...cards.map((c) => ({left: c.x - c.width / 2, top: c.y - c.height / 2}))];
		const minLeft = Math.min(...all.map((b) => b.left));
		const minTop = Math.min(...all.map((b) => b.top));
		const dx = (free?.left ?? 0) - minLeft;
		const dy = (free?.top ?? 0) - minTop;
		for (const f of frames) Object.assign(f, {left: f.left + dx, right: f.right + dx, top: f.top + dy, bottom: f.bottom + dy});
		for (const c of cards) Object.assign(c, {x: c.x + dx, y: c.y + dy});
	}
	return {
		frames: frames.map((f) => ({title: f.title, direction: f.direction, area: f.area, left: Math.round(f.left), top: Math.round(f.top),
			width: Math.ceil(f.width), height: Math.ceil(f.height), items: f.items})),
		cards: cards.map((c) => ({...c, x: Math.round(c.x), y: Math.round(c.y)})),
		reports
	};
};
