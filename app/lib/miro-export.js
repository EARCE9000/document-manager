/*!
 * miro-export.js : プロジェクトの資料を Miro のボードに書き出す
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- 考え方 ----
 * 書き出しは、人が頼んだときだけ行う(Claude Code などから API で頼む)。自動では書き出さない。
 * 打ち合わせで使っているボードが、知らないうちに変わらないようにするため。
 * 書き出すたびに**新しいフレーム**を作り、頼まれた資料をその中に PDF・画像で並べる。前に書き出したフレームには
 * 二度と触らない(書き出したときの写し。正本は Document Manager のまま)。
 *
 * ---- どこに出すか(目印) ----
 * ボードに、次のように書いた付箋(または図形・文字)を置いておく。
 *     [DM]設計書
 *     (右側)
 *     基本設計書と画面設計の最新版
 * 1 行目の [DM] のあとが目印の名前(フレームの名前にもなる)。かっこで囲んだ向きの行が向き(省くと右)。
 * それ以外の行はメモ(何を書き出すかの覚え書き。Document Manager は読まず、一覧に載せるだけ)。
 * [DM]・かっこは全角・半角、大文字・小文字を問わない。目印は名前のほか、Miro の「リンクをコピー」で取った
 * 付箋・図形のリンクでも指せる。どちらも無いときは、利用者に確かめてから、ボードの中身の右の空いている所に出す(free)。
 *
 * ---- 向き(miro-layout-plan.js) ----
 * 右・左・上・下・右上・右下・左上・左下(斜めは目印のまわりを輪を広げるように埋める)、と十字(資料をタグで 4 つに分け、斜め 4 つのフレームに出す)。
 * 1 回の書き出しで「この資料はこの向き」の組を複数出せる。フレームの名前は「タイトル [YYYY-MM-DD hh:mm]」。
 *
 * ---- 何を書き出すか ----
 * 文書 ID で頼む(プロジェクトには縛られない)。プロジェクトを渡すと、資料を省いたときにそのプロジェクトの資料を全部出し、
 * 十字ではプロジェクトの名前・説明の概要カードを置く。
 *
 * ---- 書き出したあと ----
 * 書き出しの記録(miro_exports)ごとに、資料を動かす・まとめて置き直す・見出しや図形を足すことができる
 * (boardMap で今の様子を読み、moveDocument・applyLayout で直す)。書き出しを省くと、頼んだ人の最後の書き出し。
 *
 * ファイルの取り出しや PDF への変換は、呼び出し側(server.js)から渡される preparePayload が行う。
 */

const crypto = require("crypto");
const os = require("os");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");
const Miro = require("./miro-client.js");
const MiroConnection = require("./miro-connection.js");
const Projects = require("./projects.js");
const ProjectManifest = require("./project-manifest.js");
const DocumentAliases = require("./document-aliases.js");
const MiroLayout = require("./miro-layout.js");
const MiroLayoutPlan = require("./miro-layout-plan.js");
const MiroDiagram = require("./miro-diagram.js");

// ---- 大きさ(単位は Miro のボード上の長さ) ----
const LAYOUT = Object.freeze({
	itemWidth: 360,
	gapX: 60,
	captionHeight: 80,
	gapY: 60,
	padding: 80,
	// 目印とフレームの間
	anchorGap: 120,
	// ほかのフレーム・付箋などとの間(重なるのを避けてずらすとき)
	frameGap: 200,
	// 縦横比が分からないときは A4 縦とみなす
	defaultAspect: 297 / 210
});
module.exports.LAYOUT = LAYOUT;

// Miro に置けるファイルの上限(Miro の API の上限)
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;

// 書き出しの順番を持っていられる時間(変換に時間がかかることがあるので長め)。MIRO_SYNC_* は自動の同期をやめる前の名前(そのまま効く)
const LOCK_MS = Number(process.env.MIRO_EXPORT_LOCK_SECONDS || process.env.MIRO_SYNC_LOCK_SECONDS || 600) * 1000;
// 資料を置くとき、同時に書き込む件数。1件ごとに Miro を3回呼ぶ(中身・見出し・グループ)ので、1件ずつだと
// 1件あたり約5秒かかった(実物で76件に約7分)。多くしすぎると Miro の回数制限に当たる
const CONCURRENCY = Math.max(1, Number(process.env.MIRO_EXPORT_CONCURRENCY || process.env.MIRO_SYNC_CONCURRENCY || 4));
// ボードを読むときの上限(大きなボードで読み続けないように)
const MAX_SCAN_ITEMS = 20000;
// 1 回に書き出せる資料の数
const MAX_DOCUMENTS = 300;
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

const STATES = Object.freeze({PLACED: "placed", SKIPPED: "skipped", FAILED: "failed"});
module.exports.STATES = STATES;

/** 並べたものを、決まった数ずつ同時に処理する(途中で連携が切れたら、そこで止める) */
const forEachConcurrently = async (list, limit, fn) => {
	let next = 0;
	let stop = null;
	const worker = async () => {
		while (stop == null && next < list.length) {
			const entry = list[next++];
			try {
				await fn(entry);
			} catch (err) {
				stop = err;
			}
		}
	};
	await Promise.all(Array.from({length: Math.min(limit, list.length)}, worker));
	if (stop != null) throw stop;
};

// ---- SQL ----
// miro_projects・miro_items は、自動の同期(連動)をやめる前の表。今は使わない
const SQL_INSERT_EXPORT = `
	INSERT INTO miro_exports (id, project_id, board_id, anchor_kind, anchor_name, anchor_item_id, title, request, state, created_by, created_at)
	VALUES (@id, @project_id, @board_id, @anchor_kind, @anchor_name, @anchor_item_id, @title, @request, 'running', @created_by, @created_at)
`;
const SQL_FINISH_EXPORT = `
	UPDATE miro_exports SET state = @state, frames = @frames, cards = @cards, documents = @documents, placed = @placed, skipped = @skipped,
		failed = @failed, error = @error, finished_at = @finished_at
	WHERE id = @id
`;
const SQL_SET_EXPORT_FRAMES = `UPDATE miro_exports SET frames = @frames WHERE id = @id`;
const SQL_SET_EXPORT_DECORATIONS = `UPDATE miro_exports SET decorations = @decorations WHERE id = @id`;
const SQL_GET_EXPORT = `SELECT * FROM miro_exports WHERE id = ?`;
const SQL_LIST_EXPORTS = `SELECT * FROM miro_exports ORDER BY created_at DESC LIMIT ?`;
const SQL_LAST_EXPORT_OF = `SELECT * FROM miro_exports WHERE created_by = ? AND board_id = ? AND state = 'done' ORDER BY created_at DESC LIMIT 1`;
// 同じ目印に前に出したフレーム(斜めのマスの埋まり方を知るため)
const SQL_FRAMES_AT_ANCHOR = `SELECT frames FROM miro_exports WHERE board_id = ? AND anchor_item_id = ? AND state <> 'running'`;
const SQL_LAST_EXPORT_AT_ANCHOR = `SELECT anchor_item_id, MAX(created_at) AS last_at FROM miro_exports WHERE board_id = ? AND anchor_item_id IS NOT NULL AND state = 'done' GROUP BY anchor_item_id`;
// 手直しの順番取り(同じ書き出しを 2 つの頼みで同時に動かさない。複数台でも)
const SQL_TAKE_LOCK = `
	UPDATE miro_exports SET lock_owner = @owner, lock_until = @until
	WHERE id = @id AND (lock_owner IS NULL OR lock_until IS NULL OR lock_until < @now)
`;
const SQL_RELEASE_LOCK = `UPDATE miro_exports SET lock_owner = NULL, lock_until = NULL WHERE id = @id AND lock_owner = @owner`;
const SQL_LIST_ITEMS = `SELECT * FROM miro_export_items WHERE export_id = ?`;
const SQL_INSERT_ITEM = `
	INSERT INTO miro_export_items (export_id, alias, document_id, item_id, item_kind, caption_id, group_id, title, frame_id, x, y, width, height, updated_by, updated_at)
	VALUES (@export_id, @alias, @document_id, @item_id, @item_kind, @caption_id, @group_id, @title, @frame_id, @x, @y, @width, @height, @updated_by, @updated_at)
`;
const SQL_GET_ITEM = `SELECT * FROM miro_export_items WHERE export_id = ? AND alias = ?`;
const SQL_SET_POSITION = `UPDATE miro_export_items SET x = ?, y = ?, width = ?, height = ?, frame_id = ?, updated_by = ?, updated_at = ? WHERE export_id = ? AND alias = ?`;
const SQL_SELECT_DOCUMENT = `SELECT id, entry_file, preview_file, size, uploaded_at, deleted_at, render_status, render_file FROM documents WHERE id = ?`;
// 新しい版(古い版の ID を渡されたら、いまの版へたどる)
const SQL_NEXT_VERSION = `SELECT id FROM documents WHERE previous_id = ? ORDER BY uploaded_at DESC LIMIT 1`;

// ---- 呼び出し側から渡されるもの ----
let preparePayload = null;
/**
 * @param {{preparePayload: (doc: object) => Promise<{kind: "documents"|"images", file: Buffer, fileName: string, contentType: string}|{skip: string}>}} deps
 */
module.exports.init = (deps) => {
	preparePayload = deps.preparePayload;
};

// ---- 小さな部品 ----

const exportError = (message, status = 400, extra = {}) => Object.assign(new Error(message), {status, ...extra});

