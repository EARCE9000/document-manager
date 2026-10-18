/*!
 * miro-layout.js : Miro に書き出すときの「十字」の振り分け(どの資料を左上・右上・左下・右下のどこに出すか)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 決まりは docs/miro.md の「十字」。ここは**どこに出すか**を決めるだけで、Miro には触らない。
 * 同じ振り分けを、LLM がタグを見直すための報告(layout-report)と、書き出す処理(miro-export.js)の両方で使う
 * (片方だけ直して食い違う、を防ぐ)。
 *
 * ---- 十字の 4 つの区画 ----
 *   upper_left   要件定義〜設計(工程のタグ)
 *   lower_left   テスト〜運用(工程のタグ)
 *   upper_right  管理(区分:管理)
 *   lower_right  会議(区分:会議・会議:)。日付順
 *   unclassified どれにも当たらない資料
 *
 * ---- タグ ----
 * 今のタグと同じ文字列(例 `区分:管理`)。`:` より前を見出し、後ろを値として読む。値は TAG_VALUES だけを正とする。
 * タグが無いときは、題名(ファイル名)とフォルダ名の言葉から推定する。推定はタグとして保存せず、書き出すときにだけ使う。
 */

const path = require("path");

// 十字の区画の名前(書き出すフレームの名前・報告に使う)
const CROSS_AREAS = Object.freeze(["upper_left", "upper_right", "lower_left", "lower_right", "unclassified"]);
const CROSS_AREA_TITLES = Object.freeze({
	upper_left: "要件定義〜設計",
	upper_right: "管理",
	lower_left: "テスト〜リリース",
	lower_right: "会議",
	unclassified: "未分類"
});
module.exports.CROSS_AREAS = CROSS_AREAS;
module.exports.CROSS_AREA_TITLES = CROSS_AREA_TITLES;

const positiveNumber = (value, fallback) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : fallback;
};

const RULES = Object.freeze({
	// 未分類がこの割合を超えたら、十字で書き出す前に LLM でタグを見直す
	reviewRatio: positiveNumber(process.env.MIRO_LAYOUT_REVIEW_RATIO, 0.3)
});
module.exports.RULES = RULES;

// ---- 共通のタグ(docs/miro.md の「十字」のタグ) ----
const PROCESSES = Object.freeze(["要件定義", "基本設計", "詳細設計", "実装", "単体テスト", "結合テスト", "受入テスト", "リリース", "運用"]);
const TAG_VALUES = Object.freeze({
	"区分": Object.freeze(["管理", "会議"]),
	"工程": PROCESSES,
	"段階": Object.freeze(["準備", "実施", "実施後"]),
	"会議": Object.freeze(["定例", "臨時"]),
	"対象外": PROCESSES
});
const HEADINGS = Object.freeze(["区分", "工程", "段階", "機能", "会議", "対象外"]);
module.exports.TAG_VALUES = TAG_VALUES;
module.exports.HEADINGS = HEADINGS;

/** タグ体系(/api/tag_order)に登録する値。機能: はプロジェクトごとに決めるので入れない */
module.exports.commonTags = () => ["区分", "工程", "段階", "会議"].flatMap((heading) => TAG_VALUES[heading].map((value) => `${heading}:${value}`));

// 十字型の左上(要件定義〜実装)と左下(単体テスト〜運用)。時系列型の色(紫 設計・桃 テスト)にも使う
const UPPER_PROCESSES = Object.freeze(["要件定義", "基本設計", "詳細設計", "実装"]);
// 十字型の段。工程:実装 は詳細設計の段、工程:運用 はリリースの下の段
const CROSS_STEP_OF = Object.freeze({"要件定義": "要件定義", "基本設計": "基本設計", "詳細設計": "詳細設計", "実装": "詳細設計",
	"単体テスト": "単体テスト", "結合テスト": "結合テスト", "受入テスト": "受入テスト", "リリース": "リリース", "運用": "運用"});

// 実施が何回もある案件は「実施 1 回目」「実施 2 回目」…の棚に分ける
const ROUND_PATTERN = /^実施\s*(\d+)\s*回目$/;

