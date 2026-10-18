/*!
 * miro-diagram.js : Miro に描くフロー図(箱と線)の指示を検め、フレームの中の位置を決める
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 書き出し(miro-export.js)の 1 つの組として、資料の代わりにフロー図を描く。AI は「箱と線の一覧」を渡すだけで、
 * 位置はここで決める(箱の並びを座標で考えさせない)。Miro は呼ばない(計算だけ)。
 *
 *   {
 *     "flow": "right",                                  流れの向き: right(左から右)・down(上から下)
 *     "lanes": [{"key": "sales", "title": "営業"}],      レーン(担当ごとの帯)。省ける。使うなら、どの箱にも lane が要る
 *     "nodes": [{"key": "a", "text": "受注", "type": "start", "lane": "sales"}, …],
 *     "edges": [{"from": "a", "to": "b", "label": "はい"}, …]
 *   }
 *
 * 並べ方: 線をたどって、最初の箱からの段数(rank)を流れの向きに並べる(戻る線=ループは段数の計算に使わない)。
 * 同じ段・同じレーンに複数あれば、流れと直角の向きに並べる。rank を書けば、その段に置く。
 */

/** Miro の図形の種類(書き出しの手直しと同じもの) */
const SHAPE_KINDS = Object.freeze(["rectangle", "round_rectangle", "circle", "triangle", "rhombus", "parallelogram", "trapezoid", "pentagon", "hexagon", "octagon", "star", "flow_chart_predefined_process", "can", "cross", "right_arrow", "left_arrow", "left_right_arrow", "left_brace", "right_brace"]);
module.exports.SHAPE_KINDS = SHAPE_KINDS;

/** 箱の種類(業務フローの記号)と、Miro の図形・既定の色 */
const NODE_TYPES = Object.freeze({
	start: {shape: "round_rectangle", fill: "#e3f2e5"},
	end: {shape: "round_rectangle", fill: "#fde8e8"},
	process: {shape: "rectangle", fill: "#ffffff"},
	decision: {shape: "rhombus", fill: "#fff4d6"},
	data: {shape: "parallelogram", fill: "#e8f0fe"},
	subprocess: {shape: "flow_chart_predefined_process", fill: "#f1ecfa"},
	store: {shape: "can", fill: "#eef1f4"},
	note: {shape: "rectangle", fill: "#fff9c4"}
});
module.exports.NODE_TYPES = NODE_TYPES;
const FLOWS = Object.freeze({right: "right", "右": "right", down: "down", "下": "down"});
const LINES = Object.freeze(["elbowed", "straight", "curved"]);
const STROKES = Object.freeze(["solid", "dashed", "dotted"]);
const ARROWS = Object.freeze(["end", "both", "none"]);
const LIMITS = Object.freeze({nodes: 200, edges: 400, lanes: 20, keyLength: 60, textLength: 300, labelLength: 100, titleLength: 100, rank: 200});
module.exports.LIMITS = LIMITS;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 大きさと間(フレームの中の座標。Miro の項目の大きさと同じ単位) */
const GEOMETRY = Object.freeze({
	node: {width: 240, height: 120}, maxWidth: 480,
	gapRank: 140, gapCross: 60,
	padding: 80, lanePad: 40, laneHeader: 200, laneHeaderDown: 80,
	charWidth: 16, lineHeight: 22, textPad: 40
});
module.exports.GEOMETRY = GEOMETRY;
const STYLE = Object.freeze({
	border: "#4a5568", text: "#1f2933", line: "#4a5568",
	laneFill: ["#f6f8fb", "#ffffff"], laneBorder: "#cfd6e0", laneHeaderFill: "#e8edf3"
});

/**
 * 指示を検める。正しくないところは errors に入れる(呼び出し側がまとめて断る)。
 * 資料へのリンク(documentId)は、呼び出し側が文書を確かめてから link にする
 * @returns {{errors: string[], diagram: ?{flow: string, lanes: object[], nodes: object[], edges: object[]}}}
 */
