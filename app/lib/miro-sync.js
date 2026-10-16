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
const SQL_SET_SYNCED = `UPDATE miro_projects SET last_synced_at = @now, last_error = @error WHERE project_id = @project_id`;
const SQL_STOP_PROJECT = `UPDATE miro_projects SET state = 'stopped', stopped_by = @user, stopped_at = @now, last_error = @error WHERE project_id = @project_id`;
const SQL_TAKE_LOCK = `
	UPDATE miro_projects SET sync_lock_owner = @owner, sync_lock_until = @until
	WHERE project_id = @project_id AND (sync_lock_owner IS NULL OR sync_lock_until IS NULL OR sync_lock_until < @now)
`;
const SQL_RELEASE_LOCK = `UPDATE miro_projects SET sync_lock_owner = NULL, sync_lock_until = NULL WHERE project_id = @project_id AND sync_lock_owner = @owner`;
const SQL_LIST_ITEMS = `SELECT * FROM miro_items WHERE project_id = ?`;
const SQL_UPSERT_ITEM = `
	INSERT INTO miro_items (project_id, alias, board_id, document_id, item_id, item_kind, caption_id, group_id, title, state, reason, x, y, width, height, updated_by, updated_at)
	VALUES (@project_id, @alias, @board_id, @document_id, @item_id, @item_kind, @caption_id, @group_id, @title, @state, @reason, @x, @y, @width, @height, @updated_by, @updated_at)
	ON CONFLICT(project_id, alias) DO UPDATE SET board_id = excluded.board_id, document_id = excluded.document_id, item_id = excluded.item_id,
		item_kind = excluded.item_kind, caption_id = excluded.caption_id, group_id = excluded.group_id, title = excluded.title, state = excluded.state,
		reason = excluded.reason, x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
		updated_by = excluded.updated_by, updated_at = excluded.updated_at
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
			title: null, reason: null, x: null, y: null, width: null, height: null, updated_by: user, updated_at: now(), ...row
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

		// フォルダの見出し
		for (const header of headers) {
			await call((token) => Miro.createText(token, board, {
				content: `<p><strong>■ ${escapeHtml(header.title)}</strong></p>`,
				x: frameWidth() / 2, y: header.y, width: frameWidth() - LAYOUT.padding * 2, parentId: frameId
			})).catch((err) => logger.warn({err: err.message, projectId}, "フォルダの見出しを置けませんでした"));
		}

		// 資料を置く(中身 → 見出し → グループ)
		for (const entry of plan) {
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
					title: doc.entry_file, state: STATES.PLACED, reason: null, x: entry.x, y: entry.y, width: item.geometry?.width ?? LAYOUT.itemWidth, height});
				counts.created++;
				counts.placed++;
			} catch (err) {
				if (err.needsReconnect) throw err;
				// 中身だけ置けて見出しで失敗したときは、中途半端に残さない
				if (itemId != null) await call((token) => Miro.deleteItem(token, board, itemId)).catch(() => {});
				await save({alias: doc.alias, document_id: doc.id, title: doc.entry_file, state: STATES.FAILED, reason: err.message.slice(0, 300)});
				counts.failed++;
			}
		}

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

/** 連動を始める(または止めていたものを再開する)。並べるのは裏で行う */
module.exports.link = async (projectId, user) => {
	const target = await MiroConnection.target();
	if (target == null) throw Object.assign(new Error("Miro と連携していないか、貼り先のボードが決まっていません(管理画面の「Miro 連携」)"), {status: 409});
	const project = await Projects.getProject(projectId);
	if (project == null) throw Object.assign(new Error("not found"), {status: 404});
	const previous = await ds.get(SQL_GET_PROJECT, [projectId]);
	await ds.run(SQL_UPSERT_PROJECT, {project_id: projectId, board_id: target.boardId, user, now: new Date().toISOString()});
	// ボードが変わった・枠が消されて止まっていた場合は、新しい枠に並べ直す(前の記録は使わない)
	if (previous != null && (previous.board_id !== target.boardId || previous.last_error?.includes("枠が消された"))) {
		await ds.run(`UPDATE miro_projects SET frame_id = NULL, frame_x = NULL, frame_y = NULL, frame_width = NULL, frame_height = NULL WHERE project_id = ?`, [projectId]);
		await ds.run(`DELETE FROM miro_items WHERE project_id = ? AND state <> 'excluded'`, [projectId]);
	}
	logger.info({audit: "miro_project_linked", user, projectId}, "audit");
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
			updated_by: user, updated_at: new Date().toISOString()});
	} else if (row != null && (row.state === STATES.EXCLUDED || row.state === STATES.REMOVED)) {
		await ds.run(`DELETE FROM miro_items WHERE project_id = ? AND alias = ?`, [projectId, alias]);
	}
	logger.info({audit: "miro_document_publish", user, projectId, documentId, publish}, "audit");
	runProject(projectId, {user});
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
		linkedBy: link?.linked_by ?? null,
		linkedAt: link?.linked_at ?? null,
		lastSyncedAt: link?.last_synced_at ?? null,
		lastError: link?.last_error ?? null,
		counts,
		items: rows.map((row) => ({alias: row.alias, documentId: row.document_id, title: row.title, state: row.state, reason: row.reason, updatedAt: row.updated_at}))
	};
};

module.exports.LAYOUT = LAYOUT;
module.exports.INSTANCE_ID = INSTANCE_ID;