const parseJson = (text, fallback) => {
	if (text == null || text === "") return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
/** 文字(改行は Miro の改行にする) */
const textHtml = (text) => escapeHtml(text).replace(/\n/g, "<br>");
/** 文字・図形にリンクを付ける(http・https だけ) */
const linked = (html, link) => (typeof link === "string" && /^https?:\/\//.test(link) ? `<a href="${escapeHtml(link)}">${html}</a>` : html);
/** Miro の文字の中身(HTML)を、行ごとの文字にする */
const plainLines = (html) => String(html ?? "")
	.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
	.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
	.split("\n").map((line) => line.trim()).filter((line) => line !== "");
const plainText = (html) => plainLines(html).join(" ");

/** 資料の見出し(名前・更新日・Document Manager で開くリンク) */
const captionHtml = ({title, uploadedAt, url, note}) => {
	const date = uploadedAt ? new Date(uploadedAt).toLocaleDateString("ja-JP", {timeZone: process.env.TZ || "Asia/Tokyo"}) : "";
	const link = url ? ` · <a href="${escapeHtml(url)}">Document Manager で開く</a>` : "";
	const mark = note ? `<br><em>${escapeHtml(note)}</em>` : "";
	return `<p><strong>${escapeHtml(title)}</strong><br>${escapeHtml(date)} 更新${link}${mark}</p>`;
};
module.exports.captionHtml = captionHtml;

const aliasUrl = (publicBaseUrl, alias) => (publicBaseUrl ? `${String(publicBaseUrl).replace(/\/+$/, "")}/api/documents/alias/${alias}/viewer` : null);
const projectUrlOf = (target, projectId) => (target?.publicBaseUrl && projectId ? `${String(target.publicBaseUrl).replace(/\/+$/, "")}/?project=${encodeURIComponent(projectId)}` : null);
/** ボードの項目へ直接飛ぶリンク(Miro は ?moveToWidget= で、その項目の位置を開く) */
const itemUrl = (target, itemId) => (target?.boardUrl && itemId ? `${target.boardUrl}${target.boardUrl.includes("?") ? "&" : "?"}moveToWidget=${itemId}` : null);

/** フレームの名前の日時(書き出したときの、その地域の時刻。24 時間) */
const stamp = (date = new Date()) => date.toLocaleString("sv-SE", {timeZone: process.env.TZ || "Asia/Tokyo", hour12: false}).slice(0, 16);
module.exports.stamp = stamp;

/**
 * 中身の縦横比(高さ / 幅)。PDF は1ページ目の大きさ、画像はファイルの頭から読む。分からなければ A4 縦
 */
const aspectOf = (file, contentType) => {
	try {
		if (contentType === "application/pdf") {
			const text = file.subarray(0, Math.min(file.length, 4 * 1024 * 1024)).toString("latin1");
			const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(text);
			if (box) {
				const width = Number(box[3]) - Number(box[1]);
				const height = Number(box[4]) - Number(box[2]);
				if (width > 0 && height > 0) return height / width;
			}
		} else if (contentType === "image/png" && file.length > 24) {
			return file.readUInt32BE(20) / file.readUInt32BE(16);
		} else if (contentType === "image/jpeg") {
			for (let i = 2; i + 9 < file.length;) {
				if (file[i] !== 0xff) break;
				const marker = file[i + 1];
				const length = file.readUInt16BE(i + 2);
				if (marker >= 0xc0 && marker <= 0xc3) return file.readUInt16BE(i + 5) / file.readUInt16BE(i + 7);
				i += 2 + length;
			}
		}
	} catch {
		// 読めなければ既定の比にする
	}
	return LAYOUT.defaultAspect;
};
module.exports.aspectOf = aspectOf;

// ---- 順番取り(同じ書き出しの手直しを重ねない。複数台でも) ----

const takeLock = async (exportId) => {
	const now = new Date();
	const result = await ds.run(SQL_TAKE_LOCK, {id: exportId, owner: INSTANCE_ID, until: new Date(now.getTime() + LOCK_MS).toISOString(), now: now.toISOString()});
	return Number(result?.changes ?? 0) > 0;
};
const releaseLock = (exportId) => ds.run(SQL_RELEASE_LOCK, {id: exportId, owner: INSTANCE_ID}).catch(() => {});

const requireTarget = async () => {
	const target = await MiroConnection.target();
	if (target == null) throw exportError("Miro と連携していないか、書き出すボードが決まっていません(管理画面の「Miro 連携」)", 409, {code: "not_connected"});
	return target;
};

// ---- ボードを読む ----

/** 項目のボードの上の範囲。枠の中のものは、枠の左上からの位置を足す */
const absoluteBox = (item, parent) => {
	const width = Number(item?.geometry?.width) || 0;
	const height = Number(item?.geometry?.height) || 0;
	let x = Number(item?.position?.x);
	let y = Number(item?.position?.y);
	if (parent != null) {
		x += Number(parent.position?.x) - (Number(parent.geometry?.width) || 0) / 2;
		y += Number(parent.position?.y) - (Number(parent.geometry?.height) || 0) / 2;
	}
	return {x, y, width, height, left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2};
};
const roundBox = (box) => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)]));

/** ボードの項目を全部読む(種類を問わない。続きは cursor で) */
const scanBoard = async (board) => {
	const items = [];
	let cursor;
	do {
		const page = await MiroConnection.withToken((token) => Miro.listItems(token, board, {cursor}));
		items.push(...(page.data || []));
		cursor = page.cursor;
	} while (cursor && items.length < MAX_SCAN_ITEMS);
	const byId = new Map(items.map((item) => [String(item.id), item]));
	const placed = [];
	for (const item of items) {
		if (item.type === "group" || item.type === "connector" || item.position == null || item.geometry == null) continue;
		const parentId = item.parent?.id != null ? String(item.parent.id) : null;
		const parent = parentId != null ? byId.get(parentId) : null;
		if (parentId != null && parent == null) continue;
		placed.push({id: String(item.id), type: item.type, parentId, item, box: absoluteBox(item, parent)});
	}
	return placed;
};

// ---- 目印 ----

const MARKER = /^\[\s*dm\s*\]\s*(.*)$/i;
const ANCHOR_TYPES = Object.freeze(["sticky_note", "shape", "text"]);
const NAME_MAX = 60;
const NOTE_MAX = 300;
const normalizeName = (name) => String(name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 目印の文字を読む。目印でなければ null。
 * @returns {?{name: string, direction: ?string, directionText: ?string, note: ?string, problem: ?string}}
 */
const parseAnchorText = (html) => {
	const lines = plainLines(html);
	if (lines.length === 0) return null;
	const first = MARKER.exec(lines[0].normalize("NFKC"));
	if (first == null) return null;
	const name = first[1].trim();
	let direction = null;
	let directionText = null;
	let problem = name === "" ? "名前がありません([DM] のあとに名前を書きます)" : null;
	const notes = [];
	for (const line of lines.slice(1)) {
		const folded = line.normalize("NFKC").trim();
		// かっこで囲んだ行は向き。読めなければ知らせる
		if (directionText == null && /^\(.*\)$/.test(folded)) {
			directionText = line;
			direction = MiroLayoutPlan.parseDirection(folded);
			if (direction == null) problem ??= `向き「${line}」が読めません(右・左・上・下・右上・右下・左上・左下・十字)`;
			continue;
		}
		notes.push(line);
	}
	return {name, direction, directionText, note: notes.length > 0 ? notes.join("\n") : null, problem};
};
module.exports.parseAnchorText = parseAnchorText;

const anchorOf = (target, entry, parsed, lastAt = null) => ({
	id: entry.id,
	type: entry.type,
	name: parsed?.name ?? null,
	direction: parsed?.direction ?? null,
	directionName: parsed?.direction ? MiroLayoutPlan.DIRECTION_NAMES[parsed.direction] : null,
	note: parsed?.note ?? null,
	problem: parsed?.problem ?? null,
	url: itemUrl(target, entry.id),
	position: roundBox(entry.box),
	lastExportedAt: lastAt
});

const findAnchors = (scan) => scan.filter((entry) => ANCHOR_TYPES.includes(entry.type))
	.map((entry) => ({entry, parsed: parseAnchorText(entry.item.data?.content)}))
	.filter(({parsed}) => parsed != null);

/** ボードにある目印の一覧 */
module.exports.listAnchors = async () => {
	const target = await requireTarget();
	const scan = await scanBoard(target.boardId);
	const lastAt = new Map((await ds.all(SQL_LAST_EXPORT_AT_ANCHOR, [target.boardId])).map((row) => [String(row.anchor_item_id), row.last_at]));
	const anchors = findAnchors(scan).map(({entry, parsed}) => anchorOf(target, entry, parsed, lastAt.get(entry.id) ?? null))
		.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
	const counts = new Map();
	for (const a of anchors) counts.set(normalizeName(a.name), (counts.get(normalizeName(a.name)) ?? 0) + 1);
	for (const a of anchors) {
		if (a.problem == null && counts.get(normalizeName(a.name)) > 1) a.problem = "同じ名前の目印がほかにもあります(名前で指すと、どれか決められません)";
	}
	return {boardUrl: target.boardUrl ?? null, anchors};
};

/** ボードの中身の右の空いている所(何も無ければ原点) */
const freeSpot = (scan) => {
	const tops = scan.filter((e) => e.parentId == null);
	if (tops.length === 0) return {left: 0, top: 0};
	return {left: Math.max(...tops.map((e) => e.box.right)) + LAYOUT.frameGap, top: Math.min(...tops.map((e) => e.box.top))};
};

/**
 * 目印の付箋を置く。置く場所は、ボードの中身の右の空いている所(Miro の API では、利用者がいま見ている所が分からない。
 * 置いたあと、利用者が Miro で好きな場所へ動かす)
 * @param {{name: string, direction?: string, note?: string}} input
 */
module.exports.placeAnchor = async (user, {name, direction, note} = {}) => {
	const target = await requireTarget();
	const cleanName = String(name ?? "").replace(/\s+/g, " ").trim();
	if (cleanName === "" || [...cleanName].length > NAME_MAX) throw exportError(`名前は 1〜${NAME_MAX} 文字です`);
	const directionId = direction == null || direction === "" ? null : MiroLayoutPlan.parseDirection(direction);
	if (direction != null && direction !== "" && directionId == null) throw exportError(`向きは ${MiroLayoutPlan.DIRECTIONS.map((d) => MiroLayoutPlan.DIRECTION_NAMES[d]).join("・")} のどれかです`);
	const cleanNote = note == null ? "" : String(note).trim();
	if ([...cleanNote].length > NOTE_MAX) throw exportError(`メモは ${NOTE_MAX} 文字までです`);
	const scan = await scanBoard(target.boardId);
	const spot = freeSpot(scan);
	const lines = [`[DM]${cleanName}`, ...(directionId ? [`(${MiroLayoutPlan.DIRECTION_NAMES[directionId]})`] : []), ...cleanNote.split(/\r?\n/).filter((l) => l.trim() !== "")];
	const width = 360;
	const sticky = await MiroConnection.withToken((token) => Miro.createStickyNote(token, target.boardId, {
		content: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""), x: spot.left + width / 2, y: spot.top + width / 2, width
	}));
	logger.info({audit: "miro_anchor_placed", user, name: cleanName, direction: directionId}, "audit");
	const box = absoluteBox(sticky, null);
	return anchorOf(target, {id: String(sticky.id), type: "sticky_note", box: box.width > 0 ? box : {...box, left: spot.left, top: spot.top, right: spot.left + width, bottom: spot.top + width}},
		{name: cleanName, direction: directionId, note: cleanNote || null, problem: null});
};