/** 見出しと値を読み、値の書き方の揺れ(全角・空白)をそろえる */
const normalizeValue = (heading, value) => {
	const text = String(value).normalize("NFKC").trim();
	if (heading === "段階") {
		const round = text.match(ROUND_PATTERN);
		if (round) return `実施 ${Number(round[1])} 回目`;
	}
	return text;
};

const isKnownValue = (heading, value) => {
	if (heading === "機能") return value !== "";
	if (heading === "段階" && ROUND_PATTERN.test(value)) return true;
	return (TAG_VALUES[heading] ?? []).includes(value);
};

/** 値の並びの順(表の順。実施 n 回目 は 実施 と 実施後 の間) */
const valueRank = (heading, value) => {
	if (heading === "段階") {
		const round = value.match(ROUND_PATTERN);
		if (round) return 1 + Number(round[1]) / 10000;
		return {"準備": 0, "実施": 1, "実施後": 2}[value] ?? 99;
	}
	const index = (TAG_VALUES[heading] ?? []).indexOf(value);
	return index < 0 ? 99 : index;
};

/**
 * 資料のタグを、共通の見出しごとに読む。共通の見出しでないタグは見ない。
 * @param {string[]} tags
 * @returns {{values: Object<string, string[]>, unknown: Array<{tag: string, heading: string, value: string}>}}
 */
const readTags = (tags) => {
	const values = {};
	const unknown = [];
	for (const tag of tags ?? []) {
		const text = String(tag);
		const at = text.search(/[:：]/);
		if (at <= 0) continue;
		const heading = text.slice(0, at).normalize("NFKC").trim();
		if (!HEADINGS.includes(heading)) continue;
		const value = normalizeValue(heading, text.slice(at + 1));
		if (!isKnownValue(heading, value)) {
			unknown.push({tag: text, heading, value});
			continue;
		}
		(values[heading] ??= []);
		if (!values[heading].includes(value)) values[heading].push(value);
	}
	return {values, unknown};
};
module.exports.readTags = readTags;

// ---- タグが無いときの推定(docs/miro.md の「十字」の推定) ----
// 上から順に見る(会議と管理の言葉が両方あれば会議)。段階:・機能: は推定しない
const INFERENCE = Object.freeze([
	{heading: "区分", value: "会議", words: ["議事録", "会議", "打合せ", "MTG", "定例"]},
	{heading: "区分", value: "管理", words: ["計画", "体制", "WBS", "スケジュール", "課題", "リスク", "見積", "予算"]},
	{heading: "工程", value: "要件定義", words: ["要件"]},
	{heading: "工程", value: "基本設計", words: ["基本設計", "方式設計"]},
	{heading: "工程", value: "詳細設計", words: ["詳細設計", "API", "DB設計", "画面設計"]},
	{heading: "工程", value: "単体テスト", words: ["単体テスト"]},
	{heading: "工程", value: "結合テスト", words: ["結合テスト"]},
	{heading: "工程", value: "受入テスト", words: ["受入テスト", "UAT"]},
	{heading: "工程", value: "リリース", words: ["リリース", "移行", "切り替え"]},
	{heading: "工程", value: "運用", words: ["運用", "保守", "マニュアル"]}
]);
module.exports.INFERENCE = INFERENCE;

// 全角・半角と大文字・小文字、空白の有無の違いは同じ言葉とみなす(「DB 設計」と「DB設計」、「mtg」と「MTG」)
const foldText = (text) => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();

/**
 * 1 つの見出しについて、題名 → 近いフォルダ → 遠いフォルダの順に言葉を探す
 * @returns {?{value: string, word: string, source: string}}
 */
const inferHeading = (heading, sources) => {
	for (const source of sources) {
		const folded = foldText(source.text);
		for (const rule of INFERENCE) {
			if (rule.heading !== heading) continue;
			const word = rule.words.find((w) => folded.includes(foldText(w)));
			if (word) return {value: rule.value, word, source: source.kind};
		}
	}
	return null;
};

/** 題名。Document Manager の資料の題名はファイル名なので、拡張子を除いたファイル名を使う */
const titleOf = (doc) => {
	const base = path.basename(String(doc.entryFile ?? ""));
	const ext = path.extname(base);
	return ext ? base.slice(0, -ext.length) : base;
};
module.exports.titleOf = titleOf;