module.exports.normalizeDiagram = (spec, label = "diagram") => {
	const errors = [];
	if (spec == null || typeof spec !== "object" || Array.isArray(spec)) return {errors: [`${label} は {nodes, edges} の形です`], diagram: null};
	const text = (value, at, max, {required = true} = {}) => {
		if (value == null || value === "") {
			if (required) errors.push(`${at} が要ります`);
			return "";
		}
		const s = String(value);
		if ([...s].length > max) errors.push(`${at} は ${max} 文字までです`);
		return s;
	};
	const key = (value, at) => {
		const s = text(value, at, LIMITS.keyLength).trim();
		return s;
	};
	const color = (value, at) => {
		if (value == null) return null;
		if (!COLOR_PATTERN.test(String(value))) errors.push(`${at} は #rrggbb の形の色です(${JSON.stringify(value)})`);
		return String(value);
	};
	const size = (value, at, min, max) => {
		if (value == null) return null;
		const n = Number(value);
		if (!Number.isFinite(n) || n < min || n > max) errors.push(`${at} は ${min} 以上 ${max} 以下の数です`);
		return n;
	};
	const list = (value, at, max, {required = false} = {}) => {
		if (value == null) {
			if (required) errors.push(`${at} が要ります(配列)`);
			return [];
		}
		if (!Array.isArray(value)) {
			errors.push(`${at} は配列です`);
			return [];
		}
		if (required && value.length === 0) errors.push(`${at} に 1 つ以上要ります`);
		if (value.length > max) errors.push(`${at} は ${max} 個までです(${value.length} 個)`);
		return value.slice(0, max);
	};

	const flow = spec.flow == null || spec.flow === "" ? "right" : FLOWS[String(spec.flow).trim().toLowerCase()] ?? null;
	if (flow == null) errors.push(`${label}.flow は right(左から右)か down(上から下)です(${JSON.stringify(spec.flow)})`);

	const laneKeys = new Set();
	const lanes = list(spec.lanes, `${label}.lanes`, LIMITS.lanes).map((lane, i) => {
		const k = key(lane?.key, `${label}.lanes[${i}].key`);
		if (k && laneKeys.has(k)) errors.push(`${label}.lanes[${i}].key「${k}」が 2 回あります`);
		laneKeys.add(k);
		return {key: k, title: text(lane?.title ?? k, `${label}.lanes[${i}].title`, LIMITS.titleLength)};
	});

	const nodeKeys = new Set();
	const nodes = list(spec.nodes, `${label}.nodes`, LIMITS.nodes, {required: true}).map((node, i) => {
		const at = `${label}.nodes[${i}]`;
		const k = key(node?.key, `${at}.key`);
		if (k && nodeKeys.has(k)) errors.push(`${at}.key「${k}」が 2 回あります`);
		nodeKeys.add(k);
		const type = node?.type == null || node.type === "" ? "process" : String(node.type);
		if (NODE_TYPES[type] == null) errors.push(`${at}.type は ${Object.keys(NODE_TYPES).join(" / ")} のどれかです(${JSON.stringify(node?.type)})`);
		const shape = node?.shape == null ? NODE_TYPES[type]?.shape ?? "rectangle" : String(node.shape);
		if (!SHAPE_KINDS.includes(shape)) errors.push(`${at}.shape は ${SHAPE_KINDS.join(" / ")} のどれかです(${JSON.stringify(node?.shape)})`);
		let lane = null;
		if (lanes.length > 0) {
			lane = node?.lane == null ? null : String(node.lane);
			if (lane == null) errors.push(`${at}.lane が要ります(lanes を使うときは、どの箱にもレーンを書きます)`);
			else if (!laneKeys.has(lane)) errors.push(`${at}.lane「${lane}」は lanes にありません`);
		} else if (node?.lane != null) {
			errors.push(`${at}.lane を使うときは lanes も書きます`);
		}
		let rank = null;
		if (node?.rank != null) {
			rank = Number(node.rank);
			if (!Number.isInteger(rank) || rank < 0 || rank > LIMITS.rank) errors.push(`${at}.rank は 0〜${LIMITS.rank} の整数です`);
		}
		const link = node?.link == null ? null : String(node.link);
		if (link != null && (!/^https?:\/\/\S+$/.test(link) || link.length > 2000)) errors.push(`${at}.link は http:// か https:// で始まる URL です`);
		if (link != null && node?.documentId != null) errors.push(`${at} は link と documentId のどちらか一方です`);
		return {
			key: k, text: text(node?.text, `${at}.text`, LIMITS.textLength), type, shape, lane, rank,
			color: color(node?.color, `${at}.color`), link, documentId: node?.documentId == null ? null : String(node.documentId),
			width: size(node?.width, `${at}.width`, 80, 1000), height: size(node?.height, `${at}.height`, 40, 1000)
		};
	});

	const edges = list(spec.edges, `${label}.edges`, LIMITS.edges).map((edge, i) => {
		const at = `${label}.edges[${i}]`;
		const from = edge?.from == null ? "" : String(edge.from);
		const to = edge?.to == null ? "" : String(edge.to);
		if (!nodeKeys.has(from)) errors.push(`${at}.from「${from}」は nodes の key にありません`);
		if (!nodeKeys.has(to)) errors.push(`${at}.to「${to}」は nodes の key にありません`);
		if (from !== "" && from === to) errors.push(`${at} は同じ箱どうしをつないでいます`);
		const line = edge?.line == null ? "elbowed" : String(edge.line);
		if (!LINES.includes(line)) errors.push(`${at}.line は ${LINES.join(" / ")} のどれかです`);
		const stroke = edge?.style == null ? "solid" : String(edge.style);
		if (!STROKES.includes(stroke)) errors.push(`${at}.style は ${STROKES.join(" / ")} のどれかです`);
		const arrow = edge?.arrow == null ? "end" : String(edge.arrow);
		if (!ARROWS.includes(arrow)) errors.push(`${at}.arrow は ${ARROWS.join(" / ")} のどれかです`);
		return {from, to, label: edge?.label == null || edge.label === "" ? null : text(edge.label, `${at}.label`, LIMITS.labelLength), line, style: stroke, arrow, color: color(edge?.color, `${at}.color`)};
	});
	return {errors, diagram: errors.length > 0 ? null : {flow, lanes, nodes, edges}};
};

