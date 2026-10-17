/*!
 * miro-sync.js : プロジェクトの資料を Miro のボードへ並べ、出しっぱなしのあいだ変更を反映する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- 形 ----
 * 連携で選んだボード1枚に、プロジェクトごとの枠(フレーム)を1つ作り、その中に資料を並べる。
 * 資料1件 = 中身(PDF・画像)+ 見出し(名前・更新日・Document Manager で開くリンク)を、
 * グループにまとめて置く(人が動かすと一緒に動く)。
 *
 * 資料は版をまたいで変わらない共有用のID(alias)で覚える。新しい版が出たら、同じ項目のまま中身だけを
 * 差し替える(人が動かした位置・大きさは保つ)。
 *
 * ---- 資料ごとの状態(miro_items.state) ----
 *   placed    ボードに出ている
 *   skipped   出せない(形式が対象外・6MB超・変換サービスが無いなど)。理由は reason。毎回出せるか見直す
 *   failed    Miro が断った。次の同期でやり直す
 *   excluded  利用者が「出さない」にした
 *   removed   Miro で消された。**勝手には戻さない**(不要だから外した、とみなす)
 *   detached  プロジェクトから外れた・アーカイブされた。周りの付箋が宙に浮かないよう、ボードからは消さずに見出しで知らせる
 *
 * ---- いつ同期するか ----
 *   - 連動を始めたとき・「今すぐ反映」
 *   - 文書・プロジェクトが変わったとき(server.js の変更通知から。少しまとめてから動く)
 *   - 定期的(既定15分。Miro 側で消された・動かされたことは、こちらからは分からないので見に行く)
 * 1つのプロジェクトを同時に2台が同期しないよう、データベースの上で順番を取る(miro-connection.js と同じ考え方)。
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

// ---- 並べ方(単位は Miro のボード上の長さ) ----
const LAYOUT = Object.freeze({
	columns: Number(process.env.MIRO_LAYOUT_COLUMNS || 6),
	itemWidth: 360,
	gapX: 60,
	captionHeight: 80,
	gapY: 60,
	padding: 80,
	headerHeight: 70,
	// プロジェクトの枠どうしの間
	frameGap: 400,
	// 縦横比が分からないときは A4 縦とみなす
	defaultAspect: 297 / 210
});
const frameWidth = () => LAYOUT.padding * 2 + LAYOUT.columns * LAYOUT.itemWidth + (LAYOUT.columns - 1) * LAYOUT.gapX;

// Miro に置けるファイルの上限(Miro の API の上限)
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;

const SYNC_LOCK_MS = Number(process.env.MIRO_SYNC_LOCK_SECONDS || 600) * 1000;
// 資料を置くとき、同時に書き込む件数。1件ごとに Miro を3回呼ぶ(中身・見出し・グループ)ので、1件ずつだと
// 1件あたり約5秒かかった(実物で76件に約7分)。多くしすぎると Miro の回数制限に当たる
const CONCURRENCY = Math.max(1, Number(process.env.MIRO_SYNC_CONCURRENCY || 4));

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
const INTERVAL_MS = Number(process.env.MIRO_SYNC_INTERVAL_MINUTES || 15) * 60 * 1000;
const DEBOUNCE_MS = Number(process.env.MIRO_SYNC_DEBOUNCE_SECONDS || 5) * 1000;
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

const STATES = Object.freeze({PLACED: "placed", SKIPPED: "skipped", FAILED: "failed", EXCLUDED: "excluded", REMOVED: "removed", DETACHED: "detached"});
module.exports.STATES = STATES;

// ---- SQL ----
const SQL_GET_PROJECT = `SELECT * FROM miro_projects WHERE project_id = ?`;
const SQL_LIST_ACTIVE = `SELECT project_id FROM miro_projects WHERE state = 'active'`;
const SQL_LIST_FRAMES = `SELECT frame_x, frame_y, frame_width, frame_height FROM miro_projects WHERE board_id = ? AND frame_id IS NOT NULL`;
const SQL_UPSERT_PROJECT = `
	INSERT INTO miro_projects (project_id, board_id, state, linked_by, linked_at)
	VALUES (@project_id, @board_id, 'active', @user, @now)
	ON CONFLICT(project_id) DO UPDATE SET state = 'active', board_id = excluded.board_id, linked_by = excluded.linked_by,
		linked_at = excluded.linked_at, stopped_by = NULL, stopped_at = NULL, last_error = NULL
`;
const SQL_SET_FRAME = `UPDATE miro_projects SET frame_id = @frame_id, frame_x = @x, frame_y = @y, frame_width = @width, frame_height = @height WHERE project_id = @project_id`;
const SQL_SET_HEADERS = `UPDATE miro_projects SET header_ids = @header_ids WHERE project_id = @project_id`;
const SQL_SET_DECORATIONS = `UPDATE miro_projects SET header_ids = @header_ids, layout_plan = @layout_plan WHERE project_id = @project_id`;
const SQL_SET_LAYOUT_PLAN = `UPDATE miro_projects SET layout_plan = @layout_plan WHERE project_id = @project_id`;
const SQL_SET_LAYOUT = `UPDATE miro_projects SET layout = @layout WHERE project_id = @project_id`;
const SQL_SET_LAYOUT_UNDO = `UPDATE miro_projects SET layout_undo = @layout_undo WHERE project_id = @project_id`;
const SQL_SET_SYNCED = `UPDATE miro_projects SET last_synced_at = @now, last_error = @error WHERE project_id = @project_id`;
const SQL_STOP_PROJECT = `UPDATE miro_projects SET state = 'stopped', stopped_by = @user, stopped_at = @now, last_error = @error WHERE project_id = @project_id`;
const SQL_TAKE_LOCK = `
	UPDATE miro_projects SET sync_lock_owner = @owner, sync_lock_until = @until
	WHERE project_id = @project_id AND (sync_lock_owner IS NULL OR sync_lock_until IS NULL OR sync_lock_until < @now)
`;
const SQL_RELEASE_LOCK = `UPDATE miro_projects SET sync_lock_owner = NULL, sync_lock_until = NULL WHERE project_id = @project_id AND sync_lock_owner = @owner`;
const SQL_LIST_ITEMS = `SELECT * FROM miro_items WHERE project_id = ?`;
const SQL_UPSERT_ITEM = `
	INSERT INTO miro_items (project_id, alias, board_id, document_id, item_id, item_kind, caption_id, group_id, title, state, reason, x, y, width, height, placed_x, placed_y, updated_by, updated_at)
	VALUES (@project_id, @alias, @board_id, @document_id, @item_id, @item_kind, @caption_id, @group_id, @title, @state, @reason, @x, @y, @width, @height, @placed_x, @placed_y, @updated_by, @updated_at)
	ON CONFLICT(project_id, alias) DO UPDATE SET board_id = excluded.board_id, document_id = excluded.document_id, item_id = excluded.item_id,
		item_kind = excluded.item_kind, caption_id = excluded.caption_id, group_id = excluded.group_id, title = excluded.title, state = excluded.state,
		reason = excluded.reason, x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
		placed_x = excluded.placed_x, placed_y = excluded.placed_y, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`;
const SQL_SELECT_DOCUMENT = `SELECT id, entry_file, preview_file, size, uploaded_at, deleted_at, render_status, render_file FROM documents WHERE id = ?`;

// ---- 呼び出し側から渡されるもの ----
let preparePayload = null;
/**
 * @param {{preparePayload: (doc: object) => Promise<{kind: "documents"|"images", file: Buffer, fileName: string, contentType: string}|{skip: string}>}} deps
 */
module.exports.init = (deps) => {
	preparePayload = deps.preparePayload;
};

// ---- 小さな部品 ----

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));

/** 資料の見出し(名前・更新日・Document Manager で開くリンク) */
const captionHtml = ({title, uploadedAt, url, note}) => {
	const date = uploadedAt ? new Date(uploadedAt).toLocaleDateString("ja-JP", {timeZone: process.env.TZ || "Asia/Tokyo"}) : "";
	const link = url ? ` · <a href="${escapeHtml(url)}">Document Manager で開く</a>` : "";
	const mark = note ? `<br><em>${escapeHtml(note)}</em>` : "";
	return `<p><strong>${escapeHtml(title)}</strong><br>${escapeHtml(date)} 更新${link}${mark}</p>`;
};
module.exports.captionHtml = captionHtml;