/** Miro の項目のリンク(「リンクをコピー」)から、ボードと項目の ID を取る */
const parseItemUrl = (url) => {
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		return null;
	}
	const board = /\/app\/board\/([^/?#]+)/.exec(parsed.pathname)?.[1];
	const item = parsed.searchParams.get("moveToWidget");
	if (board == null || item == null || !/^\d+$/.test(item)) return null;
	return {boardId: decodeURIComponent(board), itemId: item};
};
module.exports.parseItemUrl = parseItemUrl;

// ---- 頼まれた中身を検める ----

const withAlias = async (row) => ({...row, alias: (await DocumentAliases.aliasOf(row.id)) ?? (await DocumentAliases.assign(row.id))});

/** プロジェクトの資料(おしながき順。アーカイブ済みは除く) */
const projectDocuments = async (project) => {
	const manifest = ProjectManifest.build(project, await Projects.getProjectTree(project.id));
	const placements = [...manifest.rootDocuments];
	const walk = (folders) => {
		for (const folder of folders) {
			placements.push(...folder.documents);
			walk(folder.folders);
		}
	};
	walk(manifest.folders);
	const documents = [];
	for (const placement of placements) {
		const row = await ds.get(SQL_SELECT_DOCUMENT, [placement.documentId]);
		if (row == null || row.deleted_at != null) continue;
		documents.push(await withAlias(row));
	}
	return documents;
};

/** 文書 ID から、いまの版を引く(古い版の ID なら新しい版へたどる)。無ければ null、アーカイブ済みなら {archived} */
const currentDocument = async (id) => {
	let row = await ds.get(SQL_SELECT_DOCUMENT, [id]);
	if (row == null) return null;
	for (let i = 0; i < 1000; i++) {
		const next = await ds.get(SQL_NEXT_VERSION, [row.id]);
		if (next == null) break;
		row = await ds.get(SQL_SELECT_DOCUMENT, [next.id]);
	}
	return row.deleted_at != null ? {archived: true, row} : withAlias(row);
};

/**
 * 書き出しの頼みを検める。
 *   {documentIds?, direction?, title?}                 1 つのフレーム(資料を省くときは project が要る: そのプロジェクトの資料を全部)
 *   {groups: [{documentIds, direction?, title?}]}      向きごとの組
 *   anchor(目印の名前)・anchorUrl(付箋・図形のリンク)・free(空いている所)のどれか 1 つ。project は省ける
 */
const normalizeRequest = (body) => {
	const errors = [];
	const where = ["anchor", "anchorUrl", "free"].filter((key) => body?.[key] != null && body[key] !== "" && body[key] !== false);
	if (where.length > 1) errors.push("anchor・anchorUrl・free はどれか 1 つだけ指定します");
	const direction = (value, label) => {
		if (value == null || value === "") return null;
		const id = MiroLayoutPlan.parseDirection(value);
		if (id == null) errors.push(`${label} は ${MiroLayoutPlan.DIRECTIONS.join(" / ")}(または 右・左上・十字 など)のどれかです(${JSON.stringify(value)})`);
		return id;
	};
	const title = (value, label) => {
		if (value == null || value === "") return null;
		const text = String(value).replace(/\s+/g, " ").trim();
		if ([...text].length > 100) errors.push(`${label} は 100 文字までです`);
		return text;
	};
	const seen = new Set();
	const resolveIds = async (ids, label) => {
		if (ids == null) return null;
		if (!Array.isArray(ids)) {
			errors.push(`${label} は配列です`);
			return [];
		}
		const result = [];
		for (const raw of ids) {
			const id = String(raw ?? "");
			// 古い版の ID でも、同じ資料ならいまの版を出す
			const doc = await currentDocument(id);
			if (doc == null) {
				errors.push(`無い資料です(${id})`);
				continue;
			}
			if (doc.archived) {
				errors.push(`アーカイブされた資料です(${id})`);
				continue;
			}
			if (seen.has(doc.id)) {
				errors.push(`同じ資料が 2 回指定されています(${id})`);
				continue;
			}
			seen.add(doc.id);
			result.push(doc);
		}
		return result;
	};
	return {errors, where: where[0] ?? null, direction, title, resolveIds};
};

/**
 * フロー図の指示を検める(miro-diagram.js)。箱に documentId があれば、その資料を Document Manager で開くリンクにする
 * @returns {Promise<?object>} 正しくなければ null(理由は errors に入れる)
 */
const resolveDiagram = async (spec, label, errors, target) => {
	const {errors: found, diagram} = MiroDiagram.normalizeDiagram(spec, label);
	errors.push(...found);
	if (diagram == null) return null;
	for (const [i, node] of diagram.nodes.entries()) {
		if (node.documentId == null) continue;
		const doc = await currentDocument(node.documentId);
		if (doc == null || doc.archived) {
			errors.push(`${label}.nodes[${i}].documentId は${doc == null ? "無い" : "アーカイブされた"}資料です(${node.documentId})`);
			continue;
		}
		node.link = aliasUrl(target.publicBaseUrl, doc.alias);
	}
	return diagram;
};

/**
 * 書き出しを始める(資料を置くのは裏で行う)。目印・資料・向きはここで確かめ、正しくなければ何もせずに断る。
 * @param {object} body project?(プロジェクト ID)・documentIds?・groups?・direction?・title?・anchor / anchorUrl / free
 * @returns {Promise<object>} 書き出しの記録(state: running)
 */
module.exports.exportDocuments = async (user, body = {}) => {
	const target = await requireTarget();
	let project = null;
	if (body.project != null && body.project !== "") {
		project = await Projects.getProject(String(body.project));
		if (project == null) throw exportError("プロジェクトがありません", 404);
	}
	const request = normalizeRequest(body);
	const topDirection = request.direction(body.direction, "direction");
	const topTitle = request.title(body.title, "title");
	let groups;
	if (body.diagram != null && (body.groups != null || body.documentIds != null)) {
		request.errors.push("diagram は groups・documentIds と一緒に指定できません(資料と図を一緒に出すときは groups の中に書きます)");
	}
	if (body.diagram != null && body.groups == null) {
		groups = [{documents: [], direction: null, title: null, diagram: await resolveDiagram(body.diagram, "diagram", request.errors, target)}];
	} else if (body.groups != null) {
		if (body.documentIds != null) request.errors.push("groups と documentIds は一緒に指定できません(groups の中に書きます)");
		if (!Array.isArray(body.groups) || body.groups.length === 0 || body.groups.length > 20) {
			request.errors.push("groups は 1〜20 個の配列です");
			groups = [];
		} else {
			groups = [];
			for (const [i, g] of body.groups.entries()) {
				const direction = request.direction(g?.direction, `groups[${i}].direction`);
				const title = request.title(g?.title, `groups[${i}].title`);
				// 組は、資料(documentIds)かフロー図(diagram)のどちらか
				if (g?.diagram != null) {
					if (g.documentIds != null) request.errors.push(`groups[${i}] は documentIds か diagram のどちらか一方です`);
					groups.push({documents: [], direction, title, diagram: await resolveDiagram(g.diagram, `groups[${i}].diagram`, request.errors, target)});
					continue;
				}
				const docs = await request.resolveIds(g?.documentIds, `groups[${i}].documentIds`);
				if (docs == null || docs.length === 0) request.errors.push(`groups[${i}].documentIds に資料を 1 件以上指定します(フロー図なら diagram)`);
				groups.push({documents: docs ?? [], direction, title});
			}
		}
	} else {
		let docs = await request.resolveIds(body.documentIds, "documentIds");
		if (docs == null) {
			if (project == null) request.errors.push("documentIds(書き出す文書 ID)か、project(そのプロジェクトの資料を全部)を指定します");
			else docs = await projectDocuments(project);
		}
		groups = [{documents: docs ?? [], direction: null, title: null}];
	}
	const total = groups.reduce((n, g) => n + g.documents.length, 0);
	const diagrams = groups.filter((g) => g.diagram != null).length;
	if (total === 0 && diagrams === 0 && request.errors.length === 0) request.errors.push("書き出す資料がありません(プロジェクトに資料が無いか、documentIds が空です)");
	if (total > MAX_DOCUMENTS) request.errors.push(`1 回に書き出せるのは ${MAX_DOCUMENTS} 件までです(${total} 件)`);
	if (request.errors.length > 0) throw exportError("書き出しの指示に正しくないところがあります(何もしていません)", 400, {details: request.errors.slice(0, 50)});

	// 書き出す場所
	const board = target.boardId;
	let anchor = null;
	let anchorKind;
	if (request.where == null) {
		throw exportError("書き出す場所の目印がありません。ボードに「[DM]名前」の付箋を置いて anchor にその名前を渡すか、付箋・図形のリンクを anchorUrl に渡してください。"
			+ "目印を使わず、ボードの中身の右の空いている所に出してよいか利用者に確かめてから、free: true でも書き出せます", 409, {code: "anchor_required"});
	}
	// 目印を探す(空いている所に出すときは、置く直前に読む)
	const scan = request.where === "free" ? [] : await scanBoard(board);
	if (request.where === "anchor") {
		anchorKind = "marker";
		const wanted = normalizeName(body.anchor);
		const anchors = findAnchors(scan);
		const matched = anchors.filter(({parsed}) => normalizeName(parsed.name) === wanted);
		if (matched.length === 0) {
			throw exportError(`ボードに目印「${body.anchor}」がありません`, 404, {code: "anchor_not_found", anchors: anchors.map(({parsed}) => parsed.name).filter(Boolean)});
		}
		if (matched.length > 1) {
			throw exportError(`目印「${body.anchor}」がボードに ${matched.length} つあります。Miro で名前を変えるか、付箋のリンクを anchorUrl に渡してください`, 409,
				{code: "anchor_ambiguous", anchors: matched.map(({entry, parsed}) => anchorOf(target, entry, parsed))});
		}
		anchor = {entry: matched[0].entry, parsed: matched[0].parsed};
	} else if (request.where === "anchorUrl") {
		anchorKind = "link";
		const ref = parseItemUrl(body.anchorUrl);
		if (ref == null) throw exportError("anchorUrl は Miro の「リンクをコピー」で取った付箋・図形のリンクです(…/app/board/…/?moveToWidget=…)", 400, {code: "invalid_anchor_url"});
		if (ref.boardId !== board) throw exportError("リンクのボードが、書き出すボード(管理画面の「Miro 連携」で選んだもの)と違います", 400, {code: "board_mismatch"});
		const entry = scan.find((e) => e.id === ref.itemId);
		if (entry == null) throw exportError("リンクの項目がボードにありません(消されたか、枠の中の枠などの読めない所にあります)", 404, {code: "anchor_not_found"});
		anchor = {entry, parsed: ANCHOR_TYPES.includes(entry.type) ? parseAnchorText(entry.item.data?.content) : null};
	} else {
		anchorKind = "free";
	}
	// 目印の向きが読めないときは、頼みで向きを言われていなければ断る(勝手に右へ出さない)
	const everyGroupHasDirection = topDirection != null || groups.every((g) => g.direction != null);
	if (anchor?.parsed?.directionText != null && anchor.parsed.direction == null && !everyGroupHasDirection) {
		throw exportError(`目印を読めません: ${anchor.parsed.problem}`, 400, {code: "anchor_unreadable"});
	}
	const baseTitle = topTitle ?? (anchor?.parsed?.name || null) ?? project?.name ?? "Document Manager";
	const when = stamp();
	const plannedGroups = groups.map((g) => ({
		documents: g.documents,
		direction: g.direction ?? topDirection ?? anchor?.parsed?.direction ?? MiroLayoutPlan.DEFAULT_DIRECTION,
		title: g.title ?? baseTitle,
		...(g.diagram ? {diagram: g.diagram} : {})
	}));
	// 十字は資料をタグで分ける並べ方なので、フロー図には使えない(目印が十字なら向きを言ってもらう)
	if (plannedGroups.some((g) => g.diagram && g.direction === "cross")) {
		throw exportError("フロー図は十字では出せません。direction で向き(右・下・右下 など)を指定してください", 400, {code: "diagram_direction"});
	}

	const exportId = crypto.randomUUID();
	await ds.run(SQL_INSERT_EXPORT, {
		id: exportId, project_id: project?.id ?? null, board_id: board, anchor_kind: anchorKind, anchor_name: anchor?.parsed?.name ?? null, anchor_item_id: anchor?.entry.id ?? null,
		title: baseTitle, request: JSON.stringify({groups: plannedGroups.map((g) => ({direction: g.direction, title: g.title, documentIds: g.documents.map((d) => d.id),
			...(g.diagram ? {diagram: g.diagram} : {})}))}),
		created_by: user, created_at: new Date().toISOString()
	});
	logger.info({audit: "miro_export_started", user, projectId: project?.id ?? null, exportId, anchor: anchorKind, anchorName: anchor?.parsed?.name ?? null, documents: total, diagrams}, "audit");
	const job = {exportId, user, target, project, groups: plannedGroups, when, anchorId: anchor?.entry.id ?? null};
	// 同じ台の書き出しは 1 つずつ(続けて頼まれても、あとのものが先のフレームを避けられるように)
	running.add(exportId);
	queue = queue.then(() => runExport(job)).catch(() => null);
	return exportView(target, await ds.get(SQL_GET_EXPORT, [exportId]));
};

// この台で書き出している書き出しと、書き出しの順番
const running = new Set();
let queue = Promise.resolve();

/** 書き出しの本体(裏で動く) */
const runExport = async (job) => {
	const {exportId, user, target, project} = job;
	const board = target.boardId;
	const call = (fn) => MiroConnection.withToken((token) => fn(token));
	const results = [];
	const frames = [];
	const cards = [];
	const finish = async (state, error = null) => {
		const count = (s) => results.filter((r) => r.state === s).length;
		await ds.run(SQL_FINISH_EXPORT, {
			id: exportId, state, frames: JSON.stringify(frames), cards: JSON.stringify(cards), documents: JSON.stringify(results),
			placed: count(STATES.PLACED), skipped: count(STATES.SKIPPED), failed: count(STATES.FAILED), error, finished_at: new Date().toISOString()
		});
	};
	try {
		// 中身を用意する(変換は時間がかかるので、置く前にまとめて済ませる)
		const ready = new Map();
		for (const group of job.groups) {
			for (const doc of group.documents) {
				if (ready.has(doc.id)) continue;
				const payload = await preparePayload(doc);
				if (payload.skip == null && payload.file.length > MAX_UPLOAD_BYTES) {
					payload.skip = `Miro に置ける大きさ(6MB)を超えています(${(payload.file.length / 1024 / 1024).toFixed(1)}MB)`;
				}
				ready.set(doc.id, payload.skip != null ? {doc, skip: payload.skip} : {doc, payload, height: LAYOUT.itemWidth * aspectOf(payload.file, payload.contentType)});
			}
		}
		for (const entry of ready.values()) {
			if (entry.skip) results.push({documentId: entry.doc.id, title: entry.doc.entry_file, state: STATES.SKIPPED, reason: entry.skip});
		}

		// 置き場所を決める。ボードは置く直前に読み直す(頼まれてから変換を待つあいだに、目印が動かされた・
		// ほかの書き出しのフレームができた、ことがあるため)。ボードにあるものとは重ねない
		// 十字の振り分けに使うタグ・フォルダ名(プロジェクトを渡されたときは、そのプロジェクトのフォルダ名も使う)
		const input = await MiroLayout.loadDocumentsInput(job.groups.flatMap((g) => g.documents.map((d) => d.id)), project);
		const scan = await scanBoard(board);
		let anchorBox = null;
		if (job.anchorId != null) {
			anchorBox = scan.find((e) => e.id === job.anchorId)?.box ?? null;
			if (anchorBox == null) throw new Error("書き出す前に、目印が Miro で消されました");
		}
		const obstacles = scan.filter((e) => e.parentId == null && e.id !== job.anchorId).map((e) => e.box);
		// 同じ目印に前に出した斜めのフレームのマス(消されたフレームは数えない。動かされていれば今の位置)
		const placed = [];
		if (job.anchorId != null) {
			const frameBoxes = new Map(scan.filter((e) => e.parentId == null).map((e) => [String(e.id), e.box]));
			for (const row of await ds.all(SQL_FRAMES_AT_ANCHOR, [board, job.anchorId])) {
				for (const f of parseJson(row.frames, [])) {
					if (Array.isArray(f.cell) && frameBoxes.has(String(f.frameId))) placed.push({direction: f.direction, cell: f.cell, box: frameBoxes.get(String(f.frameId))});
				}
			}
		}
		const groups = job.groups.map((g) => {
			if (g.diagram) {
				const layout = MiroDiagram.layoutDiagram(g.diagram);
				return {direction: g.direction, title: g.title, documents: [], frameSize: {width: layout.width, height: layout.height}, diagram: layout};
			}
			return {
				direction: g.direction, title: g.title,
				documents: g.documents.filter((d) => ready.get(d.id)?.payload).map((d) => ({documentId: d.id, title: d.entry_file, height: ready.get(d.id).height}))
			};
		}).filter((g) => g.documents.length > 0 || g.diagram);
		const plan = MiroLayoutPlan.planExport({
			groups, anchor: anchorBox, free: anchorBox == null ? freeSpot(scan) : null, obstacles, placed,
			input, geometry: LAYOUT
		});

		// フレームを作って、資料を置く(中身 → 見出し → グループ)。数件ずつ同時に書き込む
		const now = () => new Date().toISOString();
		for (const planned of plan.frames) {
			const title = `${planned.title} [${job.when}]`;
			// フレームを作れなかったら(Miro の一時的な不調でやり直しても断られたとき)、そのフレームの資料だけを失敗にして、
			// ほかのフレームと概要カードは置き切る(途中で止めると、残りが何も出ない)
			let frame;
			try {
				frame = await call((token) => Miro.createFrame(token, board, {
					title, x: planned.left + planned.width / 2, y: planned.top + planned.height / 2, width: planned.width, height: planned.height
				}));
			} catch (err) {
				if (err.needsReconnect) throw err;
				logger.warn({exportId, title, error: err.message, requestId: err.requestId ?? null}, "フレームを作れませんでした(このフレームの資料を飛ばして続けます)");
				if (planned.diagram) {
					results.push({kind: "diagram", documentId: null, title, state: STATES.FAILED, ...failureCode(err),
						reason: `フレーム「${title}」を作れませんでした: ${String(err.message).slice(0, 200)}`});
				}
				for (const item of planned.items) {
					const {doc} = ready.get(item.documentId);
					results.push({documentId: doc.id, title: doc.entry_file, state: STATES.FAILED, ...failureCode(err),
						reason: `フレーム「${title}」を作れませんでした: ${String(err.message).slice(0, 200)}`});
				}
				continue;
			}
			const record = {frameId: String(frame.id), title, direction: planned.direction, area: planned.area, ...(planned.cell ? {cell: planned.cell} : {}), left: planned.left, top: planned.top,
				width: planned.width, height: planned.height};
			frames.push(record);
			if (planned.diagram) {
				// フロー図: 資料の代わりに、箱と線を描く。途中で断られたら、そこまでを残して失敗にする(出し直しは新しいフレームに)
				record.diagram = {nodes: {}, lanes: [], connectors: []};
				try {
					await drawDiagram(board, record, planned.diagram);
					results.push({kind: "diagram", documentId: null, title, state: STATES.PLACED, frameId: record.frameId,
						nodes: Object.keys(record.diagram.nodes).length, edges: record.diagram.connectors.length});
				} catch (err) {
					if (err.needsReconnect) throw err;
					logger.warn({exportId, title, error: err.message, requestId: err.requestId ?? null}, "フロー図を描き切れませんでした");
					results.push({kind: "diagram", documentId: null, title, state: STATES.FAILED, frameId: record.frameId, ...failureCode(err),
						reason: `フロー図を描き切れませんでした(箱 ${Object.keys(record.diagram.nodes).length}/${planned.diagram.nodes.length}・線 ${record.diagram.connectors.length}/${planned.diagram.edges.length}): ${String(err.message).slice(0, 200)}`});
				}
				continue;
			}
			await forEachConcurrently(planned.items, CONCURRENCY, async (item) => {
				const {doc, payload, height: plannedHeight} = ready.get(item.documentId);
				let itemId = null;
				try {
					const created = await call((token) => Miro.createFile(token, board, payload.kind, {
						title: doc.entry_file, x: item.x, y: item.y, width: LAYOUT.itemWidth, parentId: record.frameId,
						file: payload.file, fileName: payload.fileName, contentType: payload.contentType
					}));
					itemId = created.id;
					const height = created.geometry?.height ?? plannedHeight;
					const caption = await call((token) => Miro.createText(token, board, {
						content: captionHtml({title: doc.entry_file, uploadedAt: doc.uploaded_at, url: aliasUrl(target.publicBaseUrl, doc.alias)}),
						x: item.x, y: item.y + height / 2 + LAYOUT.captionHeight / 2, width: LAYOUT.itemWidth, parentId: record.frameId,
						...(item.color ? {style: {fillColor: item.color, fillOpacity: "1"}} : {})
					}));
					const group = await call((token) => Miro.createGroup(token, board, [created.id, caption.id])).catch((err) => {
						logger.warn({err: err.message}, "資料と見出しをグループにできませんでした(それぞれは置いてあります)");
						return null;
					});
					await ds.run(SQL_INSERT_ITEM, {export_id: exportId, alias: doc.alias, document_id: doc.id, item_id: String(created.id), item_kind: payload.kind,
						caption_id: String(caption.id), group_id: group?.id != null ? String(group.id) : null, title: doc.entry_file,
						x: item.x, y: item.y, width: created.geometry?.width ?? LAYOUT.itemWidth, height, frame_id: record.frameId, updated_by: user, updated_at: now()});
					results.push({documentId: doc.id, title: doc.entry_file, state: STATES.PLACED, frameId: record.frameId});
				} catch (err) {
					if (err.needsReconnect) throw err;
					// 中身だけ置けて見出しで失敗したときは、中途半端に残さない
					if (itemId != null) await call((token) => Miro.deleteItem(token, board, itemId)).catch(() => {});
					results.push({documentId: doc.id, title: doc.entry_file, state: STATES.FAILED, ...failureCode(err), reason: String(err.message).slice(0, 300), frameId: record.frameId});
				}
			});
		}
		// 十字の概要カード(目印のすぐ下。フレームには入れない。プロジェクトを渡されたときだけ)
		for (const card of plan.cards) {
			const created = await call((token) => Miro.createText(token, board, {
				content: `<p>${linked(`<strong>${textHtml(card.text)}</strong>`, projectUrlOf(target, project?.id))}</p>`,
				x: card.x, y: card.y, width: card.width,
				style: {fontSize: String(card.fontSize), fillColor: "#ffffff", fillOpacity: "1", textAlign: "center"}
			})).catch((err) => {
				if (err.needsReconnect) throw err;
				logger.warn({err: err.message, exportId}, "概要カードを置けませんでした");
				return null;
			});
			if (created != null) cards.push({id: String(created.id), text: card.text});
		}
		const failed = results.filter((r) => r.state === STATES.FAILED).length;
		const temporary = results.filter((r) => r.retryable).length;
		await finish("done", failed === 0 ? null : temporary === failed
			? `${failed} 件を置けませんでした(Miro が一時的に断りました。間を空けて 3 回やり直しても通りませんでした)。少し時間をおいて、置けなかった資料だけ出し直せます`
			: `${failed} 件を置けませんでした(Miro が断りました。資料ごとの理由を見てください)`);
		logger.info({audit: "miro_export_done", user, projectId: project?.id ?? null, exportId, frames: frames.length, placed: results.filter((r) => r.state === STATES.PLACED).length, failed}, "audit");
	} catch (err) {
		const message = err.needsReconnect ? err.message : `Miro に書き出せませんでした: ${err.message}`;
		logger.warn({exportId, error: err.message}, "Miro への書き出しに失敗しました");
		await finish("failed", message.slice(0, 500)).catch(() => {});
	} finally {
		running.delete(exportId);
	}
};

/**
 * フロー図を描く(フレームの中。位置は miro-diagram.js の layoutDiagram で決めたもの)。
 * レーンの帯 → 見出し → 箱 → 線の順に置く(Miro では、あとから置いたものが上に重なる)。描いたものの ID は record.diagram に残す
 */
const drawDiagram = async (board, record, layout) => {
	const make = (fn) => MiroConnection.withToken((token) => fn(token));
	const frameId = record.frameId;
	for (const lane of layout.lanes) {
		const band = await make((token) => Miro.createShape(token, board, {
			shape: "rectangle", content: "", ...lane.band, parentId: frameId,
			style: {fillColor: lane.fill, borderColor: lane.border, borderWidth: "1"}
		}));
		record.diagram.lanes.push(String(band.id));
		const header = await make((token) => Miro.createShape(token, board, {
			shape: "rectangle", content: `<p><strong>${escapeHtml(lane.title)}</strong></p>`, ...lane.header, parentId: frameId,
			style: {fillColor: lane.headerFill, borderColor: lane.border, borderWidth: "1", fontSize: "18"}
		}));
		record.diagram.lanes.push(String(header.id));
	}
	// 付箋の島: 島の枠(背景) → 見出し
	for (const island of layout.islands ?? []) {
		const band = await make((token) => Miro.createShape(token, board, {
			shape: "round_rectangle", content: "", ...island.band, parentId: frameId,
			style: {fillColor: "#ffffff", fillOpacity: "1", borderColor: island.border, borderWidth: "3"}
		}));
		record.diagram.lanes.push(String(band.id));
		if (island.titleAt) {
			const title = await make((token) => Miro.createText(token, board, {
				content: `<p><strong>${escapeHtml(island.title)}</strong></p>`, ...island.titleAt, parentId: frameId,
				style: {fontSize: "28", textAlign: "left"}
			}));
			record.diagram.lanes.push(String(title.id));
		}
	}
	const ids = {};
	await forEachConcurrently(layout.nodes, CONCURRENCY, async (node) => {
		const content = `<p>${linked(textHtml(node.text), node.link)}</p>`;
		const item = node.item === "sticky"
			// 付箋は幅だけを渡す(高さは Miro が決める)
			? await make((token) => Miro.createStickyNote(token, board, {
				content, shape: "square", fillColor: node.color, x: node.x, y: node.y, width: node.width, parentId: frameId,
				style: {textAlign: "center", textAlignVertical: "middle"}
			}))
			: await make((token) => Miro.createShape(token, board, {
				shape: node.shape, content,
				x: node.x, y: node.y, width: node.width, height: node.height, parentId: frameId,
				style: {fillColor: node.fill, borderColor: node.border, borderWidth: "2", color: node.color, fontSize: "14"}
			}));
		ids[node.key] = String(item.id);
	});
	// 箱の並びは指示の順で残す
	for (const node of layout.nodes) if (ids[node.key]) record.diagram.nodes[node.key] = ids[node.key];
	await forEachConcurrently(layout.edges, CONCURRENCY, async (edge) => {
		const connector = await make((token) => Miro.createConnector(token, board, {
			startId: ids[edge.from], endId: ids[edge.to], shape: edge.line, caption: edge.label ? escapeHtml(edge.label) : null, style: edge.style
		}));
		record.diagram.connectors.push(String(connector.id));
	});
};

/** 置けなかった理由の印。code: miro_unavailable(一時的。出し直せば通るかもしれない)・miro_error(Miro が断った) */
const failureCode = (err) => (Miro.isTemporary(err) ? {code: "miro_unavailable", retryable: true} : {code: "miro_error", retryable: false});

/** 書き出しの記録を、画面・API の形にする */
const exportView = (target, row, {withDocuments = true, projects = new Map()} = {}) => {
	if (row == null) return null;
	const frames = parseJson(row.frames, []);
	const staleRunning = row.state === "running" && !running.has(row.id) && Date.now() - Date.parse(row.created_at) > LOCK_MS * 2;
	return {
		id: row.id,
		state: staleRunning ? "failed" : row.state,
		createdAt: row.created_at,
		createdBy: row.created_by,
		finishedAt: row.finished_at ?? null,
		title: row.title,
		project: row.project_id ? {id: row.project_id, name: projects.get(row.project_id) ?? null} : null,
		anchor: {kind: row.anchor_kind, name: row.anchor_name ?? null, url: itemUrl(target, row.anchor_item_id)},
		frames: frames.map((f) => ({...f, url: itemUrl(target, f.frameId)})),
		counts: {placed: Number(row.placed ?? 0), skipped: Number(row.skipped ?? 0), failed: Number(row.failed ?? 0)},
		error: staleRunning ? "書き出しが途中で止まりました(サーバーが止まったなど)。もう一度書き出してください" : row.error ?? null,
		...(withDocuments ? retryView(parseJson(row.documents, [])) : {})
	};
};
// 資料ごとの結果と、出し直せる資料(一時的に断られたもの。同じ目印に、この ID だけで書き出し直す)
const retryView = (documents) => ({
	documents,
	retryDocumentIds: documents.filter((d) => d.state === STATES.FAILED && d.retryable && d.documentId != null).map((d) => d.documentId),
	// 一時的に断られたフロー図の名前(同じ図の頼みをもう一度送れば出し直せる)
	retryDiagrams: documents.filter((d) => d.kind === "diagram" && d.state === STATES.FAILED && d.retryable).map((d) => d.title)
});
const projectNames = async (rows) => {
	const names = new Map();
	for (const id of new Set(rows.map((r) => r.project_id).filter(Boolean))) names.set(id, (await Projects.getProject(id))?.name ?? null);
	return names;
};

/** 1 つの書き出しの記録(書き出しを頼んだあと、終わるのを待つのに使う) */
module.exports.getExport = async (exportId) => {
	const target = await MiroConnection.target().catch(() => null);
	const row = await ds.get(SQL_GET_EXPORT, [exportId]);
	return exportView(target, row, {projects: await projectNames(row ? [row] : [])});
};

/** 書き出しの状態と履歴(新しい順。画面・API の応答) */
module.exports.listExports = async ({limit = 30} = {}) => {
	const target = await MiroConnection.target().catch(() => null);
	const rows = await ds.all(SQL_LIST_EXPORTS, [Math.max(1, Math.min(200, Number(limit) || 30))]);
	const projects = await projectNames(rows);
	const exports = rows.map((row) => exportView(target, row, {withDocuments: false, projects}));
	return {
		available: target != null,
		boardUrl: target?.boardUrl ?? null,
		exporting: running.size > 0 || exports.some((e) => e.state === "running"),
		directions: MiroLayoutPlan.DIRECTIONS.map((id) => ({id, name: MiroLayoutPlan.DIRECTION_NAMES[id]})),
		exports
	};
};

// ---- 書き出したあとの手直し(書き出しの記録ごと) ----
// 人が Miro で動かしたあとでも正しく動かせるよう、動かす前に Miro からいまの位置を読み直す。
// 資料と見出しはグループにしてあるが、API で動かすときは1つずつ動かす必要がある(実物で確かめた)ので、
// 見出しも資料の下へ一緒に動かす

const SIDES = Object.freeze(["right", "left", "above", "below"]);
module.exports.SIDES = SIDES;

/** 手直しする書き出し。ID を省くと、頼んだ人の最後の書き出し(このボードで、終わったもの) */
const exportFor = async (exportId, user) => {
	const target = await requireTarget();
	const row = exportId != null && exportId !== ""
		? await ds.get(SQL_GET_EXPORT, [String(exportId)])
		: await ds.get(SQL_LAST_EXPORT_OF, [user, target.boardId]);
	if (row == null) {
		throw exportError(exportId ? "その書き出しはありません" : "まだ Miro に書き出していません(書き出しが終わってから手直しできます)", exportId ? 404 : 409, {code: "no_export"});
	}
	if (row.state !== "done") throw exportError("その書き出しは終わっていないか、失敗しています", 409, {code: "export_not_done"});
	if (row.board_id !== target.boardId) throw exportError("その書き出しのボードと、いまのボードが違います(書き出し直してください)", 409, {code: "board_changed"});
	return {target, row, frames: parseJson(row.frames, [])};
};

/** 書き出した資料を、文書 ID から引く。版が変わっていても、同じ資料なら引ける */
const placedRowOf = async (exportId, documentId) => {
	const current = await currentDocument(String(documentId ?? ""));
	const alias = current == null ? null : current.archived ? await DocumentAliases.aliasOf(current.row.id) : current.alias;
	const row = alias == null ? null : await ds.get(SQL_GET_ITEM, [exportId, alias]);
	if (row == null || row.item_id == null) throw exportError("この資料は、この書き出しで Miro に出ていません", 404);
	return row;
};

/** いま Miro にある位置と大きさを読む(消されていれば 404 の例外) */
const readPlacement = async (board, row) => {
	const item = await MiroConnection.withToken((token) => Miro.getItem(token, board, row.item_id));
	return {
		x: Number(item.position?.x), y: Number(item.position?.y),
		width: Number(item.geometry?.width ?? row.width), height: Number(item.geometry?.height ?? row.height),
		parentId: item.parent?.id != null ? String(item.parent.id) : null
	};
};

/** 資料を、置き場所(枠の左上からの中心の位置)へ動かし、見出しを下へ付ける */
const placeAt = async (board, row, {x, y, parentId}) => {
	await MiroConnection.withToken((token) => Miro.moveItem(token, board, row.item_id, {x, y, parentId}));
	if (row.caption_id) {
		await MiroConnection.withToken((token) => Miro.moveItem(token, board, row.caption_id, {
			x, y: y + Number(row.height || 0) / 2 + LAYOUT.captionHeight / 2, parentId
		})).catch((err) => {
			if (err.status !== 404) throw err;
		});
	}
};

/**
 * フレームを広げる(縮めない。左上は動かさない。中の項目は左上からの位置なので、中心を動かさずに変えると、
 * 中身ごと上や左へずれて見える)。書き出しの記録の大きさも直す
 */
const growFrame = async (board, exportRow, frames, frameId, {width, height}) => {
	const frame = frames.find((f) => f.frameId === frameId);
	if (frame == null) return;
	const nextWidth = Math.ceil(Math.max(frame.width, width));
	const nextHeight = Math.ceil(Math.max(frame.height, height));
	if (nextWidth === frame.width && nextHeight === frame.height) return;
	await MiroConnection.withToken((token) => Miro.updateFrame(token, board, frameId, {
		width: nextWidth, height: nextHeight, x: frame.left + nextWidth / 2, y: frame.top + nextHeight / 2
	}));
	Object.assign(frame, {width: nextWidth, height: nextHeight});
	await ds.run(SQL_SET_EXPORT_FRAMES, {id: exportRow.id, frames: JSON.stringify(frames)});
};

/** フレームを ID か名前(日時を除いた部分でもよい)で引く */
const frameOf = (frames, ref) => {
	if (ref == null || ref === "") return null;
	const wanted = String(ref).trim();
	const found = frames.find((f) => f.frameId === wanted) ?? frames.find((f) => f.title === wanted)
		?? frames.filter((f) => f.title.replace(/\s*\[[^\]]*\]$/, "") === wanted)[0];
	if (found == null) throw exportError(`この書き出しのフレームに「${wanted}」はありません(${frames.map((f) => f.title).join(" / ")})`, 404);
	return found;
};