/**
 * 資料 1 件の分類。付けたタグ → 推定 の順で、見出しごとに値を決める。
 *
 *   - 付けたタグがあれば推定より常に勝つ。同じ見出しのタグが 2 つ以上あれば表の順で最初の 1 つ(機能: は先に読んだ 1 つ)
 *   - 表に無い値のタグしか無い見出しは、推定せずに「表に無い値」とする(付けた人の意図を推定で上書きしない)
 *   - 工程:・段階: のタグが付いていれば、区分: は推定しない(題名の「計画」などで成果物が管理に吸われないように)
 *   - 区分:会議 で 会議: が無ければ、題名に 定例 があれば 定例(推定)、無ければ 臨時
 *   - 会議: のタグだけが付いていれば 区分:会議 とみなす
 *
 * @param {{entryFile: string, folderNames?: string[], tags?: string[]}} doc folderNames は近い順(入っているフォルダ → その親 …)
 */
const classify = (doc) => {
	const {values, unknown} = readTags(doc.tags);
	const sources = [{kind: "title", text: titleOf(doc)}, ...(doc.folderNames ?? []).map((name) => ({kind: "folder", text: name}))];
	const resolved = {};
	const duplicates = [];
	const unknownHeadings = new Set(unknown.map((u) => u.heading));

	const fromTags = (heading) => {
		const list = values[heading] ?? [];
		if (list.length === 0) return null;
		const sorted = heading === "機能" ? list : [...list].sort((a, b) => valueRank(heading, a) - valueRank(heading, b));
		if (sorted.length > 1) duplicates.push({heading, used: `${heading}:${sorted[0]}`, ignored: sorted.slice(1).map((v) => `${heading}:${v}`)});
		return {value: sorted[0], basis: "tag"};
	};
	for (const heading of ["区分", "工程", "段階", "機能", "会議"]) {
		const tagged = fromTags(heading);
		if (tagged) resolved[heading] = tagged;
	}
	if (resolved["区分"] == null && resolved["会議"] != null) resolved["区分"] = {value: "会議", basis: "tag", impliedBy: `会議:${resolved["会議"].value}`};

	const infer = (heading) => {
		if (resolved[heading] != null || unknownHeadings.has(heading)) return;
		const found = inferHeading(heading, sources);
		if (found) resolved[heading] = {value: found.value, basis: "inferred", word: found.word, source: found.source};
	};
	if (resolved["工程"] == null && resolved["段階"] == null) infer("区分");
	infer("工程");
	if (resolved["区分"]?.value === "会議" && resolved["会議"] == null) {
		const regular = sources.find((s) => foldText(s.text).includes("定例"));
		resolved["会議"] = regular
			? {value: "定例", basis: "inferred", word: "定例", source: regular.kind}
			: {value: "臨時", basis: "default"};
	}
	return {
		values: resolved,
		excludedProcesses: [...(values["対象外"] ?? [])],
		unknown,
		duplicates
	};
};
module.exports.classify = classify;