const aliasUrl = (publicBaseUrl, alias) => (publicBaseUrl ? `${String(publicBaseUrl).replace(/\/+$/, "")}/api/documents/alias/${alias}/viewer` : null);

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

/**
 * プロジェクトの資料を、おしながきと同じ順に並べる(フォルダごとの見出し付き)。
 * @returns {Promise<{project: object, sections: Array<{title: ?string, documents: object[]}>}|null>}
 */
const desiredDocuments = async (projectId) => {
	const project = await Projects.getProject(projectId);
	if (project == null) return null;
	const tree = await Projects.getProjectTree(projectId);
	const manifest = ProjectManifest.build(project, tree);
	const sections = [];
	sections.push({title: null, documents: manifest.rootDocuments});
	const walk = (folders, prefix) => {
		for (const folder of folders) {
			const title = prefix ? `${prefix} / ${folder.name}` : folder.name;
			sections.push({title, documents: folder.documents});
			walk(folder.folders, title);
		}
	};
	walk(manifest.folders, "");
	const loaded = [];
	for (const section of sections) {
		const documents = [];
		for (const placement of section.documents) {
			const row = await ds.get(SQL_SELECT_DOCUMENT, [placement.documentId]);
			if (row == null) continue;
			const alias = (await DocumentAliases.aliasOf(row.id)) ?? (await DocumentAliases.assign(row.id));
			documents.push({...row, alias, archived: row.deleted_at != null});
		}
		loaded.push({title: section.title, documents});
	}
	return {project, sections: loaded};
};

// ---- 順番取り ----

const takeLock = async (projectId) => {
	const now = new Date();
	const result = await ds.run(SQL_TAKE_LOCK, {project_id: projectId, owner: INSTANCE_ID, until: new Date(now.getTime() + SYNC_LOCK_MS).toISOString(), now: now.toISOString()});
	return Number(result?.changes ?? 0) > 0;
};
const releaseLock = (projectId) => ds.run(SQL_RELEASE_LOCK, {project_id: projectId, owner: INSTANCE_ID}).catch(() => {});

// ---- 枠 ----

/** 新しい枠の置き場所。これまでに作った枠の右側(同じボード) */
const nextFramePosition = async (boardId, height) => {
	const frames = await ds.all(SQL_LIST_FRAMES, [boardId]);
	let right = null;
	for (const frame of frames) {
		const edge = Number(frame.frame_x) + Number(frame.frame_width) / 2;
		if (Number.isFinite(edge)) right = right == null ? edge : Math.max(right, edge);
	}
	const width = frameWidth();
	const x = right == null ? 0 : right + LAYOUT.frameGap + width / 2;
	return {x, y: height / 2, width};
};

/** 置いてあるフォルダの見出しを消す(Miro で消されていれば何もしない) */
const deleteHeaders = async (link, board) => {
	let ids = [];
	try {
		ids = JSON.parse(link?.header_ids || "[]");
	} catch {
		ids = [];
	}
	for (const id of ids) {
		await MiroConnection.withToken((token) => Miro.deleteItem(token, board, id)).catch((err) => {
			if (err.status !== 404) logger.warn({err: err.message}, "フォルダの見出しを消せませんでした");
		});
	}
	if (ids.length > 0 && link?.project_id) await ds.run(SQL_SET_HEADERS, {project_id: link.project_id, header_ids: "[]"});
};

/**
 * Document Manager が置く見出しの文字・図形を置き、ID と中身を覚える(次に置き直すときに片付けるため、
 * 「元の型に戻す」で同じものを置き直すため)。keep のときは前に置いたものを残して足す。
 * tolerant のときは、置けなかったものを飛ばして続ける(初めて並べるときのフォルダの見出し)。
 * labels・shapes は normalizeLayout() と同じ形。
 */
const drawDecorations = async (projectId, link, board, frameId, {labels = [], shapes = []}, {keep = false, tolerant = false} = {}) => {
	const previous = parseJson(link.layout_plan, {});
	let ids = [];
	let keptLabels = [];
	let keptShapes = [];
	if (keep) {
		ids = parseJson(link.header_ids, []);
		keptLabels = previous.labels ?? [];
		keptShapes = previous.shapes ?? [];
	} else {
		await deleteHeaders(link, board);
	}
	const skip = (what) => (err) => {
		if (!tolerant || err.needsReconnect) throw err;
		logger.warn({err: err.message, projectId}, `${what}を置けませんでした`);
		return null;
	};
	// 図形 → 見出しの文字の順に置く(あとから置いたものが上に重なる)
	const createdShapes = [];
	await forEachConcurrently(shapes, CONCURRENCY, async (shape) => {
		const created = await MiroConnection.withToken((token) => Miro.createShape(token, board, {
			shape: shape.shape, content: shape.text ? `<p>${escapeHtml(shape.text)}</p>` : "",
			x: shape.x, y: shape.y, width: shape.width, height: shape.height, parentId: frameId,
			style: Object.fromEntries(Object.entries({
				fillColor: shape.fillColor, fillOpacity: shape.fillOpacity == null ? null : String(shape.fillOpacity),
				borderColor: shape.borderColor, borderWidth: shape.borderWidth == null ? null : String(shape.borderWidth), borderStyle: shape.borderStyle
			}).filter(([, v]) => v != null))
		})).catch(skip("図形"));
		if (created != null) createdShapes.push(created.id);
	});
	const createdLabels = [];
	await forEachConcurrently(labels, CONCURRENCY, async (label) => {
		const body = label.bold ? `<strong>${escapeHtml(label.text)}</strong>` : escapeHtml(label.text);
		const created = await MiroConnection.withToken((token) => Miro.createText(token, board, {
			content: `<p>${body}</p>`, x: label.x, y: label.y, width: label.width, parentId: frameId,
			style: Object.fromEntries(Object.entries({
				fontSize: label.fontSize == null ? null : String(label.fontSize), color: label.color,
				fillColor: label.fillColor, fillOpacity: label.fillColor ? "1" : null, textAlign: label.align
			}).filter(([, v]) => v != null))
		})).catch(skip("見出し"));
		if (created != null) createdLabels.push(created.id);
	});
	const headerIds = JSON.stringify([...ids, ...createdShapes, ...createdLabels]);
	const layoutPlan = JSON.stringify({...previous, labels: [...keptLabels, ...labels], shapes: [...keptShapes, ...shapes]});
	await ds.run(SQL_SET_DECORATIONS, {project_id: projectId, header_ids: headerIds, layout_plan: layoutPlan});
	Object.assign(link, {header_ids: headerIds, layout_plan: layoutPlan});
	return {labels: createdLabels.length, shapes: createdShapes.length};
};

// ---- 1プロジェクトの同期 ----

/**
 * 1つのプロジェクトをボードに合わせる。
 * @param {string} projectId
 * @param {{checkMiro?: boolean, user?: string}} [options] checkMiro: Miro 側で消された・動かされたかも見に行く(定期)
 * @returns {Promise<{placed: number, created: number, replaced: number, skipped: number, failed: number}>}
 */