/**
 * ボードの地図(LLM が置き場所を考えるための材料)。書き出したフレームの中を Miro から読み、次を返す。ボードは変えない。
 *   frames[].documents    資料ごとの位置と大きさ(見出しの下端も)
 *   frames[].decorations  Document Manager が指示で置いた見出しの文字・図形
 *   frames[].others       人が Miro で足したもの(付箋・図形・文字など。Document Manager は触らない)
 *   frames[].freeSpace    中身の右と下の空いている所の目安
 * 位置はフレームごとに、その左上から。x・y は中心、left・top・right・bottom は端。
 */
module.exports.boardMap = async (exportId, user) => {
	const {target, row, frames} = await exportFor(exportId, user);
	const board = target.boardId;
	const rows = (await ds.all(SQL_LIST_ITEMS, [row.id])).filter((r) => r.item_id != null);
	const decorations = parseJson(row.decorations, {});
	const located = new Set();
	const result = [];
	for (const frame of frames) {
		const children = [];
		let cursor;
		do {
			const page = await MiroConnection.withToken((token) => Miro.listItems(token, board, {parentId: frame.frameId, cursor})).catch((err) => {
				if (err.status === 404) return {data: []};
				throw err;
			});
			children.push(...(page.data || []));
			cursor = page.cursor;
		} while (cursor && children.length < 5000);
		const byId = new Map(children.map((item) => [String(item.id), item]));
		const known = new Set();
		const localBox = (item) => roundBox(absoluteBox(item, null));
		const documents = [];
		for (const r of rows) {
			const item = byId.get(String(r.item_id));
			if (item == null) continue;
			located.add(r.alias);
			known.add(String(r.item_id));
			if (r.caption_id) known.add(String(r.caption_id));
			const caption = r.caption_id ? byId.get(String(r.caption_id)) : null;
			const box = localBox(item);
			documents.push({documentId: r.document_id, title: r.title, ...box, bottomWithCaption: caption ? localBox(caption).bottom : box.bottom + LAYOUT.captionHeight});
		}
		const decor = (decorations[frame.frameId]?.decor ?? []).map((d) => {
			known.add(String(d.id));
			const item = byId.get(String(d.id));
			return item == null ? null : {id: String(d.id), kind: item.type === "shape" ? "shape" : "label", text: plainText(item.data?.content), ...localBox(item)};
		}).filter(Boolean);
		// フロー図の箱(key で線をつなげる)とレーン
		const nodes = Object.entries(frame.diagram?.nodes ?? {}).map(([key, id]) => {
			known.add(String(id));
			const item = byId.get(String(id));
			return item == null ? null : {key, id: String(id), text: plainText(item.data?.content), ...localBox(item)};
		}).filter(Boolean);
		for (const id of frame.diagram?.lanes ?? []) known.add(String(id));
		const others = children.filter((item) => !known.has(String(item.id)) && item.type !== "group").map((item) => ({
			id: String(item.id), type: item.type, text: plainText(item.data?.content ?? item.data?.title ?? ""), ...localBox(item)
		}));
		// 読む順(上から、同じ段は左から)
		documents.sort((a, b) => (Math.abs(a.top - b.top) > 1 ? a.top - b.top : a.left - b.left));
		let right = 0;
		let bottom = 0;
		for (const box of [...documents.map((d) => ({...d, bottom: d.bottomWithCaption})), ...decor, ...nodes, ...others]) {
			right = Math.max(right, box.right);
			bottom = Math.max(bottom, box.bottom);
		}
		result.push({
			frameId: frame.frameId, title: frame.title, direction: frame.direction, area: frame.area ?? null, url: itemUrl(target, frame.frameId),
			width: frame.width, height: frame.height, documents, decorations: decor, others,
			...(frame.diagram ? {diagram: {nodes, connectors: (frame.diagram.connectors ?? []).length}} : {}),
			freeSpace: {
				// 中身(資料・見出し・図形・人が足したもの)の下と右。ここに置けば何とも重ならない(フレームは広がる)
				below: {left: LAYOUT.padding, top: Math.round(bottom + LAYOUT.gapY * 2)},
				right: {left: Math.round(right + LAYOUT.gapX * 2), top: LAYOUT.padding}
			}
		});
	}
	return {
		exportId: row.id,
		projectId: row.project_id ?? null,
		exportedAt: row.created_at,
		coordinates: "位置はフレームごとに、その左上から。x・y は中心、left・top・right・bottom は端。miro-layout・miro-move にも同じ座標で渡す",
		frames: result,
		// この書き出しの資料で、どのフレームにも見当たらないもの(Miro で消された・フレームの外へ出された)
		missing: rows.filter((r) => !located.has(r.alias)).map((r) => ({documentId: r.document_id, title: r.title})),
		cardSize: {width: LAYOUT.itemWidth, captionHeight: LAYOUT.captionHeight}
	};
};

