/*!
 * miro-layout-preview.js : 並べ方の型の見本の図(SVG)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * プロジェクトの Miro の画面で型を選ぶときに、「どう並ぶか」が分かるよう見本の図を出す。
 * 図は手で描かず、見本の資料を実際の並べ方(miro-layout-plan.js)にかけて描く。
 * 並べ方を直せば図も一緒に変わる(図と実際がずれない)。
 *
 * 見本の資料は固定なので、型ごとに 1 回だけ作ってメモリに置く。
 */

const MiroLayout = require("./miro-layout.js");
const MiroLayoutPlan = require("./miro-layout-plan.js");

// miro-sync.js の LAYOUT と同じ大きさ(図の縮尺を実物に合わせる)
const GEOMETRY = Object.freeze({itemWidth: 360, gapX: 60, gapY: 60, captionHeight: 80, padding: 80, headerHeight: 70, defaultAspect: 297 / 210});

// 見本の資料。どの型でも区画が埋まるよう、フォルダ・タグ・日付を散らしてある
const sampleDocuments = () => {
	let seq = 0;
	const doc = (entryFile, extra = {}) => ({
		documentId: `sample-${++seq}`, entryFile, modified: "2026-10-10T03:00:00.000Z", tags: [], folderNames: [], topFolder: null, subFolders: [], ...extra
	});
	const req = {id: "f-req", name: "要件"};
	const design = {id: "f-design", name: "設計"};
	const test = {id: "f-test", name: "テスト"};
	const manage = {id: "f-manage", name: "管理"};
	return [
		doc("要件定義書 2026-07-03.pdf", {tags: ["工程:要件定義", "機能:認証", "段階:準備"], topFolder: req}),
		doc("業務フロー 2026-07-10.pdf", {tags: ["工程:要件定義", "機能:検索", "段階:準備"], topFolder: req}),
		doc("基本設計書 2026-08-22.pdf", {tags: ["工程:基本設計", "機能:認証", "段階:準備"], topFolder: design}),
		doc("画面設計 2026-09-02.pdf", {tags: ["工程:詳細設計", "機能:検索", "段階:実施"], topFolder: design, subFolders: ["画面"]}),
		doc("API 仕様 2026-09-24.pdf", {tags: ["工程:詳細設計", "機能:認証", "段階:実施"], topFolder: design}),
		doc("DB 設計 2026-09-11.pdf", {tags: ["工程:詳細設計", "機能:検索", "段階:実施"], topFolder: design}),
		doc("単体テスト結果 2026-10-02.pdf", {tags: ["工程:単体テスト", "機能:認証", "段階:実施"], topFolder: test}),
		doc("結合テスト仕様 2026-10-06.pdf", {tags: ["工程:結合テスト", "機能:検索", "段階:実施"], topFolder: test}),
		doc("リリース手順 2026-10-14.pdf", {tags: ["工程:リリース", "機能:認証", "段階:実施後"], topFolder: test}),
		doc("計画書 2026-07-01.pdf", {tags: ["区分:管理"], topFolder: manage}),
		doc("体制図 2026-07-02.pdf", {tags: ["区分:管理"], topFolder: manage}),
		doc("WBS 2026-08-12.pdf", {tags: ["区分:管理"], topFolder: manage}),
		doc("課題一覧 2026-09-16.pdf", {tags: ["区分:管理"], topFolder: manage}),
		doc("定例 2026-09-28.pdf", {tags: ["区分:会議", "会議:定例"], topFolder: manage, subFolders: ["会議"]}),
		doc("設計レビュー 2026-10-01.pdf", {tags: ["区分:会議"], topFolder: manage, subFolders: ["会議"]}),
		doc("定例 2026-10-05.pdf", {tags: ["区分:会議", "会議:定例"], topFolder: manage, subFolders: ["会議"]}),
		doc("定例 2026-10-12.pdf", {tags: ["区分:会議", "会議:定例"], topFolder: manage, subFolders: ["会議"]}),
		doc("メモ 2026-08-05.pdf")
	];
};

// 縮めて見せるので、見出しの色は実物より濃くする(淡い色のままだと小さい図では見分けられない)
const PREVIEW_COLORS = Object.freeze({
	[MiroLayoutPlan.COLORS.purple]: "#a8a3f0",
	[MiroLayoutPlan.COLORS.pink]: "#f1a7c3",
	[MiroLayoutPlan.COLORS.gray]: "#cbc4b1",
	[MiroLayoutPlan.COLORS.green]: "#8fd8b8",
	[MiroLayoutPlan.COLORS.orange]: "#f3b39e",
	[MiroLayoutPlan.COLORS.after]: "#f0c47e"
});

const escapeXml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));