/** 文字の量から箱の大きさを決める(全角 1 文字を charWidth、半角はその 0.6 倍とみなす) */
const sizeOf = (node) => {
	const units = (line) => [...line].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.6 : 1), 0);
	const lines = String(node.text).split(/\r?\n/);
	const longest = Math.max(...lines.map(units));
	const base = node.shape === "rhombus" ? {width: 260, height: 150} : GEOMETRY.node;
	// 菱形は中に入る幅が狭いので、文字の幅を広めに見積もる
	const textWidth = longest * GEOMETRY.charWidth * (node.shape === "rhombus" ? 1.6 : 1);
	let width = node.width ?? Math.min(GEOMETRY.maxWidth, Math.max(base.width, Math.ceil(textWidth + GEOMETRY.textPad * 2)));
	const perLine = Math.max(1, (width - GEOMETRY.textPad * 2) / (GEOMETRY.charWidth * (node.shape === "rhombus" ? 1.6 : 1)));
	const rows = lines.reduce((n, line) => n + Math.max(1, Math.ceil(units(line) / perLine)), 0);
	let height = node.height ?? Math.max(base.height, Math.ceil(rows * GEOMETRY.lineHeight * (node.shape === "rhombus" ? 1.8 : 1) + GEOMETRY.textPad * 2));
	width = Math.round(width);
	height = Math.round(height);
	return {width, height};
};