/**
 * 資料を動かす(書き出したフレームの中・同じ書き出しのフレームどうし)。指示は次のどれか1つ:
 *   {nextTo: 文書ID, side: "right"|"left"|"above"|"below"}  ほかの資料の隣へ
 *   {frame?: フレームの ID か名前, x, y}                        フレームの左上からの位置へ(資料の中心。frame を省くといまのフレーム)
 */
module.exports.moveDocument = async (exportId, documentId, instruction, user) => {
	const {target, row: exportRow, frames} = await exportFor(exportId, user);
	const board = target.boardId;
	const row = await placedRowOf(exportRow.id, documentId);
	if (!(await takeLock(exportRow.id))) throw exportError("いまこの書き出しをほかの頼みで直しています。終わってからやり直してください", 409);
	try {
		const current = await readPlacement(board, row).catch((err) => {
			if (err.status === 404) throw exportError("この資料は Miro で消されています", 404);
			throw err;
		});
		row.width = current.width;
		row.height = current.height;
		let destination;
		if (instruction.nextTo != null) {
			const side = instruction.side ?? "right";
			if (!SIDES.includes(side)) throw exportError("side は right / left / above / below のどれかです");
			const reference = await placedRowOf(exportRow.id, instruction.nextTo).catch(() => {
				throw exportError("隣に置く相手の資料が、この書き出しで Miro に出ていません", 404);
			});
			if (reference.alias === row.alias) throw exportError("自分自身の隣には置けません");
			const ref = await readPlacement(board, reference);
			const horizontal = (ref.width + current.width) / 2 + LAYOUT.gapX;
			// 縦に並べるときは、上の資料の見出しの分も空ける
			const below = ref.height / 2 + LAYOUT.captionHeight + LAYOUT.gapY + current.height / 2;
			const above = current.height / 2 + LAYOUT.captionHeight + LAYOUT.gapY + ref.height / 2;
			destination = {
				x: side === "right" ? ref.x + horizontal : side === "left" ? ref.x - horizontal : ref.x,
				y: side === "below" ? ref.y + below : side === "above" ? ref.y - above : ref.y,
				parentId: ref.parentId
			};
		} else if (Number.isFinite(Number(instruction.x)) && Number.isFinite(Number(instruction.y)) && instruction.x !== null && instruction.y !== null) {
			if (Number(instruction.x) < 0 || Number(instruction.y) < 0) throw exportError("x と y はフレームの左上からの位置です(0 以上)");
			const frame = frameOf(frames, instruction.frame) ?? frames.find((f) => f.frameId === current.parentId);
			if (frame == null) throw exportError("動かす先のフレームを frame に指定してください(資料が書き出したフレームの外にあります)");
			destination = {x: Number(instruction.x), y: Number(instruction.y), parentId: frame.frameId};
		} else {
			throw exportError("nextTo(と side)か、x と y(と frame)を指定してください");
		}
		if (destination.parentId == null || !frames.some((f) => f.frameId === destination.parentId)) {
			throw exportError("この書き出しのフレームの外へは動かせません");
		}
		if (destination.x - current.width / 2 < 0 || destination.y - current.height / 2 < 0) {
			throw exportError("フレームの左・上の端からはみ出します(フレームは右と下にだけ広げられます)");
		}
		// はみ出す位置なら、フレームを広げる(左上は動かさない)
		await growFrame(board, exportRow, frames, destination.parentId, {
			width: destination.x + current.width / 2 + LAYOUT.padding,
			height: destination.y + current.height / 2 + LAYOUT.captionHeight + LAYOUT.padding
		});
		await placeAt(board, row, destination);
		await ds.run(SQL_SET_POSITION, [destination.x, destination.y, row.width, row.height, destination.parentId, user, new Date().toISOString(), exportRow.id, row.alias]);
		logger.info({audit: "miro_document_moved", user, exportId: exportRow.id, documentId, instruction}, "audit");
		return {exportId: exportRow.id, x: destination.x, y: destination.y, frameId: destination.parentId};
	} finally {
		await releaseLock(exportRow.id);
	}
};