const syncProject = async (projectId, {checkMiro = false, user = "system"} = {}) => {
	const link = await ds.get(SQL_GET_PROJECT, [projectId]);
	if (link == null || link.state !== "active") return null;
	const target = await MiroConnection.target();
	if (target == null) {
		await ds.run(SQL_SET_SYNCED, {project_id: projectId, now: new Date().toISOString(), error: "Miro と連携していないか、貼り先のボードが決まっていません(管理画面の「Miro 連携」)"});
		return null;
	}
	if (!(await takeLock(projectId))) {
		logger.debug({projectId}, "ほかの台が同期中のため、今回は見送ります");
		return null;
	}
	const counts = {placed: 0, created: 0, replaced: 0, skipped: 0, failed: 0, removed: 0};
	try {
		await MiroConnection.withToken(async () => null);
		const desired = await desiredDocuments(projectId);
		if (desired == null) return null;
		const board = target.boardId;
		const call = (fn) => MiroConnection.withToken((token) => fn(token));
		const items = new Map((await ds.all(SQL_LIST_ITEMS, [projectId])).map((row) => [row.alias, row]));
		const now = () => new Date().toISOString();
		const save = (row) => ds.run(SQL_UPSERT_ITEM, {
			project_id: projectId, board_id: board, document_id: null, item_id: null, item_kind: null, caption_id: null, group_id: null,
			title: null, reason: null, x: null, y: null, width: null, height: null, placed_x: null, placed_y: null, updated_by: user, updated_at: now(), ...row
		});

		// 枠。Miro 側で消されていたら、連動をやめる(消したのは人の判断なので、作り直さない)
		let frameId = link.frame_id;
		if (frameId != null && checkMiro) {
			try {
				const frame = await call((token) => Miro.getItem(token, board, frameId));
				await ds.run(SQL_SET_FRAME, {project_id: projectId, frame_id: frameId, x: frame.position?.x ?? link.frame_x, y: frame.position?.y ?? link.frame_y,
					width: frame.geometry?.width ?? link.frame_width, height: frame.geometry?.height ?? link.frame_height});
			} catch (err) {
				if (err.status !== 404) throw err;
				await ds.run(SQL_STOP_PROJECT, {project_id: projectId, user: "system", now: now(), error: "Miro で枠が消されたため、連動を止めました(もう一度「Miro と連動」を押すと、新しい枠に並べ直します)"});
				logger.info({projectId}, "Miro で枠が消されたため、連動を止めました");
				return null;
			}
		}

		// Miro 側で消された資料を見つける(定期の同期だけ)。位置も読み直して覚える(動かす指示の基準にするため)
		if (checkMiro) {
			for (const row of items.values()) {
				if (row.state !== STATES.PLACED || row.item_id == null) continue;
				try {
					const item = await call((token) => Miro.getItem(token, board, row.item_id));
					const sameParent = item.parent?.id == null || item.parent.id === frameId;
					row.x = item.position?.x ?? row.x;
					row.y = item.position?.y ?? row.y;
					row.width = item.geometry?.width ?? row.width;
					row.height = item.geometry?.height ?? row.height;
					await save({...row, reason: sameParent ? null : "枠の外へ動かされています"});
				} catch (err) {
					if (err.status !== 404) throw err;
					if (row.caption_id) await call((token) => Miro.deleteItem(token, board, row.caption_id)).catch(() => {});
					row.state = STATES.REMOVED;
					await save({...row, state: STATES.REMOVED, reason: "Miro で消されました(もう一度出すときは、資料ごとに「出す」を選ぶ)"});
					counts.removed++;
				}
			}
		}

		// どの資料をどうするか決める
		const desiredAliases = new Set();
		const toCreate = [];
		const toReplace = [];
		for (const section of desired.sections) {
			for (const doc of section.documents) {
				desiredAliases.add(doc.alias);
				const row = items.get(doc.alias);
				if (row?.state === STATES.EXCLUDED || row?.state === STATES.REMOVED) continue;
				if (doc.archived) continue;
				if (row?.state === STATES.PLACED) {
					if (row.document_id === doc.id) {
						counts.placed++;
						continue;
					}
					toReplace.push({doc, row});
					continue;
				}
				// まだ出ていない・前回は出せなかった・Miro が断った・プロジェクトから外れていた
				toCreate.push({doc, row, section: section.title});
			}
		}

		// 中身を用意する(変換は時間がかかるので、置く前にまとめて済ませる)
		const prepare = async (doc, row) => {
			const payload = await preparePayload(doc);
			if (payload.skip) return {skip: payload.skip};
			if (payload.file.length > MAX_UPLOAD_BYTES) {
				return {skip: `Miro に置ける大きさ(6MB)を超えています(${(payload.file.length / 1024 / 1024).toFixed(1)}MB)`};
			}
			return payload;
		};

		// 新しい版は、同じ項目のまま中身を差し替える(位置・大きさはそのまま)
		for (const {doc, row} of toReplace) {
			const payload = await prepare(doc, row);
			if (payload.skip) {
				// 新しい版は出せない(大きすぎるなど)。古い版のまま残し、見出しで知らせる
				await save({...row, reason: `新しい版を出せません: ${payload.skip}`});
				if (row.caption_id) {
					await call((token) => Miro.updateText(token, board, row.caption_id, {content: captionHtml({title: doc.entry_file, uploadedAt: row.updated_at, url: aliasUrl(target.publicBaseUrl, doc.alias), note: "新しい版があります(Document Manager で開いてください)"})})).catch(() => {});
				}
				counts.skipped++;
				continue;
			}
			try {
				const updated = await call((token) => Miro.replaceFile(token, board, row.item_kind || payload.kind, row.item_id, {
					title: doc.entry_file, width: row.width, file: payload.file, fileName: payload.fileName, contentType: payload.contentType
				}));
				if (row.caption_id) {
					await call((token) => Miro.updateText(token, board, row.caption_id, {content: captionHtml({title: doc.entry_file, uploadedAt: doc.uploaded_at, url: aliasUrl(target.publicBaseUrl, doc.alias)})}));
				}
				await save({...row, document_id: doc.id, title: doc.entry_file, reason: null,
					width: updated?.geometry?.width ?? row.width, height: updated?.geometry?.height ?? row.height});
				counts.replaced++;
				counts.placed++;
			} catch (err) {
				if (err.needsReconnect) throw err;
				if (err.status === 404) {
					// 差し替えようとしたら Miro で消されていた
					await save({...row, state: STATES.REMOVED, reason: "Miro で消されました"});
					counts.removed++;
					continue;
				}
				await save({...row, reason: `新しい版を出せませんでした: ${err.message}`});
				counts.failed++;
			}
		}

		// 新しく置くものを用意する
		const ready = [];
		for (const entry of toCreate) {
			const payload = await prepare(entry.doc, entry.row);
			if (payload.skip) {
				await save({...(entry.row ?? {}), alias: entry.doc.alias, document_id: entry.doc.id, title: entry.doc.entry_file, state: STATES.SKIPPED, reason: payload.skip,
					item_id: null, caption_id: null, group_id: null});
				counts.skipped++;
				continue;
			}
			ready.push({...entry, payload, aspect: aspectOf(payload.file, payload.contentType)});
		}

		// 置く場所を決める。初めて並べるときはフォルダごとの見出しを付けて並べ、
		// あとから増えたものは、いま並んでいるものの下に足す
		const placedRows = [...items.values()].filter((row) => row.state === STATES.PLACED && row.y != null);
		const firstLayout = placedRows.length === 0;
		let cursorY = LAYOUT.padding;
		if (!firstLayout) {
			for (const row of placedRows) {
				cursorY = Math.max(cursorY, Number(row.y) + Number(row.height || 0) / 2 + LAYOUT.captionHeight + LAYOUT.gapY);
			}
		}
		const plan = [];
		const headers = [];
		const placeRow = (entries) => {
			let rowHeight = 0;
			entries.forEach((entry, index) => {
				const height = LAYOUT.itemWidth * entry.aspect;
				rowHeight = Math.max(rowHeight, height);
				plan.push({...entry, x: LAYOUT.padding + index * (LAYOUT.itemWidth + LAYOUT.gapX) + LAYOUT.itemWidth / 2, y: cursorY + height / 2, height});
			});
			cursorY += rowHeight + LAYOUT.captionHeight + LAYOUT.gapY;
		};
		const groups = firstLayout ? [] : [{title: null, entries: ready}];
		if (firstLayout) {
			for (const entry of ready) {
				const last = groups[groups.length - 1];
				if (last != null && last.title === entry.section) last.entries.push(entry);
				else groups.push({title: entry.section, entries: [entry]});
			}
		}
		for (const group of groups) {
			if (group.entries.length === 0) continue;
			if (group.title) {
				headers.push({title: group.title, y: cursorY + LAYOUT.headerHeight / 2});
				cursorY += LAYOUT.headerHeight;
			}
			for (let i = 0; i < group.entries.length; i += LAYOUT.columns) placeRow(group.entries.slice(i, i + LAYOUT.columns));
		}
		const contentBottom = cursorY - LAYOUT.gapY + LAYOUT.padding;

		// 枠を用意する(無ければ作る。中身が増えたら下へ伸ばす)
		if (plan.length > 0 || frameId == null) {
			const height = Math.max(contentBottom, Number(link.frame_height) || 0, 600);
			if (frameId == null) {
				const position = await nextFramePosition(board, height);
				const frame = await call((token) => Miro.createFrame(token, board, {title: desired.project.name, x: position.x, y: position.y, width: position.width, height}));
				frameId = frame.id;
				await ds.run(SQL_SET_FRAME, {project_id: projectId, frame_id: frameId, x: position.x, y: position.y, width: position.width, height});
			} else if (height > (Number(link.frame_height) || 0)) {
				// 枠の位置は中心なので、高さだけ変えると上下に伸びる。上の端を動かさないよう、伸ばした分の半分だけ中心を下げる
				// (中の項目は枠の左上からの位置なので、枠と一緒に動かない)
				const grow = height - (Number(link.frame_height) || 0);
				const y = Number(link.frame_y) + grow / 2;
				await call((token) => Miro.updateFrame(token, board, frameId, {width: Number(link.frame_width) || frameWidth(), height, x: Number(link.frame_x), y}));
				await ds.run(SQL_SET_FRAME, {project_id: projectId, frame_id: frameId, x: Number(link.frame_x), y, width: Number(link.frame_width) || frameWidth(), height});
			}
		}

		// フォルダの見出し。並べ直すとき(初めて・全部片付けたあと)は、前の見出しを消してから置く
		if (headers.length > 0) {
			await drawDecorations(projectId, link, board, frameId, {labels: headers.map((header) => headerLabel(header.title, header.y))}, {tolerant: true});
		}

		// 資料を置く(中身 → 見出し → グループ)。置く場所は決めてあるので、数件ずつ同時に書き込む
		await forEachConcurrently(plan, CONCURRENCY, async (entry) => {
			const {doc, payload} = entry;
			let itemId = null;
			try {
				const item = await call((token) => Miro.createFile(token, board, payload.kind, {
					title: doc.entry_file, x: entry.x, y: entry.y, width: LAYOUT.itemWidth, parentId: frameId,
					file: payload.file, fileName: payload.fileName, contentType: payload.contentType
				}));
				itemId = item.id;
				const height = item.geometry?.height ?? entry.height;
				const caption = await call((token) => Miro.createText(token, board, {
					content: captionHtml({title: doc.entry_file, uploadedAt: doc.uploaded_at, url: aliasUrl(target.publicBaseUrl, doc.alias)}),
					x: entry.x, y: entry.y + height / 2 + LAYOUT.captionHeight / 2, width: LAYOUT.itemWidth, parentId: frameId
				}));
				const group = await call((token) => Miro.createGroup(token, board, [item.id, caption.id])).catch((err) => {
					logger.warn({err: err.message}, "資料と見出しをグループにできませんでした(それぞれは置いてあります)");
					return null;
				});
				await save({alias: doc.alias, document_id: doc.id, item_id: item.id, item_kind: payload.kind, caption_id: caption.id, group_id: group?.id ?? null,
					title: doc.entry_file, state: STATES.PLACED, reason: null, x: entry.x, y: entry.y, placed_x: entry.x, placed_y: entry.y, width: item.geometry?.width ?? LAYOUT.itemWidth, height});
				counts.created++;
				counts.placed++;
			} catch (err) {
				if (err.needsReconnect) throw err;
				// 中身だけ置けて見出しで失敗したときは、中途半端に残さない
				if (itemId != null) await call((token) => Miro.deleteItem(token, board, itemId)).catch(() => {});
				await save({alias: doc.alias, document_id: doc.id, title: doc.entry_file, state: STATES.FAILED, reason: err.message.slice(0, 300)});
				counts.failed++;
			}
		});

		// プロジェクトから外れた・アーカイブされた資料。ボードからは消さず、見出しで知らせる
		for (const row of items.values()) {
			if (row.state !== STATES.PLACED) continue;
			const doc = desired.sections.flatMap((section) => section.documents).find((d) => d.alias === row.alias);
			const note = doc == null ? "このプロジェクトから外れた資料です" : doc.archived ? "Document Manager でアーカイブされた資料です" : null;
			if (note == null) continue;
			if (row.caption_id) {
				await call((token) => Miro.updateText(token, board, row.caption_id, {content: captionHtml({title: row.title, uploadedAt: row.updated_at, url: aliasUrl(target.publicBaseUrl, row.alias), note})})).catch(() => {});
			}
			await save({...row, state: STATES.DETACHED, reason: note});
		}
		// 外れていた資料がまた入った・アーカイブから戻った(見出しを戻す)
		for (const row of items.values()) {
			if (row.state !== STATES.DETACHED || !desiredAliases.has(row.alias)) continue;
			const doc = desired.sections.flatMap((section) => section.documents).find((d) => d.alias === row.alias);
			if (doc == null || doc.archived) continue;
			if (row.caption_id) {
				await call((token) => Miro.updateText(token, board, row.caption_id, {content: captionHtml({title: doc.entry_file, uploadedAt: doc.uploaded_at, url: aliasUrl(target.publicBaseUrl, doc.alias)})})).catch(() => {});
			}
			await save({...row, state: STATES.PLACED, reason: null});
		}

		await ds.run(SQL_SET_SYNCED, {project_id: projectId, now: now(), error: null});
		if (counts.created + counts.replaced + counts.removed > 0) {
			logger.info({projectId, ...counts}, "Miro のボードを更新しました");
		}
		return counts;
	} catch (err) {
		const message = err.needsReconnect ? err.message : `Miro に反映できませんでした: ${err.message}`;
		await ds.run(SQL_SET_SYNCED, {project_id: projectId, now: new Date().toISOString(), error: message.slice(0, 500)}).catch(() => {});
		logger.warn({projectId, error: err.message}, "Miro への反映に失敗しました");
		throw err;
	} finally {
		await releaseLock(projectId);
	}
};