/** 計算した並べ方を SVG にする。資料は白い紙と色の帯(見出しの色)、区画の見出しと線はそのまま */
const toSvg = (plan) => {
	const {width, height} = plan.frame;
	const H = GEOMETRY.itemWidth * GEOMETRY.defaultAspect;
	const parts = [];
	parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" stroke="#cbd5e1" stroke-width="12" rx="24"/>`);
	for (const s of plan.shapes) {
		const dash = s.borderStyle === "dashed" ? ' stroke-dasharray="24 14"' : "";
		const stroke = s.borderColor ? ` stroke="${escapeXml(s.borderColor)}" stroke-width="${(s.borderWidth ?? 1) * 3}"${dash}` : "";
		if (s.shape === "right_arrow") {
			const l = s.x - s.width / 2;
			const r = s.x + s.width / 2;
			const t = s.y - s.height / 2;
			const b = s.y + s.height / 2;
			const head = r - s.height * 0.6;
			parts.push(`<polygon points="${l},${t + s.height * 0.25} ${head},${t + s.height * 0.25} ${head},${t} ${r},${s.y} ${head},${b} ${head},${b - s.height * 0.25} ${l},${b - s.height * 0.25}" fill="${escapeXml(s.fillColor ?? "#94a3b8")}"/>`);
			continue;
		}
		parts.push(`<rect x="${s.x - s.width / 2}" y="${s.y - s.height / 2}" width="${s.width}" height="${s.height}" rx="${s.shape === "round_rectangle" ? 24 : 0}" fill="${escapeXml(s.fillColor ?? "none")}" fill-opacity="${s.fillOpacity ?? 1}"${stroke}/>`);
		if (s.text) parts.push(`<text x="${s.x}" y="${s.y + 18}" font-size="56" text-anchor="middle" fill="#475569">${escapeXml(s.text)}</text>`);
	}
	for (const item of plan.items) {
		const left = item.x - GEOMETRY.itemWidth / 2;
		const top = item.y - H / 2;
		parts.push(`<rect x="${left}" y="${top}" width="${GEOMETRY.itemWidth}" height="${H}" fill="#f8fafc" stroke="#94a3b8" stroke-width="6"/>`);
		for (let i = 0; i < 4; i++) parts.push(`<rect x="${left + 50}" y="${top + 80 + i * 90}" width="${i === 3 ? 160 : 260}" height="24" fill="#e2e8f0"/>`);
		parts.push(`<rect x="${left}" y="${top + H}" width="${GEOMETRY.itemWidth}" height="70" fill="${escapeXml(PREVIEW_COLORS[item.color] ?? item.color ?? "#ffffff")}" stroke="#cbd5e1" stroke-width="4"/>`);
	}
	for (const l of plan.labels) {
		const anchor = l.align === "center" ? "middle" : l.align === "right" ? "end" : "start";
		const x = l.align === "center" ? l.x : l.align === "right" ? l.x + l.width / 2 : l.x - l.width / 2;
		// 区画の見出し(大きい文字)は、縮めても読めるようにさらに大きくする
		const size = (l.fontSize ?? 34) >= 36 ? l.fontSize * 2 : (l.fontSize ?? 34) * 1.4;
		// 改行のある見出し(十字型の中心の概要)は、行ごとに描く
		const lines = String(l.text).split("\n");
		const lineHeight = size * 1.3;
		const top = l.y - (lines.length - 1) * lineHeight / 2;
		if (l.fillColor) parts.push(`<rect x="${l.x - l.width / 2}" y="${top - size}" width="${l.width}" height="${(lines.length - 1) * lineHeight + size * 2}" fill="${escapeXml(l.fillColor)}" stroke="#334155" stroke-width="4" rx="8"/>`);
		parts.push(`<text x="${x}" y="${top + size / 3}" font-size="${size}" font-weight="${l.bold ? 700 : 400}" text-anchor="${anchor}" fill="${escapeXml(l.color ?? "#1e293b")}">`
			+ lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("") + `</text>`);
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 ${width + 40} ${height + 40}" font-family="sans-serif">${parts.join("")}</svg>`;
};

/**
 * ユーザーカスタムの見本(型どおりの並びが無いので、手で組む)。AI に指示して置いた資料・囲み・矢印・見出しの例
 */
const customSample = () => {
	const C = MiroLayoutPlan.COLORS;
	const label = (text, x, y, width, extra = {}) => ({text, x, y, width, fontSize: null, color: null, fillColor: null, bold: true, align: "left", ...extra});
	const shape = (extra) => ({shape: "rectangle", text: "", fillColor: null, fillOpacity: null, borderColor: null, borderWidth: null, borderStyle: null, ...extra});
	return {
		frame: {width: 2400, height: 2000},
		items: [
			{x: 340, y: 520, color: C.purple}, {x: 760, y: 520, color: C.purple},
			{x: 1500, y: 640, color: C.pink}, {x: 1980, y: 820, color: null},
			{x: 520, y: 1480, color: C.gray}, {x: 1300, y: 1500, color: C.green}
		].map((item, i) => ({documentId: `custom-${i}`, ...item})),
		labels: [
			label("AI に指示して自由に配置", 1200, 110, 2200, {fontSize: 60, color: "#1e3a8a", align: "center"}),
			label("まとめ", 300, 200, 400, {fontSize: 40, color: "#b91c1c"}),
			label("「設計の横に置いて」など", 1960, 1260, 700, {fontSize: 40, color: "#475569"})
		],
		shapes: [
			shape({x: 550, y: 560, width: 940, height: 640, fillOpacity: 0, borderColor: "#dc2626", borderWidth: 3, borderStyle: "dashed"}),
			shape({shape: "right_arrow", x: 1130, y: 600, width: 180, height: 90, fillColor: "#94a3b8"})
		],
		areas: []
	};
};

const cache = new Map();
/**
 * 型の見本の図(SVG の文字列)
 * @param {string} layout MiroLayout.LAYOUT_IDS のどれか
 */
module.exports.previewSvg = (layout) => {
	if (!MiroLayout.LAYOUT_IDS.includes(layout)) return null;
	if (!cache.has(layout)) {
		const plan = layout === "custom" ? customSample() : MiroLayoutPlan.buildPlan(layout, {project: {id: "sample", name: "見本のプロジェクト", description: "受注管理システムの再構築(2026 年度)"}, documents: sampleDocuments(), featureOrder: []},
			{geometry: GEOMETRY});
		cache.set(layout, toSvg(plan));
	}
	return cache.get(layout);
};