// ---- まとめて置き直す・見出しや図形を足す(書き出したフレームの 1 つ) ----

const LAYOUT_LIMITS = Object.freeze({items: 2000, labels: 500, shapes: 500, connectors: 500, maxCoordinate: 200000, textLength: 300});
const SHAPE_KINDS = MiroDiagram.SHAPE_KINDS;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
module.exports.LAYOUT_LIMITS = LAYOUT_LIMITS;
module.exports.SHAPE_KINDS = SHAPE_KINDS;

/** 指示を検め、Miro に渡す形にする。正しくないものがあれば、何も当てずに理由の一覧を返す */
const normalizeLayout = (layout) => {
	const errors = [];
	const number = (value, label, {min = 0, max = LAYOUT_LIMITS.maxCoordinate} = {}) => {
		const n = Number(value);
		if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n < min || n > max) {
			errors.push(`${label} は ${min} 以上 ${max} 以下の数です(${JSON.stringify(value)})`);
			return 0;
		}
		return n;
	};
	const color = (value, label) => {
		if (value == null) return null;
		if (!COLOR_PATTERN.test(String(value))) errors.push(`${label} は #rrggbb の形の色です(${JSON.stringify(value)})`);
		return String(value);
	};
	const text = (value, label) => {
		const s = String(value ?? "");
		if (s.length === 0 || s.length > LAYOUT_LIMITS.textLength) errors.push(`${label} は 1〜${LAYOUT_LIMITS.textLength} 文字です`);
		return s;
	};
	const url = (value, label) => {
		const s = String(value);
		if (!/^https?:\/\/\S+$/.test(s) || s.length > 2000) errors.push(`${label} は http:// か https:// で始まる URL です`);
		return s;
	};
	const list = (value, key) => {
		if (value == null) return [];
		if (!Array.isArray(value)) {
			errors.push(`${key} は配列です`);
			return [];
		}
		if (value.length > LAYOUT_LIMITS[key]) errors.push(`${key} は ${LAYOUT_LIMITS[key]} 件までです(${value.length} 件)`);
		return value;
	};
	const items = list(layout?.items, "items").map((item, i) => ({
		documentId: String(item?.documentId ?? ""),
		x: number(item?.x, `items[${i}].x`),
		y: number(item?.y, `items[${i}].y`),
		// 色の指定が無ければ見出しの色は変えない。null を明示すると色を外す
		...(item && "color" in item ? {color: color(item.color, `items[${i}].color`), setColor: true} : {})
	}));
	const seen = new Set();
	for (const item of items) {
		if (seen.has(item.documentId)) errors.push(`同じ資料が2回指定されています(${item.documentId})`);
		seen.add(item.documentId);
	}
	const labels = list(layout?.labels, "labels").map((label, i) => ({
		text: text(label?.text, `labels[${i}].text`),
		x: number(label?.x, `labels[${i}].x`),
		y: number(label?.y, `labels[${i}].y`),
		width: number(label?.width ?? 400, `labels[${i}].width`, {min: 40, max: 50000}),
		fontSize: label?.fontSize == null ? null : number(label.fontSize, `labels[${i}].fontSize`, {min: 10, max: 288}),
		color: color(label?.color, `labels[${i}].color`),
		fillColor: color(label?.fillColor, `labels[${i}].fillColor`),
		bold: label?.bold !== false,
		align: ["left", "center", "right"].includes(label?.align) ? label.align : "left",
		...(label?.link == null ? {} : {link: url(label.link, `labels[${i}].link`)})
	}));
	const shapes = list(layout?.shapes, "shapes").map((shape, i) => {
		const kind = shape?.shape ?? "rectangle";
		if (!SHAPE_KINDS.includes(kind)) errors.push(`shapes[${i}].shape は ${SHAPE_KINDS.join(" / ")} のどれかです`);
		// key を付けた図形は、connectors の from・to で指せる
		const key = shape?.key == null || shape.key === "" ? null : String(shape.key);
		if (key != null && [...key].length > 60) errors.push(`shapes[${i}].key は 60 文字までです`);
		return {
			...(key != null ? {key} : {}),
			shape: kind,
			text: shape?.text == null ? "" : String(shape.text).slice(0, LAYOUT_LIMITS.textLength),
			x: number(shape?.x, `shapes[${i}].x`),
			y: number(shape?.y, `shapes[${i}].y`),
			// Miro の図形は幅・高さとも 8 以上
			width: number(shape?.width, `shapes[${i}].width`, {min: 8, max: 100000}),
			height: number(shape?.height, `shapes[${i}].height`, {min: 8, max: 100000}),
			fillColor: color(shape?.fillColor, `shapes[${i}].fillColor`),
			fillOpacity: shape?.fillOpacity == null ? null : number(shape.fillOpacity, `shapes[${i}].fillOpacity`, {min: 0, max: 1}),
			borderColor: color(shape?.borderColor, `shapes[${i}].borderColor`),
			// 枠線の太さに 0 は指定できない(省けば枠線は見えない)
			borderWidth: shape?.borderWidth == null ? null : number(shape.borderWidth, `shapes[${i}].borderWidth`, {min: 1, max: 24}),
			borderStyle: ["normal", "dotted", "dashed"].includes(shape?.borderStyle) ? shape.borderStyle : null,
			...(shape?.link == null ? {} : {link: url(shape.link, `shapes[${i}].link`)})
		};
	});
	const shapeKeys = new Set();
	for (const shape of shapes) {
		if (shape.key == null) continue;
		if (shapeKeys.has(shape.key)) errors.push(`shapes の key「${shape.key}」が 2 回あります`);
		shapeKeys.add(shape.key);
	}
	// 線: from・to は、この指示の図形の key・フロー図の箱の key・この書き出しの資料の文書 ID のどれか
	const connectors = list(layout?.connectors, "connectors").map((c, i) => {
		const at = `connectors[${i}]`;
		const ref = (value, side) => {
			const r = value == null ? "" : String(value);
			if (r === "") errors.push(`${at}.${side} が要ります(図形の key・フロー図の箱の key・資料の文書 ID)`);
			return r;
		};
		const line = c?.line == null ? "elbowed" : String(c.line);
		if (!["elbowed", "straight", "curved"].includes(line)) errors.push(`${at}.line は elbowed / straight / curved のどれかです`);
		const stroke = c?.style == null ? "solid" : String(c.style);
		if (!["solid", "dashed", "dotted"].includes(stroke)) errors.push(`${at}.style は solid / dashed / dotted のどれかです`);
		const arrow = c?.arrow == null ? "end" : String(c.arrow);
		if (!["end", "both", "none"].includes(arrow)) errors.push(`${at}.arrow は end / both / none のどれかです`);
		const label = c?.label == null || c.label === "" ? null : String(c.label);
		if (label != null && [...label].length > 100) errors.push(`${at}.label は 100 文字までです`);
		return {from: ref(c?.from, "from"), to: ref(c?.to, "to"), label, line, stroke, arrow, color: color(c?.color, `${at}.color`)};
	});
	const frame = layout?.frame == null ? null : {
		width: number(layout.frame.width, "frame.width", {min: 400, max: LAYOUT_LIMITS.maxCoordinate}),
		height: number(layout.frame.height, "frame.height", {min: 400, max: LAYOUT_LIMITS.maxCoordinate})
	};
	// clearDecorations: true だけを渡すと、前に指示して置いた見出しの文字・図形を片付ける
	const clearDecorations = layout?.clearDecorations === true;
	if (items.length === 0 && labels.length === 0 && shapes.length === 0 && connectors.length === 0 && frame == null && !clearDecorations) {
		errors.push("items・labels・shapes・connectors・frame のどれかを指定してください(指示して置いた見出し・図形・線を消すだけなら clearDecorations: true)");
	}
	return {errors, exportRef: layout?.exportId ?? null, frameRef: layout?.frameId ?? null, items, labels, shapes, connectors, frame, keepDecorations: layout?.keepDecorations === true};
};
module.exports.normalizeLayout = normalizeLayout;