// ---- 同期の予約(同じプロジェクトを重ねて動かさない・変更はまとめてから) ----

const running = new Map();
const pending = new Set();
let debounceTimer = null;

/** 1つのプロジェクトを同期する(動いていれば、終わったあとにもう1回) */
const runProject = (projectId, options) => {
	if (running.has(projectId)) {
		pending.add(projectId);
		return running.get(projectId);
	}
	const job = syncProject(projectId, options)
		.catch(() => null)
		.finally(() => {
			running.delete(projectId);
			if (pending.delete(projectId)) runProject(projectId, options);
		});
	running.set(projectId, job);
	return job;
};
module.exports.runProject = runProject;
module.exports.syncProject = syncProject;

/** 連動しているプロジェクトをすべて同期する */
const syncAll = async (options = {}) => {
	const target = await MiroConnection.target().catch(() => null);
	if (target == null) return;
	const rows = await ds.all(SQL_LIST_ACTIVE);
	for (const row of rows) await runProject(row.project_id, options);
};
module.exports.syncAll = syncAll;

/** 文書・プロジェクトが変わったとき(server.js の変更通知)。少しまとめてから動く */
module.exports.scheduleAll = () => {
	if (debounceTimer != null) return;
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		syncAll().catch((err) => logger.warn({err: err.message}, "Miro への反映(変更の通知から)に失敗しました"));
	}, DEBOUNCE_MS);
	debounceTimer.unref?.();
};

/** 定期の同期を始める(Miro 側で消された・動かされたことを見に行く) */
module.exports.startPeriodic = () => {
	if (INTERVAL_MS <= 0) return;
	const timer = setInterval(() => {
		syncAll({checkMiro: true}).catch((err) => logger.warn({err: err.message}, "Miro への定期の反映に失敗しました"));
	}, INTERVAL_MS);
	timer.unref?.();
};

