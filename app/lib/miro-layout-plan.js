/*!
 * miro-layout-plan.js : 型ごとの並べ方(枠の中のどこに置くか・区画の見出し・線)を計算する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * どの資料をどの区画に置くかは miro-layout.js の buildReport() で決め、ここではその区画を枠の中の位置にする。
 * Miro には触らない。結果はレイアウトをまとめて当てる処理(miro-sync.js)にそのまま渡せる形:
 *   {items: [{documentId, x, y, color}], labels: [...], shapes: [...], frame: {width, height}}
 * 位置はすべて枠の左上からの中心の位置。labels・shapes は miro-sync.js の normalizeLayout() と同じ形。
 *
 * 仕様は docs/miro-layouts/layout-spec.md の 4・7 章。区画に入りきらない「ほか n 件」の中身は、枠の下の
 * 「ほか n 件の中身」の段に、区画ごとの小見出しを付けて並べる(上から 管理 → 会議 → 未分類 → ほか n 件の中身)。
 */

const MiroLayout = require("./miro-layout.js");

// カードの見出しの色(図の色に合わせる)
const COLORS = Object.freeze({
	purple: "#eeedfe",
	pink: "#fbeaf0",
	gray: "#f1efe8",
	green: "#e1f5ee",
	orange: "#faece7",
	after: "#faeeda"
});
module.exports.COLORS = COLORS;

const AREA_TITLES = Object.freeze({
	upper_left: "左上: 要件定義〜設計",
	lower_left: "左下: テスト〜リリース",
	upper_right: "右上: 管理系",
	lower_right: "右下: 会議",
	table: "表",
	left: "左半分: 管理系",
	management: "管理",
	meeting: "会議",
	unclassified: "未分類"
});

const LINE_COLOR = "#333333";

const label = (text, x, y, width, {fontSize = null, color = null, fillColor = null, bold = true, align = "left", link = null} = {}) =>
	({text: String(text).slice(0, 300), x, y, width: Math.max(40, width), fontSize, color, fillColor, bold, align, ...(link ? {link} : {})});
// Miro の図形は幅・高さとも 8 以上。枠線の太さに 0 は指定できない(指定しなければ枠線は見えない)
const MIN_SHAPE = 8;
const shape = ({x, y, width, height, kind = "rectangle", text = "", fillColor = null, fillOpacity = null, borderColor = null, borderWidth = null, borderStyle = null, link = null}) =>
	({shape: kind, text, x, y, width: Math.max(MIN_SHAPE, width), height: Math.max(MIN_SHAPE, height), fillColor, fillOpacity, borderColor, borderWidth, borderStyle, ...(link ? {link} : {})});
/** 線(細い長方形)。x1,y1 から x2,y2 へ(縦か横) */
const line = (x1, y1, x2, y2, {thickness = 8, color = LINE_COLOR} = {}) => shape({
	x: (x1 + x2) / 2, y: (y1 + y2) / 2,
	width: Math.max(thickness, Math.abs(x2 - x1)), height: Math.max(thickness, Math.abs(y2 - y1)),
	fillColor: color
});

/**
 * @param {string} layout
 * @param {object} input miro-layout.js の loadInput() と同じ形(ボードに出ている資料だけにしてから渡す)
 * @param {{geometry: {itemWidth: number, gapX: number, gapY: number, captionHeight: number, padding: number, headerHeight: number, defaultAspect: number},
 *          sizes?: Map<string, {width: number, height: number}>, projectUrl?: ?string}} options
 */