/**
 * レイアウトをまとめて当てる(書き出したフレームの 1 つ。exportId を省くと頼んだ人の最後の書き出し、frameId を省くと最初のフレーム)。
 * 位置はすべて、そのフレームの左上からの中心の位置。フレームは広げるだけで縮めない(左上は動かさない)。
 * 見出しの文字・図形は Document Manager が覚えておき、次に当てるときに片付けてから置く(keepDecorations なら残して足す)。
 * @param {{exportId?: string, frameId?: string, items?: Array<{documentId: string, x: number, y: number, color?: ?string}>,
 *          labels?: object[], shapes?: object[], frame?: {width: number, height: number}, keepDecorations?: boolean, clearDecorations?: boolean}} layout
 */
module.exports.applyLayout = async (layout, user) => {
	const plan = normalizeLayout(layout);
	const {target, row: exportRow, frames} = await exportFor(plan.exportRef, user);
	const board = target.boardId;
	let frame = null;
	try {
		frame = frameOf(frames, plan.frameRef) ?? frames[0];
	} catch (err) {
		plan.errors.push(err.message);
	}
	// 資料は、この書き出しで出したものだけ(版が変わっていても同じ資料なら引ける)
	const rows = new Map();
	for (const item of plan.items) {
		const row = await placedRowOf(exportRow.id, item.documentId).catch(() => null);
		if (row == null) plan.errors.push(`この資料は、この書き出しで Miro に出ていません(${item.documentId})`);
		else rows.set(item.documentId, row);
	}
	// 線の両端: この指示の図形の key → フロー図の箱の key → この書き出しの資料
	const shapeKeys = new Set(plan.shapes.map((sh) => sh.key).filter((k) => k != null));
	const diagramNodes = frame?.diagram?.nodes ?? {};
	const ends = new Map();
	for (const [i, c] of plan.connectors.entries()) {
		for (const side of ["from", "to"]) {
			const ref = c[side];
			if (ref === "" || ends.has(ref)) continue;
			if (shapeKeys.has(ref)) ends.set(ref, {shapeKey: ref});
			else if (diagramNodes[ref] != null) ends.set(ref, {itemId: String(diagramNodes[ref])});
			else {
				const row = await placedRowOf(exportRow.id, ref).catch(() => null);
				if (row?.item_id != null) ends.set(ref, {itemId: String(row.item_id)});
				else plan.errors.push(`connectors[${i}].${side}「${ref}」は、この指示の図形の key・フロー図の箱の key・この書き出しの資料の文書 ID のどれでもありません`);
			}
		}
	}
	if (plan.errors.length > 0) throw exportError("レイアウトの指示に正しくないところがあります(何も動かしていません)", 400, {details: plan.errors.slice(0, 50)});
	if (!(await takeLock(exportRow.id))) throw exportError("いまこの書き出しをほかの頼みで直しています。終わってからやり直してください", 409);
	try {
		const heightOf = (row) => Number(row.height) || LAYOUT.itemWidth * LAYOUT.defaultAspect;
		const widthOf = (row) => Number(row.width) || LAYOUT.itemWidth;
		// フレームを先に広げる(はみ出した位置に置くと、Miro が断る)
		let right = 0;
		let bottom = 0;
		for (const item of plan.items) {
			const row = rows.get(item.documentId);
			right = Math.max(right, item.x + widthOf(row) / 2);
			bottom = Math.max(bottom, item.y + heightOf(row) / 2 + LAYOUT.captionHeight);
		}
		for (const label of plan.labels) {
			right = Math.max(right, label.x + label.width / 2);
			bottom = Math.max(bottom, label.y + (label.fontSize ?? 36));
		}
		for (const shape of plan.shapes) {
			right = Math.max(right, shape.x + shape.width / 2);
			bottom = Math.max(bottom, shape.y + shape.height / 2);
		}
		await growFrame(board, exportRow, frames, frame.frameId, {
			width: Math.max(plan.frame?.width ?? 0, right + LAYOUT.padding),
			height: Math.max(plan.frame?.height ?? 0, bottom + LAYOUT.padding)
		});
		const drawn = await drawDecorations(exportRow.id, board, frame.frameId, {...plan, ends});

		let moved = 0;
		await forEachConcurrently(plan.items, CONCURRENCY, async (item) => {
			const row = rows.get(item.documentId);
			try {
				await placeAt(board, row, {x: item.x, y: item.y, parentId: frame.frameId});
			} catch (err) {
				// Miro で消されていた資料は飛ばす
				if (err.status === 404) return;
				throw err;
			}
			if (item.setColor && row.caption_id) {
				await MiroConnection.withToken((token) => Miro.updateText(token, board, row.caption_id, {
					style: item.color ? {fillColor: item.color, fillOpacity: "1"} : {fillOpacity: "0"}
				})).catch((err) => {
					if (err.status !== 404) throw err;
				});
			}
			await ds.run(SQL_SET_POSITION, [item.x, item.y, row.width, row.height, frame.frameId, user, new Date().toISOString(), exportRow.id, row.alias]);
			moved++;
		});
		const current = frames.find((f) => f.frameId === frame.frameId);
		logger.info({audit: "miro_layout_applied", user, exportId: exportRow.id, frameId: frame.frameId, moved, labels: drawn.labels, shapes: drawn.shapes, connectors: drawn.connectors}, "audit");
		return {exportId: exportRow.id, frameId: frame.frameId, moved, labels: drawn.labels, shapes: drawn.shapes, connectors: drawn.connectors, frame: {width: current.width, height: current.height}};
	} finally {
		await releaseLock(exportRow.id);
	}
};