// ---- 連動の開始・終了・状態 ----

/**
 * 連動を始める(または止めていたものを再開する)。並べるのは裏で行う。
 * @param {{layout?: string}} [options] layout: 並べ方の型(省略すると、前に選んだ型。初めてならフォルダ列型)
 */
module.exports.link = async (projectId, user, {layout} = {}) => {
	checkLayout(layout);
	const target = await MiroConnection.target();
	if (target == null) throw Object.assign(new Error("Miro と連携していないか、貼り先のボードが決まっていません(管理画面の「Miro 連携」)"), {status: 409});
	const project = await Projects.getProject(projectId);
	if (project == null) throw Object.assign(new Error("not found"), {status: 404});
	const previous = await ds.get(SQL_GET_PROJECT, [projectId]);
	await ds.run(SQL_UPSERT_PROJECT, {project_id: projectId, board_id: target.boardId, user, now: new Date().toISOString()});
	if (layout != null) await ds.run(SQL_SET_LAYOUT, {project_id: projectId, layout});
	// ボードが変わった・枠が消されて止まっていた場合は、新しい枠に並べ直す(前の記録は使わない)
	if (previous != null && (previous.board_id !== target.boardId || previous.last_error?.includes("枠が消された"))) {
		await ds.run(`UPDATE miro_projects SET frame_id = NULL, frame_x = NULL, frame_y = NULL, frame_width = NULL, frame_height = NULL WHERE project_id = ?`, [projectId]);
		await ds.run(`DELETE FROM miro_items WHERE project_id = ? AND state <> 'excluded'`, [projectId]);
	}
	logger.info({audit: "miro_project_linked", user, projectId, layout: layout ?? null}, "audit");
	runProject(projectId, {user});
};

/**
 * 連動をやめる。
 * @param {{removeDocuments?: boolean}} options removeDocuments: ボードに出した資料(と見出し)も消す。付箋や枠は残す
 */
module.exports.unlink = async (projectId, user, {removeDocuments = false} = {}) => {
	const link = await ds.get(SQL_GET_PROJECT, [projectId]);
	if (link == null) return;
	await ds.run(SQL_STOP_PROJECT, {project_id: projectId, user, now: new Date().toISOString(), error: null});
	if (removeDocuments) {
		const target = await MiroConnection.target();
		if (target != null) {
			for (const row of await ds.all(SQL_LIST_ITEMS, [projectId])) {
				for (const id of [row.item_id, row.caption_id]) {
					if (id == null) continue;
					await MiroConnection.withToken((token) => Miro.deleteItem(token, target.boardId, id)).catch((err) => {
						if (err.status !== 404) logger.warn({err: err.message}, "Miro の資料を消せませんでした");
					});
				}
			}
		}
		await ds.run(`DELETE FROM miro_items WHERE project_id = ? AND state <> 'excluded'`, [projectId]);
		if (target != null) await deleteHeaders(link, target.boardId);
	}
	logger.info({audit: "miro_project_unlinked", user, projectId, removeDocuments}, "audit");
};

/**
 * 資料ごとに、出す・出さないを決める(プロジェクト単位)。出さないにしたら、ボードからも消す
 */
module.exports.setPublish = async (projectId, documentId, publish, user) => {
	const alias = (await DocumentAliases.aliasOf(documentId)) ?? (await DocumentAliases.assign(documentId));
	const row = (await ds.all(SQL_LIST_ITEMS, [projectId])).find((r) => r.alias === alias);
	const target = await MiroConnection.target();
	if (!publish) {
		if (row?.state === STATES.PLACED && target != null) {
			for (const id of [row.item_id, row.caption_id]) {
				if (id == null) continue;
				await MiroConnection.withToken((token) => Miro.deleteItem(token, target.boardId, id)).catch((err) => {
					if (err.status !== 404) throw err;
				});
			}
		}
		await ds.run(SQL_UPSERT_ITEM, {project_id: projectId, alias, board_id: target?.boardId ?? row?.board_id ?? "", document_id: documentId, item_id: null, item_kind: null,
			caption_id: null, group_id: null, title: row?.title ?? null, state: STATES.EXCLUDED, reason: "「出さない」に設定されています", x: null, y: null, width: null, height: null,
			placed_x: null, placed_y: null, updated_by: user, updated_at: new Date().toISOString()});
	} else if (row != null && (row.state === STATES.EXCLUDED || row.state === STATES.REMOVED)) {
		await ds.run(`DELETE FROM miro_items WHERE project_id = ? AND alias = ?`, [projectId, alias]);
	}
	logger.info({audit: "miro_document_publish", user, projectId, documentId, publish}, "audit");
	runProject(projectId, {user});
};

// ---- 動かす ----
// 人が Miro で動かしたあとでも正しく動かせるよう、動かす前に Miro からいまの位置を読み直す。
// 資料と見出しはグループにしてあるが、API で動かすときは1つずつ動かす必要がある(実物で確かめた)ので、
// 見出しも資料の下へ一緒に動かす

const SIDES = Object.freeze(["right", "left", "above", "below"]);
module.exports.SIDES = SIDES;

const moveError = (message, status = 400) => Object.assign(new Error(message), {status});

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

/** いま Miro にある位置と大きさを読む(消されていれば 404 の例外) */
const readPlacement = async (board, row) => {
	const item = await MiroConnection.withToken((token) => Miro.getItem(token, board, row.item_id));
	return {
		x: item.position?.x, y: item.position?.y,
		width: item.geometry?.width ?? row.width, height: item.geometry?.height ?? row.height,
		parentId: item.parent?.id ?? null
	};
};

const SQL_GET_ITEM = `SELECT * FROM miro_items WHERE project_id = ? AND alias = ?`;
const SQL_SET_POSITION = `UPDATE miro_items SET x = ?, y = ?, placed_x = ?, placed_y = ?, width = ?, height = ?, updated_by = ?, updated_at = ? WHERE project_id = ? AND alias = ?`;
/** Document Manager が資料を置いた位置を覚える(今の位置と、置いた位置の両方。違ってきたら人が動かしたとみなす) */
const setPosition = (projectId, row, x, y, user) =>
	ds.run(SQL_SET_POSITION, [x, y, x, y, row.width, row.height, user, new Date().toISOString(), projectId, row.alias]);

/** プロジェクトの資料(出ているもの)を、文書IDから引く。版が変わっていても、同じ資料なら引ける */
const placedRowOf = async (projectId, documentId) => {
	const alias = await DocumentAliases.aliasOf(documentId);
	const row = alias == null ? null : await ds.get(SQL_GET_ITEM, [projectId, alias]);
	if (row == null || row.item_id == null || ![STATES.PLACED, STATES.DETACHED].includes(row.state)) {
		throw moveError("この資料は Miro に出ていません", 404);
	}
	return row;
};

/**
 * 資料を動かす。指示は次のどれか1つ:
 *   {nextTo: 文書ID, side: "right"|"left"|"above"|"below"}  ほかの資料の隣へ(同じプロジェクトの資料)
 *   {project: プロジェクトID}                                ほかのプロジェクトの枠へ(その枠の下の空いているところ)
 *   {x, y}                                                    いまの枠の左上からの位置へ(資料の中心)
 * 動かしたあとの位置は覚えておき、新しい版もその場所で差し替える。
 */