// ---- 日付(docs/miro.md の「十字」の日付) ----
const pad = (n) => String(n).padStart(2, "0");
const localDate = (iso) => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const validDate = (y, m, d) => {
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const DATE_PATTERNS = Object.freeze([
	{re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, year: true},
	{re: /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g, year: true},
	{re: /(\d{4})年(\d{1,2})月(\d{1,2})日/g, year: true},
	{re: /(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/g, year: false},
	{re: /(?<![\d年])(\d{1,2})月(\d{1,2})日/g, year: false}
]);

/** 文字列の中で最初に見つかった日付。年の無いものは基準日(初版の登録日)の年を補い、基準日より後なら前の年にする */
const findDate = (text, baseDate) => {
	const folded = String(text ?? "").normalize("NFKC").replace(/\s+/g, "");
	const found = [];
	for (const pattern of DATE_PATTERNS) {
		for (const match of folded.matchAll(pattern.re)) {
			let y;
			let m;
			let d;
			if (pattern.year) {
				[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
			} else {
				if (baseDate == null) continue;
				[m, d] = [Number(match[1]), Number(match[2])];
				y = Number(baseDate.slice(0, 4));
				if (`${y}-${pad(m)}-${pad(d)}` > baseDate) y -= 1;
			}
			if (!validDate(y, m, d)) continue;
			found.push({index: match.index, date: `${y}-${pad(m)}-${pad(d)}`});
		}
	}
	found.sort((a, b) => a.index - b.index);
	return found[0]?.date ?? null;
};

/**
 * 資料の日付。題名 → ファイル名 の順に探し、無ければ初版(最初の版)の登録日(dateSource: "first_upload")。
 * 版を上げても変わらないよう、基準は最新版ではなく初版の登録日にする(何も覚えなくても報告と配置が一致する)。
 * Document Manager では題名がファイル名なので、拡張子を除いたファイル名 → ファイル名の順に見る。
 * @param {{entryFile: string, firstUploaded?: string, modified?: string}} doc firstUploaded が無ければ modified を使う
 * @returns {{date: ?string, dateSource: "title"|"first_upload"|null}}
 */
const documentDate = (doc) => {
	const base = localDate(doc.firstUploaded ?? doc.modified);
	const fromTitle = findDate(titleOf(doc), base) ?? findDate(path.basename(String(doc.entryFile ?? "")), base);
	if (fromTitle) return {date: fromTitle, dateSource: "title"};
	return {date: base, dateSource: base ? "first_upload" : null};
};
module.exports.documentDate = documentDate;
module.exports.findDate = findDate;

// ---- 表に無い値の、近い値の候補 ----
const bigrams = (text) => {
	const list = [];
	for (let i = 0; i < text.length - 1; i++) list.push(text.slice(i, i + 2));
	return list;
};
const candidatesFor = (heading, value) => {
	const known = heading === "段階" ? [...TAG_VALUES["段階"], "実施 1 回目"] : (TAG_VALUES[heading] ?? []);
	const folded = foldText(value);
	const result = new Set();
	// 推定の言葉に当たれば、その値(例 工程:UAT → 工程:受入テスト)
	for (const rule of INFERENCE) {
		if (rule.heading === heading && rule.words.some((w) => folded.includes(foldText(w)) || foldText(w).includes(folded))) result.add(rule.value);
	}
	for (const candidate of known) {
		const c = foldText(candidate);
		if (folded !== "" && (c.includes(folded) || folded.includes(c))) result.add(candidate);
	}
	if (result.size === 0 && folded.length >= 2) {
		const mine = bigrams(folded);
		for (const candidate of known) {
			if (bigrams(foldText(candidate)).some((b) => mine.includes(b))) result.add(candidate);
		}
	}
	return [...result].map((v) => `${heading}:${v}`);
};
module.exports.candidatesFor = candidatesFor;

// ---- 報告(GET /api/miro/layout-report) ----

/** 推定・既定で決めた見出しを、placement の根拠に書く形にする */
const basisOf = (classification, headings) => {
	const used = headings.map((h) => classification.values[h]).filter(Boolean);
	const inferred = headings.filter((h) => classification.values[h]?.basis === "inferred");
	if (inferred.length === 0) return {basis: used.length > 0 ? "tag" : "unclassified"};
	return {
		basis: "inferred",
		inferredTags: inferred.map((h) => `${h}:${classification.values[h].value}`),
		matchedWords: inferred.map((h) => classification.values[h].word)
	};
};

/** 区分で決まった資料で、使われなかった付けたタグ(工程:・段階:) */
const overriddenBy = (doc, classification, ignoredHeadings) => {
	const division = classification.values["区分"];
	if (division == null) return null;
	const ignored = ignoredHeadings
		.map((h) => classification.values[h])
		.map((v, i) => (v?.basis === "tag" ? `${ignoredHeadings[i]}:${v.value}` : null))
		.filter(Boolean);
	if (ignored.length === 0) return null;
	return {documentId: doc.documentId, title: titleOf(doc), used: `区分:${division.value}`, ...(division.basis === "inferred" ? {usedBasis: "inferred"} : {}), ignored};
};

const unknownReason = (classification, headings) => classification.unknown.some((u) => headings.includes(u.heading));

/**
 * 十字で書き出したらどうなるか(Miro には触らない)。
 * @param {{project: {id: string, name: string}, documents: object[]}} input
 *   documents は出す順。各要素: {documentId, entryFile, modified, firstUploaded, tags, folderId, folderNames(近い順), topFolder: ?{id, name}, subFolders: string[]}
 * 区画の中の並び: 左上・左下は工程の順(同じ工程の中は出す順)、右上は出す順、右下は日付順
 */
module.exports.buildCrossReport = (input) => {
	const documents = input.documents ?? [];
	const classified = documents.map((doc, order) => ({doc, order, c: classify(doc), ...documentDate(doc)}));
	const placements = [];
	const unclassified = [];
	const overridden = [];
	const notes = [];
	const place = (entry, area, slot, fields = {}) => placements.push({
		documentId: entry.doc.documentId, title: titleOf(entry.doc), area, slot: slot ?? null, ...fields
	});
	const dateFields = (entry) => ({date: entry.date, dateSource: entry.dateSource});
	const byDate = (a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.order - b.order;

	const upperRight = [];
	const lowerRight = [];
	const steps = new Map();
	const rest = [];
	for (const entry of classified) {
		const {c} = entry;
		const division = c.values["区分"]?.value;
		if (division === "管理" || division === "会議") {
			(division === "管理" ? upperRight : lowerRight).push(entry);
			const o = overriddenBy(entry.doc, c, ["工程", "段階"]);
			if (o) overridden.push(o);
			continue;
		}
		const process = c.values["工程"]?.value;
		if (process == null) {
			rest.push(entry);
			continue;
		}
		const step = CROSS_STEP_OF[process];
		if (!steps.has(step)) steps.set(step, []);
		steps.get(step).push(entry);
	}
	const stepOrder = ["要件定義", "基本設計", "詳細設計", "単体テスト", "結合テスト", "受入テスト", "リリース", "運用"];
	for (const step of stepOrder) {
		const area = UPPER_PROCESSES.includes(step) ? "upper_left" : "lower_left";
		for (const entry of steps.get(step) ?? []) {
			place(entry, area, `工程:${entry.c.values["工程"].value}`, {step, ...basisOf(entry.c, ["工程"])});
		}
	}
	for (const entry of upperRight) place(entry, "upper_right", "区分:管理", basisOf(entry.c, ["区分"]));
	for (const entry of lowerRight.sort(byDate)) {
		place(entry, "lower_right", `会議:${entry.c.values["会議"].value}`, {...dateFields(entry), ...basisOf(entry.c, ["区分", "会議"])});
		if (entry.dateSource === "first_upload") notes.push({documentId: entry.doc.documentId, title: titleOf(entry.doc), kind: "date_from_first_upload", date: entry.date});
	}
	for (const entry of rest) {
		const reason = unknownReason(entry.c, ["区分", "工程"]) ? "unknown_value" : "no_process_tag";
		unclassified.push({documentId: entry.doc.documentId, title: titleOf(entry.doc), reason});
		place(entry, "unclassified", null, {basis: "unclassified"});
	}

	const areas = Object.fromEntries(CROSS_AREAS.map((a) => [a, 0]));
	const slots = {};
	for (const p of placements) {
		areas[p.area] += 1;
		if (p.slot) slots[`${p.area} / ${p.slot}`] = (slots[`${p.area} / ${p.slot}`] ?? 0) + 1;
	}
	const total = documents.length;
	const ratio = total === 0 ? 0 : Math.round((unclassified.length / total) * 100) / 100;

	const unknownValues = [];
	const duplicateTags = [];
	for (const {doc, c} of classified) {
		for (const u of c.unknown) {
			unknownValues.push({documentId: doc.documentId, title: titleOf(doc), tag: u.tag, candidates: u.heading === "機能" ? [] : candidatesFor(u.heading, u.value)});
		}
		for (const d of c.duplicates) duplicateTags.push({documentId: doc.documentId, title: titleOf(doc), ...d});
	}

	return {
		project: input.project?.name ?? null,
		projectId: input.project?.id ?? null,
		layout: "cross",
		layoutName: "十字",
		areaTitles: CROSS_AREA_TITLES,
		summary: {
			total,
			unclassified: unclassified.length,
			unclassifiedRatio: ratio,
			// 十字で書き出す前の目安(この割合を超えたら、先に LLM でタグを見直す)
			reviewRecommended: ratio > RULES.reviewRatio,
			reviewRatio: RULES.reviewRatio,
			inferred: placements.filter((p) => p.basis === "inferred").length,
			areas,
			slots
		},
		placements,
		unclassified,
		overriddenTags: overridden,
		unknownValues,
		duplicateTags,
		notes
	};
};

// ---- データベースから報告の材料を集める ----

// 版の鎖(previous_id)を最初の版までさかのぼり、その登録日を返す。壊れた鎖で回り続けないよう上限を設ける
const firstUploadedAt = async (ds, documentId, fallback) => {
	let uploaded = fallback;
	let id = documentId;
	const seen = new Set();
	while (id != null && !seen.has(id) && seen.size < 1000) {
		seen.add(id);
		const row = await ds.get(`SELECT previous_id, uploaded_at FROM documents WHERE id = ?`, [id]);
		if (row == null) break;
		uploaded = row.uploaded_at ?? uploaded;
		id = row.previous_id;
	}
	return uploaded;
};

/**
 * プロジェクトの資料を、おしながき順に、タグ・フォルダ名付きで集める。アーカイブ済みの資料は入れない。
 * @returns {Promise<?{project: object, documents: object[]}>}
 */
module.exports.loadInput = async (projectId) => {
	const ds = require("./datastore.js");
	const Projects = require("./projects.js");
	const ProjectManifest = require("./project-manifest.js");
	const project = await Projects.getProject(projectId);
	if (project == null) return null;
	const manifest = ProjectManifest.build(project, await Projects.getProjectTree(projectId));
	const placements = [];
	for (const doc of manifest.rootDocuments) placements.push({doc, chain: []});
	const walk = (folders, chain) => {
		for (const folder of folders) {
			const next = [...chain, folder];
			for (const doc of folder.documents) placements.push({doc, chain: next});
			walk(folder.folders, next);
		}
	};
	walk(manifest.folders, []);
	const documents = [];
	for (const {doc, chain} of placements) {
		if (doc.archived || doc.entryFile == null) continue;
		const tags = (await ds.all(`SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`, [doc.documentId])).map((r) => r.tag);
		documents.push({
			documentId: doc.documentId,
			entryFile: doc.entryFile,
			modified: doc.modified,
			firstUploaded: await firstUploadedAt(ds, doc.documentId, doc.modified),
			tags,
			folderId: doc.folderId ?? null,
			folderNames: chain.map((f) => f.name).reverse(),
			topFolder: chain.length > 0 ? {id: chain[0].id, name: chain[0].name} : null,
			subFolders: chain.slice(1).map((f) => f.name)
		});
	}
	return {project, documents};
};

/**
 * 書き出す資料を、出す順に、タグ付きで集める(十字の振り分けに使う)。プロジェクトを渡すと、そのプロジェクトの
 * フォルダ名も推定に使う。プロジェクトに入っていない資料は、題名とタグだけで振り分ける。
 * @param {string[]} documentIds 出す順の文書 ID(いまの版)
 * @param {?object} project
 * @returns {Promise<{project: ?object, documents: object[]}>}
 */
module.exports.loadDocumentsInput = async (documentIds, project = null) => {
	const ds = require("./datastore.js");
	const inProject = new Map(project == null ? [] : ((await module.exports.loadInput(project.id))?.documents ?? []).map((d) => [d.documentId, d]));
	const documents = [];
	for (const id of documentIds) {
		if (inProject.has(id)) {
			documents.push(inProject.get(id));
			continue;
		}
		const row = await ds.get(`SELECT id, entry_file, uploaded_at FROM documents WHERE id = ?`, [id]);
		if (row == null) continue;
		const tags = (await ds.all(`SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`, [id])).map((r) => r.tag);
		documents.push({
			documentId: id, entryFile: row.entry_file, modified: row.uploaded_at, firstUploaded: await firstUploadedAt(ds, id, row.uploaded_at),
			tags, folderId: null, folderNames: [], topFolder: null, subFolders: []
		});
	}
	return {project, documents};
};