module.exports.buildPlan = (layout, input, {geometry, sizes = new Map(), projectUrl = null, previous = null} = {}) => {
	const report = MiroLayout.buildReport(layout, input, {previous});
	const G = geometry;
	const W = G.itemWidth;
	const cw = W + G.gapX;
	const defaultHeight = W * G.defaultAspect;
	const heightOf = (documentId) => Number(sizes.get(documentId)?.height) || defaultHeight;
	// カード 1 段分の高さ(見出しと段の間を含む)
	const lineHeight = (ids) => Math.max(...ids.map(heightOf), 1) + G.captionHeight + G.gapY;
	const fixedLine = defaultHeight + G.captionHeight + G.gapY;
	const items = [];
	// 区画の範囲(枠の左上から。LLM が置き場所を考えるときの地図に使う)
	const areas = [];
	const addArea = (id, title, left, top, right, bottom) => areas.push({
		id, title, left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(Math.max(top, bottom))
	});
	const labels = [];
	const shapes = [];
	const placedIds = new Set();
	const put = (documentId, x, y, color) => {
		items.push({documentId, x, y, color: color ?? null});
		placedIds.add(documentId);
	};
	/** 左上(x0, y0)から、columns 枚ずつ折り返して置く。置いた下端(次に置ける y)を返す */
	const grid = (ids, x0, y0, columns, colorOf = () => null) => {
		let y = y0;
		for (let i = 0; i < ids.length; i += columns) {
			const row = ids.slice(i, i + columns);
			row.forEach((id, index) => put(id, x0 + index * cw + W / 2, y + heightOf(id) / 2, colorOf(id)));
			y += lineHeight(row);
		}
		return y;
	};
	/** 「ほか n 件」のカード(資料ではなく Document Manager が置く図形。プロジェクトの画面へのリンク) */
	const overflowCard = (x, y, count) => shapes.push(shape({
		x, y, width: W, height: Math.min(defaultHeight, 240), kind: "round_rectangle",
		text: `ほか ${count} 件`, fillColor: "#ffffff", borderColor: "#888888", borderWidth: 2, borderStyle: "dashed", link: projectUrl
	}));
	const placementsIn = (area) => report.placements.filter((p) => p.area === area);
	const meetingColor = (p) => (p.slot === "会議:定例" ? COLORS.green : COLORS.orange);
	const byId = new Map(report.placements.map((p) => [p.documentId, p]));
	const hidden = new Set((report.overflow ?? []).flatMap((o) => o.documentIds));
	let contentRight = 0;

	/** 枠の下の段(管理 → 会議 → 未分類 → ほか n 件の中身)。列の数は枠の幅に合わせる */
	const bottomStrips = (top, width, strips) => {
		const columns = Math.max(4, Math.floor((width - G.padding * 2 + G.gapX) / cw));
		let y = top;
		for (const strip of strips) {
			if (strip.ids.length === 0 && !strip.always) continue;
			const stripTop = y;
			labels.push(label(strip.title, G.padding + (width - G.padding * 2) / 2, y + G.headerHeight / 2, width - G.padding * 2, {fontSize: strip.small ? null : 36}));
			y += G.headerHeight;
			y = strip.ids.length === 0 ? y + 120 : grid(strip.ids, G.padding, y, columns, strip.colorOf);
			addArea(`strip:${strip.title}`, strip.title, G.padding, stripTop, width - G.padding, y - G.gapY);
		}
		return y;
	};
	const overflowStrips = () => (report.overflow ?? []).map((o) => ({
		title: `${o.slot ? o.slot : AREA_TITLES[o.area] ?? o.area} のほか ${o.count} 件`,
		ids: o.documentIds,
		colorOf: (id) => colorOfPlacement(byId.get(id)),
		small: true
	}));
	let colorOfPlacement = () => null;
	let width = 0;
	let height = 0;

	if (layout === "custom") {
		// ユーザーカスタム: 前に置いた資料はその場所のまま(Document Manager は動かさない)。
		// 新しい資料は、いまある資料の下に 6 枚ずつ並べて足す(置き場所は AI に指示して決めてもらう)。見出しの色は変えない
		const columns = 6;
		let right = G.padding;
		let bottom = G.padding;
		const fresh = [];
		for (const p of report.placements) {
			const before = previous?.get(p.documentId);
			if (before == null) {
				fresh.push(p.documentId);
				continue;
			}
			items.push({documentId: p.documentId, x: before.x, y: before.y, color: undefined});
			placedIds.add(p.documentId);
			right = Math.max(right, before.x + W / 2);
			bottom = Math.max(bottom, before.y + heightOf(p.documentId) / 2 + G.captionHeight + G.gapY);
		}
		let y = previous != null && placedIds.size > 0 ? bottom : G.padding;
		for (let i = 0; i < fresh.length; i += columns) {
			const row = fresh.slice(i, i + columns);
			row.forEach((id, index) => {
				items.push({documentId: id, x: G.padding + index * cw + W / 2, y: y + heightOf(id) / 2, color: undefined});
				placedIds.add(id);
			});
			right = Math.max(right, G.padding + row.length * cw - G.gapX);
			y += lineHeight(row);
		}
		width = Math.max(right + G.padding, G.padding * 2 + columns * cw - G.gapX);
		height = Math.max(Math.max(y, bottom) - G.gapY + G.padding, 600);
	} else if (layout === "folder-columns") {
		const colWidth = 2 * W + G.gapX;
		const colGap = 120;
		const columns = [];
		for (const p of report.placements) {
			let column = columns.find((c) => c.name === p.area && c.folderId === (p.folderId ?? null));
			if (column == null) {
				column = {name: p.area, folderId: p.folderId ?? null, placements: []};
				columns.push(column);
			}
			column.placements.push(p);
		}
		// 列の中は、そのフォルダの直下の資料 → 下の階層(▼ の小見出しごと)の順。下の階層の中はおしながき順のまま
		for (const column of columns) {
			const order = [null, ...new Set(column.placements.map((p) => p.slot).filter((slot) => slot != null))];
			column.placements = order.flatMap((slot) => column.placements.filter((p) => p.slot === slot));
		}
		let bottom = G.padding;
		columns.forEach((column, index) => {
			const left = G.padding + index * (colWidth + colGap);
			let y = G.padding;
			labels.push(label(`■ ${column.name}`, left + colWidth / 2, y + G.headerHeight / 2, colWidth));
			y += G.headerHeight;
			let i = 0;
			while (i < column.placements.length) {
				const slot = column.placements[i].slot;
				const group = [];
				while (i < column.placements.length && column.placements[i].slot === slot) group.push(column.placements[i++].documentId);
				if (slot) {
					labels.push(label(`▼ ${slot}`, left + colWidth / 2, y + G.headerHeight / 2, colWidth, {bold: false}));
					y += G.headerHeight;
				}
				y = grid(group, left, y, 2);
			}
			bottom = Math.max(bottom, y);
			addArea(`column:${column.name}`, `■ ${column.name}`, left, G.padding, left + colWidth, y - G.gapY);
		});
		width = G.padding * 2 + Math.max(1, columns.length) * colWidth + Math.max(0, columns.length - 1) * colGap;
		height = bottom - G.gapY + G.padding;
	} else if (layout === "timeline") {
		const perRow = MiroLayout.RULES.timelinePerRow;
		const labelWidth = 220;
		const x0 = G.padding + labelWidth;
		width = x0 + perRow * cw - G.gapX + G.padding;
		const colorHex = {purple: COLORS.purple, pink: COLORS.pink, gray: COLORS.gray, green: COLORS.green, orange: COLORS.orange};
		let y = G.padding;
		const months = Object.keys(report.summary.areas);
		const colorOf = (id) => colorHex[byId.get(id).color] ?? null;
		const rowsOf = [];
		months.forEach((month) => {
			const ids = placementsIn(month).map((p) => p.documentId);
			labels.push(label(month, G.padding + labelWidth / 2, y + 40, labelWidth - 20, {fontSize: 36}));
			// どの月も 7 枚で折り返す(連動で足すときは、空いていればここ、無ければ枠の下。miro-sync.js が決める)
			const bottom = ids.length === 0 ? y + 200 : grid(ids, x0, y, perRow, colorOf);
			rowsOf.push({month, top: y, bottom});
			y = bottom;
		});
		for (const row of rowsOf) addArea(`month:${row.month}`, row.month, G.padding, row.top, width - G.padding, row.bottom - G.gapY / 2);
		// 月の区切りの線は、いちばん長い行に合わせる
		for (const {bottom} of rowsOf) shapes.push(line(G.padding, bottom - G.gapY / 2, width - G.padding, bottom - G.gapY / 2, {color: "#dddddd"}));
		height = Math.max(y - G.gapY + G.padding, 600);
	} else if (layout === "split-shelves") {
		const leftColumns = 3;
		const perRow = MiroLayout.RULES.shelfPerRow;
		const leftWidth = leftColumns * cw - G.gapX;
		const divider = G.padding + leftWidth + 100;
		const rightLeft = divider + 100;
		const rightWidth = perRow * cw - G.gapX;
		width = rightLeft + rightWidth + G.padding;
		const shelfColor = (name) => (name === "準備" ? COLORS.purple : name === "実施後" ? COLORS.after : COLORS.pink);
		colorOfPlacement = (p) => (p.area === "left" ? COLORS.gray : p.area === "shelf" ? shelfColor(p.slot.replace(/^段階:/, "")) : p.area === "meeting" ? meetingColor(p) : null);
		let leftY = G.padding;
		labels.push(label(AREA_TITLES.left, G.padding + leftWidth / 2, leftY + G.headerHeight / 2, leftWidth, {fontSize: 36}));
		leftY = grid(placementsIn("left").map((p) => p.documentId), G.padding, leftY + G.headerHeight, leftColumns, () => COLORS.gray);
		addArea("left", AREA_TITLES.left, G.padding, G.padding, G.padding + leftWidth, leftY - G.gapY);
		let rightY = G.padding;
		labels.push(label("右半分: 棚(準備 → 実施 → 実施後)", rightLeft + rightWidth / 2, rightY + G.headerHeight / 2, rightWidth, {fontSize: 36}));
		rightY += G.headerHeight;
		const shelves = [
			...(report.shelves ?? []).map((name) => ({title: name, ids: placementsIn("shelf").filter((p) => p.slot === `段階:${name}`).map((p) => p.documentId)})),
			{title: "会議", ids: placementsIn("meeting").map((p) => p.documentId)},
			{title: "未分類", ids: placementsIn("unclassified").map((p) => p.documentId)}
		];
		for (const shelf of shelves) {
			if (shelf.ids.length === 0) continue;
			labels.push(label(shelf.title, rightLeft + rightWidth / 2, rightY + G.headerHeight / 2, rightWidth, {bold: true}));
			const shelfTop = rightY;
			rightY = grid(shelf.ids, rightLeft, rightY + G.headerHeight, perRow, (id) => colorOfPlacement(byId.get(id)));
			addArea(`shelf:${shelf.title}`, `棚: ${shelf.title}`, rightLeft, shelfTop, rightLeft + rightWidth, rightY - G.gapY / 2);
			// 棚の板
			shapes.push(line(rightLeft, rightY - G.gapY / 2, rightLeft + rightWidth, rightY - G.gapY / 2, {thickness: 10}));
		}
		const bottom = Math.max(leftY, rightY);
		shapes.push(line(divider, G.padding, divider, bottom - G.gapY));
		height = Math.max(bottom - G.gapY + G.padding, 600);
	} else if (layout === "quadrant-cross") {
		colorOfPlacement = (p) => ({upper_left: COLORS.purple, lower_left: COLORS.pink, upper_right: COLORS.gray}[p.area] ?? (p.area === "lower_right" ? meetingColor(p) : null));
		const stepCapacity = MiroLayout.RULES.crossStepCapacity;
		const stepLabel = 60;
		// 区画の見出しは十字の中心の周りに、外向きの矢印を付けて置く(どちらに何があるか分かるように)。
		// そのため横線の上下に帯を空ける(見出しと中心の概要カードが資料と重ならないように)
		const band = 170;
		const areaLabelOffset = 105;
		const areaLabelWidth = 900;
		const areaLabelStyle = {fontSize: 40, color: "#1e3a8a"};
		const stepHeight = stepLabel + fixedLine;
		const upperLeftWidth = (stepCapacity + 2) * cw - G.gapX;
		const upperRightColumns = 3;
		const upperRightWidth = upperRightColumns * cw - G.gapX;
		const upperHeight = 3 * stepHeight;
		const cx = G.padding + upperLeftWidth + 100;
		const rightLeft = cx + 100;
		// 横線の位置は、上の 2 区画を置いてから決める(縦長の資料で段が高くなることがあるため)
		let cy = G.padding + upperHeight - G.gapY + band;
		let lowerTop = cy + band;
		const colorOf = (id) => colorOfPlacement(byId.get(id));

		// 左上: 中心へ下りる階段(要件定義 → 基本設計 → 詳細設計)。段の大きさは固定で、入りきらない分は「ほか n 件」
		const stepRows = (steps, top, offsets, fixed) => {
			let y = top;
			steps.forEach((step, index) => {
				const left = G.padding + offsets[index] * cw;
				const entries = report.placements.filter((p) => p.step === step);
				labels.push(label(step, left + (stepCapacity * cw) / 2, y + stepLabel / 2, stepCapacity * cw - G.gapX, {bold: true}));
				const shown = entries.filter((p) => !hidden.has(p.documentId)).map((p) => p.documentId);
				if (fixed) {
					shown.forEach((id, i) => put(id, left + i * cw + W / 2, y + stepLabel + heightOf(id) / 2, colorOf(id)));
					const overflow = (report.overflow ?? []).find((o) => o.slot === `工程:${step}`);
					if (overflow) overflowCard(left + shown.length * cw + W / 2, y + stepLabel + Math.min(defaultHeight, 240) / 2, overflow.count);
					// 枚数は固定。縦長の資料(画像など)があるときだけ、その段を高くする(重ならないように)
					y += stepLabel + Math.max(fixedLine, lineHeight(shown));
				} else {
					// 資料の無い工程は、見出しの分だけ空ける(下へ伸ばす区画なので、空の段で間延びさせない)
					y = shown.length === 0 ? y + stepLabel + 120 : grid(shown, left, y + stepLabel, stepCapacity, colorOf);
				}
			});
			return y;
		};
		const upperLeftBottom = stepRows(["要件定義", "基本設計", "詳細設計"], G.padding, [0, 1, 2], true);
		// 右上: 管理系の格子(大きさ固定)
		const upperRight = placementsIn("upper_right").filter((p) => !hidden.has(p.documentId)).map((p) => p.documentId);
		const rightOverflow = (report.overflow ?? []).find((o) => o.area === "upper_right");
		let upperRightY = G.padding;
		for (let i = 0; i < upperRight.length + (rightOverflow ? 1 : 0); i += upperRightColumns) {
			const row = upperRight.slice(i, i + upperRightColumns);
			row.forEach((id, index) => put(id, rightLeft + index * cw + W / 2, upperRightY + heightOf(id) / 2, COLORS.gray));
			if (rightOverflow && row.length < upperRightColumns) overflowCard(rightLeft + row.length * cw + W / 2, upperRightY + Math.min(defaultHeight, 240) / 2, rightOverflow.count);
			upperRightY += Math.max(fixedLine, lineHeight(row));
		}

		cy = Math.max(cy, upperLeftBottom - G.gapY + band, upperRightY - G.gapY + band);
		lowerTop = cy + band;
		// 区画の見出し: 中心の縦線をはさんで、左は右寄せ・右は左寄せ。横線のすぐ上と下
		const leftOfCentre = cx - 40 - areaLabelWidth / 2;
		const rightOfCentre = cx + 40 + areaLabelWidth / 2;
		labels.push(label(`↖ ${AREA_TITLES.upper_left}`, leftOfCentre, cy - areaLabelOffset, areaLabelWidth, {...areaLabelStyle, align: "right"}));
		labels.push(label(`${AREA_TITLES.upper_right} ↗`, rightOfCentre, cy - areaLabelOffset, areaLabelWidth, {...areaLabelStyle, align: "left"}));
		labels.push(label(`↙ ${AREA_TITLES.lower_left}`, leftOfCentre, cy + areaLabelOffset, areaLabelWidth, {...areaLabelStyle, align: "right"}));
		// 左下: 横線で上下対称に、中心から外へ戻る階段(単体テスト → 結合テスト → 受入テスト → リリース → 運用)。下へ伸びる
		const lowerLeftBottom = stepRows(["単体テスト", "結合テスト", "受入テスト", "リリース", "運用"], lowerTop, [2, 1, 0, 0, 0], false);

		// 右下: 縦 = 週(古い週が上)、横 = 月〜金(土日に会議があれば列を足す)。同じ日は縦に重ねる
		const meetings = placementsIn("lower_right");
		const weekend = meetings.some((p) => p.weekday === "土" || p.weekday === "日");
		const days = weekend ? ["月", "火", "水", "木", "金", "土", "日"] : ["月", "火", "水", "木", "金"];
		const weekLabel = 200;
		const lowerRightWidth = weekLabel + days.length * cw - G.gapX;
		labels.push(label(`${AREA_TITLES.lower_right}(週 × 曜日) ↘`, rightOfCentre, cy + areaLabelOffset, areaLabelWidth, {...areaLabelStyle, align: "left"}));
		const dayTop = lowerTop;
		days.forEach((day, i) => labels.push(label(day, rightLeft + weekLabel + i * cw + W / 2, dayTop + 30, W, {align: "center"})));
		let y = dayTop + 70;
		const weeks = [];
		if ((report.weeks ?? []).length > 0) {
			const first = new Date(`${report.weeks[0]}T00:00:00Z`);
			const last = new Date(`${report.weeks[report.weeks.length - 1]}T00:00:00Z`);
			for (let t = first.getTime(); t <= last.getTime(); t += 7 * 86400000) weeks.push(new Date(t).toISOString().slice(0, 10));
		}
		for (const week of weeks) {
			labels.push(label(`${week.slice(5).replace("-", "/")} の週`, rightLeft + weekLabel / 2, y + 30, weekLabel - 20, {bold: false}));
			let rowBottom = y + 200;
			days.forEach((day, i) => {
				let cellY = y;
				for (const p of meetings.filter((m) => m.week === week && m.weekday === day)) {
					put(p.documentId, rightLeft + weekLabel + i * cw + W / 2, cellY + heightOf(p.documentId) / 2, meetingColor(p));
					cellY += heightOf(p.documentId) + G.captionHeight + G.gapY;
				}
				rowBottom = Math.max(rowBottom, cellY);
			});
			y = rowBottom;
		}
		const lowerRightBottom = y;

		// 十字の線と、中心のプロジェクトの概要カード
		const right = rightLeft + Math.max(upperRightWidth, lowerRightWidth);
		const lowerBottom = Math.max(lowerLeftBottom, lowerRightBottom, lowerTop + 400);
		shapes.push(line(cx, G.padding, cx, lowerBottom));
		addArea("upper_left", AREA_TITLES.upper_left, G.padding, G.padding, cx, cy);
		addArea("upper_right", AREA_TITLES.upper_right, cx, G.padding, right, cy);
		addArea("lower_left", AREA_TITLES.lower_left, G.padding, cy, cx, lowerBottom);
		addArea("lower_right", AREA_TITLES.lower_right, cx, cy, right, lowerBottom);
		shapes.push(line(G.padding, cy, right, cy));
		const total = input.documents.length;
		const latest = input.documents.map((d) => String(d.modified ?? "")).sort().pop()?.slice(0, 10) ?? "";
		labels.push(label(`${input.project?.name ?? ""} / 資料 ${total} 件${latest ? ` / 最終更新 ${latest}` : ""}`, cx, cy, 640,
			{fontSize: 28, fillColor: "#ffffff", align: "center", link: projectUrl}));

		width = right + G.padding;
		contentRight = width;
		const stripsTop = lowerBottom + 120;
		const bottom = bottomStrips(stripsTop, width, [
			{title: AREA_TITLES.unclassified, ids: placementsIn("unclassified").map((p) => p.documentId)},
			...overflowStrips()
		]);
		height = Math.max(bottom - G.gapY + G.padding, lowerBottom + G.padding);
	} else if (layout === "matrix") {
		colorOfPlacement = (p) => (p.area === "table" ? COLORS.purple : p.area === "management" ? COLORS.gray : p.area === "meeting" ? meetingColor(p) : null);
		const featureWidth = 300;
		const cellWidth = 2 * cw;
		const headerHeight = 80;
		const features = report.features ?? [];
		const processes = report.processes ?? [];
		const left0 = G.padding + featureWidth;
		const top0 = G.padding + headerHeight;
		labels.push(label("機能 \\ 工程", G.padding + featureWidth / 2, G.padding + headerHeight / 2, featureWidth - 20));
		processes.forEach((process, c) => labels.push(label(process, left0 + c * cellWidth + cellWidth / 2, G.padding + headerHeight / 2, cellWidth - G.gapX, {align: "center"})));
		// 行の高さは変えない(縦長の資料があるときだけ、その行を高くする)
		let top = top0;
		features.forEach((feature) => {
			const rowIds = report.placements.filter((p) => p.area === "table" && p.feature === feature && !hidden.has(p.documentId)).map((p) => p.documentId);
			const rowHeight = Math.max(fixedLine, lineHeight(rowIds));
			labels.push(label(feature, G.padding + featureWidth / 2, top + rowHeight / 2, featureWidth - 20));
			processes.forEach((process, c) => {
				const left = left0 + c * cellWidth;
				const cellCentre = {x: left + cellWidth / 2 - G.gapX / 2, y: top + (rowHeight - G.gapY) / 2};
				addArea(`cell:機能:${feature} × 工程:${process}`, `機能:${feature} × 工程:${process}`, left, top, left + cellWidth - G.gapX, top + rowHeight - G.gapY);
				const excluded = (report.excludedCells ?? []).some((e) => e.feature === feature && e.process === process);
				const entries = report.placements.filter((p) => p.area === "table" && p.feature === feature && p.process === process);
				if (entries.length === 0) {
					shapes.push(excluded
						? shape({...cellCentre, width: cellWidth - G.gapX, height: rowHeight - G.gapY, text: "対象外", fillColor: "#e5e7eb", fillOpacity: 1})
						: shape({...cellCentre, width: cellWidth - G.gapX, height: rowHeight - G.gapY, text: "無し", fillOpacity: 0, borderColor: "#dc2626", borderWidth: 2, borderStyle: "dashed"}));
					return;
				}
				const shown = entries.filter((p) => !hidden.has(p.documentId));
				shown.forEach((p, i) => put(p.documentId, left + i * cw + W / 2, top + heightOf(p.documentId) / 2, COLORS.purple));
				const overflow = (report.overflow ?? []).find((o) => o.slot === `機能:${feature} × 工程:${process}`);
				if (overflow) overflowCard(left + shown.length * cw + W / 2, top + Math.min(defaultHeight, 240) / 2, overflow.count);
			});
			shapes.push(line(G.padding, top + rowHeight - G.gapY / 2, left0 + processes.length * cellWidth - G.gapX, top + rowHeight - G.gapY / 2, {color: "#dddddd"}));
			top += rowHeight;
		});
		width = Math.max(left0 + processes.length * cellWidth - G.gapX + G.padding, G.padding * 2 + 4 * cw);
		const tableBottom = top;
		addArea("table", "表(行 = 機能、列 = 工程)", G.padding, G.padding, left0 + processes.length * cellWidth - G.gapX, tableBottom - G.gapY);
		const bottom = bottomStrips(tableBottom + 80, width, [
			{title: AREA_TITLES.management, ids: placementsIn("management").map((p) => p.documentId), colorOf: () => COLORS.gray},
			{title: AREA_TITLES.meeting, ids: placementsIn("meeting").map((p) => p.documentId), colorOf: (id) => meetingColor(byId.get(id))},
			{title: AREA_TITLES.unclassified, ids: placementsIn("unclassified").map((p) => p.documentId)},
			...overflowStrips()
		]);
		height = Math.max(bottom - G.gapY + G.padding, 600);
	}

	// 区画に置けなかった資料が残らないように(念のため。どの型でも全部の資料をどこかに置く)
	const leftovers = input.documents.map((d) => d.documentId).filter((id) => !placedIds.has(id));
	if (leftovers.length > 0) {
		const top = height - G.padding + G.gapY;
		const bottom = bottomStrips(top, Math.max(width, contentRight), [{title: "そのほか", ids: leftovers}]);
		height = bottom - G.gapY + G.padding;
	}
	return {items, labels, shapes, areas, frame: {width: Math.ceil(width), height: Math.ceil(height)}, report};
};