/**
 * 段数(流れの向きの位置)を決める。戻る線(ループ)は使わない。rank を書いた箱はその段にし、その先はそこから数える
 * @returns {Map<string, number>}
 */
const ranksOf = (nodes, edges) => {
	const order = new Map(nodes.map((n, i) => [n.key, i]));
	const out = new Map(nodes.map((n) => [n.key, []]));
	for (const e of edges) out.get(e.from).push(e.to);
	// 戻る線を見つける(書いた順に深さ優先でたどり、たどっている途中の箱へ戻る線)
	const back = new Set();
	const state = new Map();
	for (const start of nodes) {
		if (state.has(start.key)) continue;
		const stack = [{key: start.key, next: 0}];
		state.set(start.key, "open");
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const targets = out.get(top.key);
			if (top.next >= targets.length) {
				state.set(top.key, "done");
				stack.pop();
				continue;
			}
			const to = targets[top.next++];
			if (state.get(to) === "open") back.add(`${top.key}\u0000${to}`);
			else if (!state.has(to)) {
				state.set(to, "open");
				stack.push({key: to, next: 0});
			}
		}
	}
	const forward = edges.filter((e) => !back.has(`${e.from}\u0000${e.to}`));
	const indegree = new Map(nodes.map((n) => [n.key, 0]));
	for (const e of forward) indegree.set(e.to, indegree.get(e.to) + 1);
	const fixed = new Map(nodes.filter((n) => n.rank != null).map((n) => [n.key, n.rank]));
	const rank = new Map(nodes.map((n) => [n.key, 0]));
	const queue = nodes.filter((n) => indegree.get(n.key) === 0).map((n) => n.key);
	while (queue.length > 0) {
		queue.sort((a, b) => order.get(a) - order.get(b));
		const key = queue.shift();
		const r = fixed.get(key) ?? rank.get(key);
		rank.set(key, r);
		for (const e of forward.filter((f) => f.from === key)) {
			rank.set(e.to, Math.max(rank.get(e.to), r + 1));
			indegree.set(e.to, indegree.get(e.to) - 1);
			if (indegree.get(e.to) === 0) queue.push(e.to);
		}
	}
	for (const [key, r] of fixed) rank.set(key, r);
	// 前から線が来ない箱(メモ・途中から入る資料など)は、つながる先の 1 つ手前の段に寄せる(左端に離れて置かれないように)。
	// 始まり(type: start)は左端のまま
	const incoming = new Set(forward.map((e) => e.to));
	for (const n of nodes) {
		if (incoming.has(n.key) || fixed.has(n.key) || n.type === "start") continue;
		const next = forward.filter((e) => e.from === n.key).map((e) => rank.get(e.to));
		if (next.length > 0) rank.set(n.key, Math.max(0, Math.min(...next) - 1));
	}
	return rank;
};
module.exports.ranksOf = ranksOf;

/**
 * 箱・レーンの位置とフレームの大きさを決める(位置はフレームの左上からの中心)
 * @returns {{width: number, height: number, lanes: object[], nodes: object[], edges: object[]}}
 */