module.exports.moveDocument = async (projectId, documentId, instruction, user) => {
	const target = await MiroConnection.target();
	if (target == null) throw moveError("Miro と連携していないか、貼り先のボードが決まっていません", 409);
	const board = target.boardId;
	const row = await placedRowOf(projectId, documentId);
	const current = await readPlacement(board, row).catch((err) => {
		if (err.status === 404) throw moveError("この資料は Miro で消されています", 404);
		throw err;
	});
	row.width = current.width;
	row.height = current.height;
	let destination;
	if (instruction.nextTo != null) {
		const side = instruction.side ?? "right";
		if (!SIDES.includes(side)) throw moveError("side は right / left / above / below のどれかです");
		const reference = await placedRowOf(projectId, instruction.nextTo).catch(() => {
			throw moveError("隣に置く相手の資料が、このプロジェクトの Miro に出ていません", 404);
		});
		if (reference.alias === row.alias) throw moveError("自分自身の隣には置けません");
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
	} else if (instruction.project != null) {
		const other = await ds.get(SQL_GET_PROJECT, [instruction.project]);
		if (other == null || other.state !== "active" || other.frame_id == null) throw moveError("移す先のプロジェクトは Miro と連動していません", 409);
		// 移す先の枠の、いちばん下の資料のさらに下
		const rows = (await ds.all(SQL_LIST_ITEMS, [instruction.project])).filter((r) => r.state === STATES.PLACED && r.y != null);
		let bottom = LAYOUT.padding;
		for (const r of rows) bottom = Math.max(bottom, Number(r.y) + Number(r.height || 0) / 2 + LAYOUT.captionHeight + LAYOUT.gapY);
		destination = {x: LAYOUT.padding + current.width / 2, y: bottom + current.height / 2, parentId: other.frame_id};
		// 枠からはみ出すなら伸ばす(上の端は動かさない)
		const needed = bottom + current.height + LAYOUT.captionHeight + LAYOUT.padding;
		if (needed > Number(other.frame_height || 0)) {
			const y = Number(other.frame_y) + (needed - Number(other.frame_height || 0)) / 2;
			await MiroConnection.withToken((token) => Miro.updateFrame(token, board, other.frame_id, {width: Number(other.frame_width) || frameWidth(), height: needed, x: Number(other.frame_x), y}));
			await ds.run(SQL_SET_FRAME, {project_id: instruction.project, frame_id: other.frame_id, x: Number(other.frame_x), y, width: Number(other.frame_width) || frameWidth(), height: needed});
		}
	} else if (Number.isFinite(Number(instruction.x)) && Number.isFinite(Number(instruction.y)) && instruction.x !== null && instruction.y !== null) {
		if (Number(instruction.x) < 0 || Number(instruction.y) < 0) throw moveError("x と y は枠の左上からの位置です(0 以上)");
		destination = {x: Number(instruction.x), y: Number(instruction.y), parentId: current.parentId};
		// はみ出す位置なら、いまの枠(自分のプロジェクトの枠に入っているとき)を広げる
		const link = await ds.get(SQL_GET_PROJECT, [projectId]);
		if (link?.frame_id != null && current.parentId === link.frame_id) {
			await resizeFrame(projectId, link, board, {
				width: destination.x + current.width / 2 + LAYOUT.padding,
				height: destination.y + current.height / 2 + LAYOUT.captionHeight + LAYOUT.padding,
				grow: true
			});
		}
	} else {
		throw moveError("nextTo(と side)・project・x と y のどれかを指定してください");
	}
	await placeAt(board, row, destination);
	await setPosition(projectId, row, destination.x, destination.y, user);
	logger.info({audit: "miro_document_moved", user, projectId, documentId, instruction}, "audit");
	return {x: destination.x, y: destination.y, frameId: destination.parentId};
};

const parseJson = (text, fallback) => {
	if (text == null || text === "") return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
};

/** フォルダの見出し(■ フォルダ名)の文字。初めて並べるときと、フォルダの順で並べ直すときに置く */
const headerLabel = (title, y) => ({
	text: `■ ${title}`, x: frameWidth() / 2, y, width: frameWidth() - LAYOUT.padding * 2,
	fontSize: null, color: null, fillColor: null, bold: true, align: "left"
});

/**
 * フォルダ列型(いまの並べ方): おしながき順に、フォルダごとの見出しを付けて格子に並べる。
 * @returns {Promise<{items: Array<{row: object, x: number, y: number, color: ?string}>, labels: object[], shapes: object[], frame: {width: number, height: number}}>}
 */
const planFolderSections = async (projectId, rows) => {
	const desired = await desiredDocuments(projectId);
	let cursorY = LAYOUT.padding;
	const items = [];
	const labels = [];
	for (const section of desired.sections) {
		const entries = section.documents.map((doc) => rows.get(doc.alias)).filter(Boolean);
		if (entries.length === 0) continue;
		if (section.title) {
			labels.push(headerLabel(section.title, cursorY + LAYOUT.headerHeight / 2));
			cursorY += LAYOUT.headerHeight;
		}
		for (let i = 0; i < entries.length; i += LAYOUT.columns) {
			const line = entries.slice(i, i + LAYOUT.columns);
			const heightOf = (r) => Number(r.height) || LAYOUT.itemWidth * LAYOUT.defaultAspect;
			const rowHeight = Math.max(...line.map(heightOf));
			line.forEach((r, index) => {
				items.push({row: r, x: LAYOUT.padding + index * (LAYOUT.itemWidth + LAYOUT.gapX) + LAYOUT.itemWidth / 2, y: cursorY + heightOf(r) / 2, color: null});
			});
			cursorY += rowHeight + LAYOUT.captionHeight + LAYOUT.gapY;
		}
	}
	return {items, labels, shapes: [], frame: {width: frameWidth(), height: Math.max(cursorY - LAYOUT.gapY + LAYOUT.padding, 600)}};
};

// 型ごとの並べ方。まだ無い型は、並べ直しでは選べない(報告は出せる)
const PLANNERS = Object.freeze({
	"folder-columns": planFolderSections
});
module.exports.arrangeableLayouts = () => Object.keys(PLANNERS);

const layoutOf = (link) => (MiroLayout.LAYOUT_IDS.includes(link?.layout) ? link.layout : MiroLayout.DEFAULT_LAYOUT);
/** プロジェクトに選んである型(連動していなければフォルダ列型) */
module.exports.layoutOf = async (projectId) => layoutOf(await ds.get(SQL_GET_PROJECT, [projectId]));

const checkLayout = (layout) => {
	if (layout != null && !MiroLayout.LAYOUT_IDS.includes(layout)) {
		throw moveError(`型(layout)は ${MiroLayout.LAYOUT_IDS.join(" / ")} のどれかです`);
	}
};
module.exports.checkLayout = checkLayout;

/**
 * 枠の大きさを変える。左上の角は動かさない(中の項目は左上からの位置なので、中心を動かさずに変えると、
 * 中身ごと上や左へずれて見える)。grow のときは縮めない
 */
const resizeFrame = async (projectId, link, board, {width, height, grow = false}) => {
	const currentWidth = Number(link.frame_width) || frameWidth();
	const currentHeight = Number(link.frame_height) || 600;
	const nextWidth = Math.ceil(grow ? Math.max(currentWidth, width) : width);
	const nextHeight = Math.ceil(grow ? Math.max(currentHeight, height) : height);
	if (nextWidth === currentWidth && nextHeight === currentHeight) return {width: nextWidth, height: nextHeight};
	const left = Number(link.frame_x) - currentWidth / 2;
	const top = Number(link.frame_y) - currentHeight / 2;
	const x = left + nextWidth / 2;
	const y = top + nextHeight / 2;
	await MiroConnection.withToken((token) => Miro.updateFrame(token, board, link.frame_id, {width: nextWidth, height: nextHeight, x, y}));
	await ds.run(SQL_SET_FRAME, {project_id: projectId, frame_id: link.frame_id, x, y, width: nextWidth, height: nextHeight});
	Object.assign(link, {frame_x: x, frame_y: y, frame_width: nextWidth, frame_height: nextHeight});
	return {width: nextWidth, height: nextHeight};
};

/**
 * 決まった配置をボードへ置く: 枠の大きさ → 見出しの文字・図形 → 資料の位置と見出しの色。
 * items の color は、undefined なら見出しの色を変えず、null なら色を外す。
 * @param {{items: Array<{row: object, x: number, y: number, color?: ?string}>, labels: object[], shapes: object[], frame?: ?{width: number, height: number}}} plan
 * @param {{grow?: boolean, keepDecorations?: boolean}} options grow: 枠を縮めない(レイアウトを当てるとき)
 */