/**
 * 指示で置く見出しの文字・図形。フレームごとに ID と中身を覚え、次に当てるときに片付ける
 * (keepDecorations なら前のものを残して足す)。人が Miro で足した付箋などには触らない
 */
const decorationKey = (kind, spec) => `${kind}:${JSON.stringify(spec)}`;
const drawDecorations = async (exportId, board, frameId, {labels, shapes, connectors = [], ends = new Map(), keepDecorations}) => {
	const all = parseJson((await ds.get(SQL_GET_EXPORT, [exportId]))?.decorations, {});
	const before = all[frameId] ?? {decor: [], labels: [], shapes: [], connectors: []};
	if (!keepDecorations) {
		// 線を先に消す(図形を消せば線も消えるが、資料どうしをつないだ線は残るため)
		const ordered = [...before.decor.filter((d) => d.key.startsWith("connector:")), ...before.decor.filter((d) => !d.key.startsWith("connector:"))];
		for (const d of ordered) {
			const remove = d.key.startsWith("connector:") ? Miro.deleteConnector : Miro.deleteItem;
			await MiroConnection.withToken((token) => remove(token, board, d.id)).catch((err) => {
				if (err.status !== 404) logger.warn({err: err.message}, "見出しの文字・図形・線を消せませんでした");
			});
		}
	}
	const wanted = [...shapes.map((spec) => ({kind: "shape", spec})), ...labels.map((spec) => ({kind: "label", spec}))];
	// 図形 → 見出しの文字の順に置く(あとから置いたものが上に重なる)。並びは指示の順のまま覚える
	const create = async (list) => {
		const created = new Array(list.length).fill(null);
		await forEachConcurrently(list.map((w, index) => ({w, index})), CONCURRENCY, async ({w, index}) => {
			const {spec} = w;
			const item = w.kind === "shape"
				? await MiroConnection.withToken((token) => Miro.createShape(token, board, {
					shape: spec.shape, content: spec.text ? `<p>${linked(escapeHtml(spec.text), spec.link)}</p>` : "",
					x: spec.x, y: spec.y, width: spec.width, height: spec.height, parentId: frameId,
					style: Object.fromEntries(Object.entries({
						fillColor: spec.fillColor, fillOpacity: spec.fillOpacity == null ? null : String(spec.fillOpacity),
						borderColor: spec.borderColor, borderWidth: spec.borderWidth == null ? null : String(spec.borderWidth), borderStyle: spec.borderStyle
					}).filter(([, v]) => v != null))
				}))
				: await MiroConnection.withToken((token) => Miro.createText(token, board, {
					content: `<p>${linked(spec.bold ? `<strong>${textHtml(spec.text)}</strong>` : textHtml(spec.text), spec.link)}</p>`,
					x: spec.x, y: spec.y, width: spec.width, parentId: frameId,
					style: Object.fromEntries(Object.entries({
						fontSize: spec.fontSize == null ? null : String(spec.fontSize), color: spec.color,
						fillColor: spec.fillColor, fillOpacity: spec.fillColor ? "1" : null, textAlign: spec.align
					}).filter(([, v]) => v != null))
				}));
			created[index] = {key: decorationKey(w.kind, spec), id: String(item.id)};
		});
		return created.filter(Boolean);
	};
	const createdShapes = await create(wanted.filter((w) => w.kind === "shape"));
	const createdLabels = await create(wanted.filter((w) => w.kind === "label"));
	// key を付けた図形の ID(線の両端に使う)
	const shapeIds = new Map();
	for (const d of createdShapes) {
		const spec = shapes.find((sh) => decorationKey("shape", sh) === d.key);
		if (spec?.key != null) shapeIds.set(spec.key, d.id);
	}
	const idOf = (ref) => {
		const end = ends.get(ref);
		return end?.shapeKey != null ? shapeIds.get(end.shapeKey) : end?.itemId;
	};
	const createdConnectors = [];
	await forEachConcurrently(connectors, CONCURRENCY, async (c) => {
		const connector = await MiroConnection.withToken((token) => Miro.createConnector(token, board, {
			startId: idOf(c.from), endId: idOf(c.to), shape: c.line, caption: c.label ? escapeHtml(c.label) : null,
			style: {strokeColor: c.color ?? "#4a5568", strokeWidth: "2", strokeStyle: c.stroke === "solid" ? "normal" : c.stroke,
				startStrokeCap: c.arrow === "both" ? "arrow" : "none", endStrokeCap: c.arrow === "none" ? "none" : "arrow"}
		}));
		createdConnectors.push({key: decorationKey("connector", c), id: String(connector.id)});
	});
	const created = [...createdShapes, ...createdLabels, ...createdConnectors];
	all[frameId] = {
		decor: [...(keepDecorations ? before.decor : []), ...created],
		labels: [...(keepDecorations ? before.labels : []), ...labels],
		shapes: [...(keepDecorations ? before.shapes : []), ...shapes],
		connectors: [...(keepDecorations ? before.connectors ?? [] : []), ...connectors]
	};
	await ds.run(SQL_SET_EXPORT_DECORATIONS, {id: exportId, decorations: JSON.stringify(all)});
	return {labels: createdLabels.length, shapes: createdShapes.length, connectors: createdConnectors.length};
};

module.exports.INSTANCE_ID = INSTANCE_ID;