module.exports.layoutDiagram = (diagram) => {
	const G = GEOMETRY;
	const down = diagram.flow === "down";
	const rank = ranksOf(diagram.nodes, diagram.edges);
	const sized = diagram.nodes.map((n) => ({...n, ...sizeOf(n), rank: rank.get(n.key)}));
	// 流れの向き(main)と、直角の向き(cross)の大きさ
	const mainOf = (n) => (down ? n.height : n.width);
	const crossOf = (n) => (down ? n.width : n.height);
	const laneList = diagram.lanes.length > 0 ? diagram.lanes : [{key: null, title: null}];
	const maxRank = Math.max(...sized.map((n) => n.rank));
	// 段ごとの幅(流れの向き)
	const rankSize = Array.from({length: maxRank + 1}, (_, r) => Math.max(0, ...sized.filter((n) => n.rank === r).map(mainOf)));
	const header = diagram.lanes.length > 0 ? (down ? G.laneHeaderDown : G.laneHeader) : 0;
	const mainStart = G.padding + header + (diagram.lanes.length > 0 ? G.lanePad : 0);
	const rankStart = [];
	let cursor = mainStart;
	for (let r = 0; r <= maxRank; r++) {
		rankStart.push(cursor);
		// 箱の無い段は詰める(rank を飛ばして書かれたとき)
		if (rankSize[r] > 0) cursor += rankSize[r] + G.gapRank;
	}
	const mainEnd = cursor - G.gapRank + (diagram.lanes.length > 0 ? G.lanePad : 0);

	// レーンごとに、同じ段に並ぶ箱を直角の向きに積む
	const placed = [];
	const lanes = [];
	let crossCursor = G.padding;
	laneList.forEach((lane, laneIndex) => {
		const members = sized.filter((n) => n.lane === lane.key);
		const byRank = new Map();
		for (const n of members) byRank.set(n.rank, [...(byRank.get(n.rank) ?? []), n]);
		const slot = Math.max(G.node.height, ...members.map(crossOf));
		const slots = Math.max(1, ...[...byRank.values()].map((list) => list.length));
		const pad = diagram.lanes.length > 0 ? G.lanePad : 0;
		const laneSize = slots * slot + (slots - 1) * G.gapCross + pad * 2;
		for (const [r, list] of byRank) {
			// 段の中で少ないときは、レーンの中ほどに寄せる
			const offset = (slots - list.length) * (slot + G.gapCross) / 2;
			list.forEach((n, i) => {
				const main = rankStart[r] + rankSize[r] / 2;
				const cross = crossCursor + pad + offset + i * (slot + G.gapCross) + slot / 2;
				placed.push({...n, x: down ? cross : main, y: down ? main : cross});
			});
		}
		if (diagram.lanes.length > 0) {
			const bandMain = mainEnd - G.padding;
			lanes.push({
				key: lane.key, title: lane.title,
				fill: STYLE.laneFill[laneIndex % 2], border: STYLE.laneBorder, headerFill: STYLE.laneHeaderFill,
				// 帯(見出しを含む全体)と見出し
				band: down
					? {x: crossCursor + laneSize / 2, y: G.padding + bandMain / 2, width: laneSize, height: bandMain}
					: {x: G.padding + bandMain / 2, y: crossCursor + laneSize / 2, width: bandMain, height: laneSize},
				header: down
					? {x: crossCursor + laneSize / 2, y: G.padding + header / 2, width: laneSize, height: header}
					: {x: G.padding + header / 2, y: crossCursor + laneSize / 2, width: header, height: laneSize}
			});
		}
		crossCursor += laneSize;
	});
	const crossEnd = crossCursor;
	const order = new Map(diagram.nodes.map((n, i) => [n.key, i]));
	placed.sort((a, b) => order.get(a.key) - order.get(b.key));
	const nodes = placed.map((n) => ({
		key: n.key, text: n.text, type: n.type, shape: n.shape, link: n.link,
		x: Math.round(n.x), y: Math.round(n.y), width: n.width, height: n.height,
		fill: n.color ?? NODE_TYPES[n.type].fill, border: STYLE.border, color: STYLE.text
	}));
	const edges = diagram.edges.map((e) => ({
		from: e.from, to: e.to, label: e.label, line: e.line,
		style: {
			strokeColor: e.color ?? STYLE.line, strokeWidth: "2", strokeStyle: e.style === "solid" ? "normal" : e.style,
			startStrokeCap: e.arrow === "both" ? "arrow" : "none", endStrokeCap: e.arrow === "none" ? "none" : "arrow"
		}
	}));
	const width = Math.ceil((down ? crossEnd : mainEnd) + G.padding);
	const height = Math.ceil((down ? mainEnd : crossEnd) + G.padding);
	return {width: Math.max(width, 400), height: Math.max(height, 400), lanes, nodes, edges};
};