const executePlan = async (projectId, link, board, plan, user, {grow = false, keepDecorations = false} = {}) => {
	const heightOf = (row) => Number(row.height) || LAYOUT.itemWidth * LAYOUT.defaultAspect;
	const widthOf = (row) => Number(row.width) || LAYOUT.itemWidth;
	// 枠を先に合わせる(はみ出した位置に置くと、枠の外に出たように見えるため)。中身がはみ出すなら、その分は広げる
	let right = 0;
	let bottom = 0;
	for (const item of plan.items) {
		right = Math.max(right, item.x + widthOf(item.row) / 2);
		bottom = Math.max(bottom, item.y + heightOf(item.row) / 2 + LAYOUT.captionHeight);
	}
	for (const label of plan.labels) {
		right = Math.max(right, label.x + label.width / 2);
		bottom = Math.max(bottom, label.y + (label.fontSize ?? 36));
	}
	for (const shape of plan.shapes) {
		right = Math.max(right, shape.x + shape.width / 2);
		bottom = Math.max(bottom, shape.y + shape.height / 2);
	}
	const frame = await resizeFrame(projectId, link, board, {
		width: Math.max(plan.frame?.width ?? (grow ? 0 : Number(link.frame_width) || frameWidth()), right + LAYOUT.padding),
		height: Math.max(plan.frame?.height ?? (grow ? 0 : 600), bottom + LAYOUT.padding),
		grow
	});
	const drawn = await drawDecorations(projectId, link, board, link.frame_id, plan, {keep: keepDecorations});

	// 資料を動かす(見出しも一緒に)。色の指定があれば見出しの背景を塗る
	const colors = {...(parseJson(link.layout_plan, {}).colors ?? {})};
	let moved = 0;
	await forEachConcurrently(plan.items, CONCURRENCY, async (item) => {
		const {row} = item;
		try {
			await placeAt(board, row, {x: item.x, y: item.y, parentId: link.frame_id});
		} catch (err) {
			// Miro で消されていた資料は飛ばす(次の定期の反映で「消された」になる)
			if (err.status === 404) return;
			throw err;
		}
		if (item.color !== undefined && row.caption_id) {
			await MiroConnection.withToken((token) => Miro.updateText(token, board, row.caption_id, {
				style: item.color ? {fillColor: item.color, fillOpacity: "1"} : {fillOpacity: "0"}
			})).catch((err) => {
				if (err.status !== 404) throw err;
			});
			if (item.color) colors[row.alias] = item.color;
			else delete colors[row.alias];
		}
		await setPosition(projectId, row, item.x, item.y, user);
		moved++;
	});
	const layoutPlan = {...parseJson(link.layout_plan, {}), colors};
	await ds.run(SQL_SET_LAYOUT_PLAN, {project_id: projectId, layout_plan: JSON.stringify(layoutPlan)});
	link.layout_plan = JSON.stringify(layoutPlan);
	return {moved, labels: drawn.labels, shapes: drawn.shapes, frame};
};

/** 直前の配置(型・資料の位置・見出しの文字・図形・見出しの色・枠の大きさ)。位置は Miro から読み直す */
const snapshotOf = async (link, board, rows) => {
	const items = [];
	await forEachConcurrently([...rows.values()], CONCURRENCY, async (row) => {
		const now = await readPlacement(board, row).catch((err) => (err.status === 404 ? null : {x: row.x, y: row.y}));
		if (now?.x != null && now?.y != null) items.push({alias: row.alias, x: Number(now.x), y: Number(now.y)});
	});
	const plan = parseJson(link.layout_plan, {});
	return {
		layout: layoutOf(link),
		items,
		labels: plan.labels ?? [],
		shapes: plan.shapes ?? [],
		colors: plan.colors ?? {},
		frame: {width: Number(link.frame_width) || frameWidth(), height: Number(link.frame_height) || 600},
		savedAt: new Date().toISOString()
	};
};

/** 並べ直す・戻すの前に確かめること(連携していて、このプロジェクトが連動していること) */
const activeLink = async (projectId) => {
	const target = await MiroConnection.target();
	if (target == null) throw moveError("Miro と連携していないか、貼り先のボードが決まっていません", 409);
	const link = await ds.get(SQL_GET_PROJECT, [projectId]);
	if (link == null || link.state !== "active" || link.frame_id == null) throw moveError("このプロジェクトは Miro と連動していません", 409);
	return {target, link};
};
const placedRows = async (projectId) => new Map((await ds.all(SQL_LIST_ITEMS, [projectId]))
	.filter((r) => r.state === STATES.PLACED && r.item_id != null).map((r) => [r.alias, r]));

/**
 * 枠の中を、型どおりに並べ直す。人が並べた配置は上書きされる。見出しの文字・図形も置き直し、枠の外へ出した資料も枠に戻す。
 * 型を渡すと、その型に切り替えてから並べる。並べる前の配置を 1 世代だけ覚えておき、undoArrange で戻せる。
 * 人が足した付箋や図形には触らない(片付けるのは Document Manager が置いたものだけ)。
 * @param {{layout?: string}} [options]
 */
module.exports.arrange = async (projectId, user, {layout} = {}) => {
	checkLayout(layout);
	const {target, link} = await activeLink(projectId);
	const previousLayout = layoutOf(link);
	const nextLayout = layout ?? previousLayout;
	if (PLANNERS[nextLayout] == null) throw moveError(`${MiroLayout.LAYOUT_NAMES[nextLayout]}で並べるのは、まだできません(報告 layout-report は出せます)`);
	if (!(await takeLock(projectId))) throw moveError("いま Miro へ反映しているところです。終わってからやり直してください", 409);
	try {
		const board = target.boardId;
		const rows = await placedRows(projectId);
		const plan = await PLANNERS[nextLayout](projectId, rows);
		await ds.run(SQL_SET_LAYOUT_UNDO, {project_id: projectId, layout_undo: JSON.stringify(await snapshotOf(link, board, rows))});
		const result = await executePlan(projectId, link, board, plan, user);
		await ds.run(SQL_SET_LAYOUT, {project_id: projectId, layout: nextLayout});
		logger.info({audit: "miro_project_arranged", user, projectId, layout: nextLayout, previousLayout, moved: result.moved}, "audit");
		return {moved: result.moved, layout: nextLayout, previousLayout, frame: result.frame};
	} finally {
		await releaseLock(projectId);
	}
};

/**
 * 「元の型に戻す」: 直前の並べ直しの前の配置(型・資料の位置・見出しの文字・図形・見出しの色・枠の大きさ)に戻す。
 * 覚えるのは 1 世代だけで、戻したら消す。そのあとで増えた資料は、いまの場所のまま(色だけ外す)。
 */
module.exports.undoArrange = async (projectId, user) => {
	const {target, link} = await activeLink(projectId);
	const snapshot = parseJson(link.layout_undo, null);
	if (snapshot == null) throw moveError("戻せる配置がありません(並べ直したあとだけ戻せます)", 409);
	if (!(await takeLock(projectId))) throw moveError("いま Miro へ反映しているところです。終わってからやり直してください", 409);
	try {
		const board = target.boardId;
		const rows = await placedRows(projectId);
		const items = (snapshot.items ?? []).filter((i) => rows.has(i.alias))
			.map((i) => ({row: rows.get(i.alias), x: i.x, y: i.y, color: snapshot.colors?.[i.alias] ?? null}));
		const restored = new Set(items.map((i) => i.row.alias));
		for (const row of rows.values()) {
			if (!restored.has(row.alias)) items.push({row, x: Number(row.x), y: Number(row.y), color: null});
		}
		const result = await executePlan(projectId, link, board, {items, labels: snapshot.labels ?? [], shapes: snapshot.shapes ?? [], frame: snapshot.frame}, user);
		const restoredLayout = MiroLayout.LAYOUT_IDS.includes(snapshot.layout) ? snapshot.layout : MiroLayout.DEFAULT_LAYOUT;
		await ds.run(SQL_SET_LAYOUT, {project_id: projectId, layout: restoredLayout});
		await ds.run(SQL_SET_LAYOUT_UNDO, {project_id: projectId, layout_undo: null});
		logger.info({audit: "miro_project_arrange_undone", user, projectId, layout: restoredLayout, moved: result.moved}, "audit");
		return {moved: result.moved, layout: restoredLayout, frame: result.frame};
	} finally {
		await releaseLock(projectId);
	}
};

// ---- レイアウトをまとめて当てる ----
// 並べ方(十字型・フォルダ列型・時系列型など)を決めるのは、指示を出す側(人や AI)。ここは、決まった並べ方を
// ボードへそのまま置く仕組みだけを持つ: 資料の位置と色、見出しの文字、図形(区切りの線・区画の背景)、枠の大きさ。
// 見出しの文字と図形は Document Manager が覚えておき、次に当て直すときに片付けてから置く
// (初めて並べたときのフォルダの見出しも同じ扱い)。

const LAYOUT_LIMITS = Object.freeze({items: 2000, labels: 500, shapes: 500, maxCoordinate: 200000, textLength: 300});
const SHAPE_KINDS = Object.freeze(["rectangle", "round_rectangle", "circle", "triangle", "rhombus", "parallelogram", "trapezoid", "pentagon", "hexagon", "octagon", "star", "flow_chart_predefined_process", "can", "cross", "right_arrow", "left_arrow", "left_right_arrow", "left_brace", "right_brace"]);
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
		align: ["left", "center", "right"].includes(label?.align) ? label.align : "left"
	}));
	const shapes = list(layout?.shapes, "shapes").map((shape, i) => {
		const kind = shape?.shape ?? "rectangle";
		if (!SHAPE_KINDS.includes(kind)) errors.push(`shapes[${i}].shape は ${SHAPE_KINDS.join(" / ")} のどれかです`);
		return {
			shape: kind,
			text: shape?.text == null ? "" : String(shape.text).slice(0, LAYOUT_LIMITS.textLength),
			x: number(shape?.x, `shapes[${i}].x`),
			y: number(shape?.y, `shapes[${i}].y`),
			width: number(shape?.width, `shapes[${i}].width`, {min: 1, max: 100000}),
			height: number(shape?.height, `shapes[${i}].height`, {min: 1, max: 100000}),
			fillColor: color(shape?.fillColor, `shapes[${i}].fillColor`),
			fillOpacity: shape?.fillOpacity == null ? null : number(shape.fillOpacity, `shapes[${i}].fillOpacity`, {min: 0, max: 1}),
			borderColor: color(shape?.borderColor, `shapes[${i}].borderColor`),
			borderWidth: shape?.borderWidth == null ? null : number(shape.borderWidth, `shapes[${i}].borderWidth`, {min: 0, max: 24}),
			borderStyle: ["normal", "dotted", "dashed"].includes(shape?.borderStyle) ? shape.borderStyle : null
		};
	});
	const frame = layout?.frame == null ? null : {
		width: number(layout.frame.width, "frame.width", {min: 400, max: LAYOUT_LIMITS.maxCoordinate}),
		height: number(layout.frame.height, "frame.height", {min: 400, max: LAYOUT_LIMITS.maxCoordinate})
	};
	if (items.length === 0 && labels.length === 0 && shapes.length === 0 && frame == null) {
		errors.push("items・labels・shapes・frame のどれかを指定してください");
	}
	return {errors, items, labels, shapes, frame, keepDecorations: layout?.keepDecorations === true};
};
module.exports.normalizeLayout = normalizeLayout;

/**
 * レイアウトをまとめて当てる。位置はすべて、枠の左上からの中心の位置。枠は広げるだけで縮めない(左上は動かさない)。
 * @param {{items?: Array<{documentId: string, x: number, y: number, color?: ?string}>,
 *          labels?: Array<{text: string, x: number, y: number, width?: number, fontSize?: number, color?: string, fillColor?: string, bold?: boolean, align?: string}>,
 *          shapes?: Array<{shape?: string, x: number, y: number, width: number, height: number, text?: string, fillColor?: string, fillOpacity?: number, borderColor?: string, borderWidth?: number, borderStyle?: string}>,
 *          frame?: {width: number, height: number}, keepDecorations?: boolean}} layout
 */
module.exports.applyLayout = async (projectId, layout, user) => {
	const {target, link} = await activeLink(projectId);
	const plan = normalizeLayout(layout);
	// 資料は、このプロジェクトの枠に出ているものだけ(版が変わっていても同じ資料なら引ける)
	const rows = new Map();
	for (const item of plan.items) {
		const row = await placedRowOf(projectId, item.documentId).catch(() => null);
		if (row == null) plan.errors.push(`この資料はこのプロジェクトの Miro に出ていません(${item.documentId})`);
		else rows.set(item.documentId, row);
	}
	if (plan.errors.length > 0) throw Object.assign(moveError("レイアウトの指示に正しくないところがあります(何も動かしていません)"), {details: plan.errors.slice(0, 50)});
	if (!(await takeLock(projectId))) throw moveError("いま Miro へ反映しているところです。終わってからやり直してください", 409);
	try {
		const items = plan.items.map((item) => ({row: rows.get(item.documentId), x: item.x, y: item.y, ...(item.setColor ? {color: item.color} : {})}));
		const result = await executePlan(projectId, link, target.boardId, {items, labels: plan.labels, shapes: plan.shapes, frame: plan.frame}, user,
			{grow: true, keepDecorations: plan.keepDecorations});
		logger.info({audit: "miro_layout_applied", user, projectId, moved: result.moved, labels: result.labels, shapes: result.shapes}, "audit");
		return result;
	} finally {
		await releaseLock(projectId);
	}
};

/** プロジェクトの連動の状態(画面・API の応答) */
module.exports.status = async (projectId) => {
	const target = await MiroConnection.target().catch(() => null);
	const link = await ds.get(SQL_GET_PROJECT, [projectId]);
	const rows = link == null ? [] : await ds.all(SQL_LIST_ITEMS, [projectId]);
	const counts = Object.fromEntries(Object.values(STATES).map((state) => [state, rows.filter((r) => r.state === state).length]));
	const boardUrl = target?.boardUrl ?? null;
	return {
		available: target != null,
		linked: link?.state === "active",
		state: link?.state ?? null,
		syncing: running.has(projectId),
		boardUrl,
		// 枠へ直接飛ぶリンク(Miro は ?moveToWidget= で、その項目の位置を開く)
		frameUrl: boardUrl && link?.frame_id ? `${boardUrl}${boardUrl.includes("?") ? "&" : "?"}moveToWidget=${link.frame_id}` : null,
		// 枠の大きさ(レイアウトを組むときの目安。中身に合わせて広がる)
		frame: link?.frame_id ? {width: Number(link.frame_width) || null, height: Number(link.frame_height) || null} : null,
		// 並べ方の型と、「元の型に戻す」で戻れる型(並べ直したあとだけ)
		layout: layoutOf(link),
		layoutName: MiroLayout.LAYOUT_NAMES[layoutOf(link)],
		undo: (() => {
			const snapshot = parseJson(link?.layout_undo, null);
			return snapshot == null ? null : {layout: layoutOf(snapshot), layoutName: MiroLayout.LAYOUT_NAMES[layoutOf(snapshot)], savedAt: snapshot.savedAt ?? null};
		})(),
		linkedBy: link?.linked_by ?? null,
		linkedAt: link?.linked_at ?? null,
		lastSyncedAt: link?.last_synced_at ?? null,
		lastError: link?.last_error ?? null,
		counts,
		// 位置は枠の左上からの資料の中心(x, y)と大きさ。人が Miro で動かした分は、定期の反映か「今すぐ反映」で読み直す
		items: rows.map((row) => ({alias: row.alias, documentId: row.document_id, title: row.title, state: row.state, reason: row.reason, updatedAt: row.updated_at,
			...(row.x != null ? {position: {x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height)}} : {})}))
	};
};

module.exports.LAYOUT = LAYOUT;
module.exports.INSTANCE_ID = INSTANCE_ID;
