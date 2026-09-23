#!/usr/bin/env node
/*!
 * dm_client.mjs : Document Manager の API クライアント(Node.js 18+ / 外部依存なし)
 *
 * AIエージェント(Claude Code / Codex / Antigravity)の Skill から呼び出す想定のコマンドラインツール。結果は JSON で標準出力へ出す。
 * コマンド・オプション・接続情報の与え方は dm_client.py と同じ。
 *
 * 接続情報(いずれか。上から優先):
 *   1. 環境変数 DM_BASE_URL / DM_API_KEY
 *   2. 設定ファイル ~/.document-manager.json  {"baseUrl": "https://.../", "apiKey": "dm_..."}
 *      (環境変数 DM_CONFIG で別パスを指定可)
 *
 * 使い方:
 *   node dm_client.mjs config
 *   node dm_client.mjs search [検索語] [--archived]
 *   node dm_client.mjs search <検索語> --semantic [--limit N]
 *   node dm_client.mjs get <文書ID>
 *   node dm_client.mjs versions <文書ID>
 *   node dm_client.mjs upload <ファイル> [--previous-id ID | --replace-same-name] [--tags タグ1,タグ2]
 *                                        [--preview 画像(.drawioの代替表示用。通常は不要)]
 *                                        [--project プロジェクト] [--folder フォルダ]
 *   node dm_client.mjs download <文書ID> [-o 保存先]
 *   node dm_client.mjs tags <文書ID> [--add A,B | --remove A,B | --set A,B]
 *   node dm_client.mjs memo <文書ID> <メモ本文>
 *   node dm_client.mjs archive <文書ID> / restore <文書ID>
 *   node dm_client.mjs links <文書ID> / link <文書ID> <相手の文書ID> / unlink <文書ID> <相手の文書ID>
 *   node dm_client.mjs link-previous <新版ID> <旧版ID> / unlink-previous <文書ID>
 *   node dm_client.mjs projects [--archived] / project-create <名前> / tree <プロジェクト>
 *   node dm_client.mjs folder-create <プロジェクト> <名前> [--parent 親フォルダ]
 *   node dm_client.mjs place <プロジェクト> <文書ID> [--folder フォルダ] / unplace <プロジェクト> <文書ID>
 *   node dm_client.mjs watch [--count N] [--timeout 秒] [--action upload,revise,...] [--all]
 *       操作の通知(SSE)を待ち受け、1イベント1行のJSONで出力する
 *   node dm_client.mjs spec [--openapi]
 *       APIの仕様(既定はAI向けMarkdown)をそのまま出力する
 *   node dm_client.mjs --version
 *
 * プロジェクト・フォルダはIDでも名前でも指定できる(同じ名前が複数あるときはIDで指定する)。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {parseArgs} from "node:util";

const CONFIG_PATH = process.env.DM_CONFIG || path.join(os.homedir(), ".document-manager.json");

// このクライアント(Skill)のバージョン。dm_client.py と必ず揃える(結合テストで検証している)。
// 変更したらタグ skill-v<この値> を打つと、CIがGitHub Releaseを作る
const CLIENT_VERSION = "1.0.0";
const USER_AGENT = `document-manager-skill/${CLIENT_VERSION} (node ${process.versions.node})`;

class DmError extends Error {}

const MIME_BY_EXT = {
	".html": "text/html", ".htm": "text/html", ".mhtml": "multipart/related", ".mht": "multipart/related",
	".md": "text/markdown", ".markdown": "text/markdown", ".pdf": "application/pdf",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".csv": "text/csv", ".tsv": "text/tab-separated-values", ".txt": "text/plain", ".log": "text/plain",
	".json": "application/json", ".drawio": "application/xml"
};

const loadConfig = () => {
	let baseUrl = process.env.DM_BASE_URL;
	let apiKey = process.env.DM_API_KEY;
	if ((!baseUrl || !apiKey) && fs.existsSync(CONFIG_PATH)) {
		const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		baseUrl = baseUrl || data.baseUrl;
		apiKey = apiKey || data.apiKey;
	}
	if (!baseUrl || !apiKey) {
		throw new DmError(`接続情報がありません。環境変数 DM_BASE_URL / DM_API_KEY を設定するか、${CONFIG_PATH} に {"baseUrl": "...", "apiKey": "dm_..."} を作成してください`);
	}
	// BASE_PATH配下(例: https://host/docs/)でも相対パスで正しく結合できるよう末尾を / に揃える
	return {baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, apiKey};
};

const request = async (method, apiPath, {query, json, formData, raw = false} = {}) => {
	const {baseUrl, apiKey} = loadConfig();
	const url = new URL(apiPath, baseUrl);
	for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
	const headers = {Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT};
	let body;
	if (json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(json);
	} else if (formData) {
		body = formData;
	}
	let res;
	try {
		res = await fetch(url, {method, headers, body});
	} catch (err) {
		throw new DmError(`接続できません: ${url} (${err.cause?.message || err.message})`);
	}
	if (!res.ok) {
		const text = await res.text();
		let detail;
		try {
			detail = JSON.parse(text);
		} catch {
			detail = {error: text};
		}
		throw new DmError(JSON.stringify({status: res.status, ...detail}));
	}
	if (raw) return Buffer.from(await res.arrayBuffer());
	const text = await res.text();
	return text ? JSON.parse(text) : null;
};

const fileBlob = (filePath) => new Blob([fs.readFileSync(filePath)], {type: MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream"});

// アーカイブされていない文書の中から、ファイル名が完全一致するものを探す(新しい版の自動判定用)
const findSameNameDocument = async (filename) => {
	const docs = await request("GET", "api/documents", {query: {q: filename}});
	const matches = docs.filter((d) => d.entryFile === filename);
	if (matches.length > 1) {
		throw new DmError(JSON.stringify({
			error: "同じファイル名の文書が複数あるため旧版を特定できません。--previous-id で指定してください",
			candidates: matches.map((d) => ({id: d.id, entryFile: d.entryFile, modified: d.modified}))
		}));
	}
	return matches[0] ?? null;
};

const docPath = (id, suffix = "") => `api/documents/${encodeURIComponent(id)}${suffix}`;

const splitList = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

// プロジェクト・フォルダはIDでも名前でも指定できるようにする(一覧に出た名前をそのまま渡せる)
const resolveProject = async (value) => {
	requireArg(value, "プロジェクト");
	const projects = await request("GET", "api/projects");
	const byId = projects.find((project) => project.id === value);
	if (byId) return byId;
	const matches = projects.filter((project) => project.name === value);
	if (matches.length > 1) {
		throw new DmError(JSON.stringify({
			error: "同じ名前のプロジェクトが複数あります。IDで指定してください",
			candidates: matches.map((project) => ({id: project.id, name: project.name}))
		}));
	}
	if (matches.length === 0) throw new DmError(`プロジェクトが見つかりません: ${value}`);
	return matches[0];
};

// 未指定ならプロジェクト直下(null)
const resolveFolder = async (projectId, value) => {
	if (!value) return null;
	const {folders = []} = await request("GET", `api/projects/${encodeURIComponent(projectId)}/tree`);
	const byId = folders.find((folder) => folder.id === value);
	if (byId) return byId.id;
	const matches = folders.filter((folder) => folder.name === value);
	if (matches.length > 1) {
		throw new DmError(JSON.stringify({
			error: "同じ名前のフォルダが複数あります。IDで指定してください",
			candidates: matches.map((folder) => ({id: folder.id, name: folder.name}))
		}));
	}
	if (matches.length === 0) throw new DmError(`フォルダが見つかりません: ${value}`);
	return matches[0].id;
};

const placeDocument = async (projectValue, documentId, folderValue) => {
	const project = await resolveProject(projectValue);
	const folderId = await resolveFolder(project.id, folderValue);
	await request("PUT", `api/projects/${encodeURIComponent(project.id)}/documents/${encodeURIComponent(documentId)}`, {json: {folderId}});
	return {projectId: project.id, projectName: project.name, folderId};
};

const commands = {
	config: async () => {
		const {baseUrl, apiKey} = loadConfig();
		return {clientVersion: CLIENT_VERSION, baseUrl, apiKey: `${apiKey.slice(0, 6)}...`, configPath: CONFIG_PATH};
	},
	// --archived はアーカイブ(論理削除)済みの一覧・検索。完全削除ではなく復元できる文書
	// --semantic は意味検索(キーワードの一致ではなく内容が近いものをスコア順に返す。
	// サーバー側でベクトル検索が無効なら503)
	search: async ([query], opts) => {
		if (opts.semantic) {
			requireArg(query, "検索語");
			return request("GET", "api/documents/search/vector", {query: {q: query, ...(opts.limit ? {limit: opts.limit} : {})}});
		}
		return request("GET", opts.archived ? "api/documents/archived" : "api/documents", {query: query ? {q: query} : undefined});
	},
	get: async ([id]) => request("GET", docPath(requireArg(id, "文書ID"))),
	versions: async ([id]) => request("GET", docPath(requireArg(id, "文書ID"), "/versions")),
	upload: async ([file], opts) => {
		requireArg(file, "ファイル");
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new DmError(`ファイルがありません: ${file}`);
		if (opts["previous-id"] && opts["replace-same-name"]) throw new DmError("--previous-id と --replace-same-name は同時に指定できません");
		let previousId = opts["previous-id"] ?? null;
		if (previousId == null && opts["replace-same-name"]) {
			previousId = (await findSameNameDocument(path.basename(file)))?.id ?? null;
		}
		const formData = new FormData();
		formData.append("uploadfile", fileBlob(file), path.basename(file));
		if (opts.preview) formData.append("previewfile", fileBlob(opts.preview), path.basename(opts.preview));
		if (previousId) formData.append("previousId", previousId);
		const uploaded = await request("POST", "api/documents", {formData});
		if (opts.tags) {
			// 旧版から引き継いだタグは残したまま追加する(タグAPIは一式置き換えのため和集合を送る)
			const tags = [...new Set([...(uploaded.tags || []), ...splitList(opts.tags)])];
			uploaded.tags = (await request("PUT", docPath(uploaded.id, "/tags"), {json: {tags}})).tags;
		}
		if (opts.project) {
			// 新しい版として登録した場合、配置は旧版から自動で引き継がれる(その上で移動したいときに使う)
			uploaded.project = await placeDocument(opts.project, uploaded.id, opts.folder);
		}
		return uploaded;
	},
	download: async ([id], opts) => {
		requireArg(id, "文書ID");
		const doc = await request("GET", docPath(id));
		const payload = await request("GET", docPath(id, "/file"), {query: {download: "1"}, raw: true});
		let out = opts.output || doc.entryFile;
		if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, doc.entryFile);
		fs.writeFileSync(out, payload);
		return {id: doc.id, entryFile: doc.entryFile, savedTo: path.resolve(out), size: payload.length};
	},
	// タグAPIは一式置き換えのため、--add/--remove はここで現在のタグと合成する
	tags: async ([id], opts) => {
		requireArg(id, "文書ID");
		const current = (await request("GET", docPath(id))).tags || [];
		if (opts.set == null && opts.add == null && opts.remove == null) return {id, tags: current};
		let tags;
		if (opts.set != null) {
			tags = splitList(opts.set);
		} else {
			const removing = new Set(splitList(opts.remove));
			tags = [...new Set([...current, ...splitList(opts.add)])].filter((tag) => !removing.has(tag));
		}
		return request("PUT", docPath(id, "/tags"), {json: {tags}});
	},
	memo: async ([id, text]) => {
		requireArg(id, "文書ID");
		return request("PUT", docPath(id, "/memo"), {json: {memo: text ?? ""}});
	},
	archive: async ([id]) => {
		await request("DELETE", docPath(requireArg(id, "文書ID")));
		return {id, archived: true, note: "完全削除ではありません。restore で元に戻せます"};
	},
	restore: async ([id]) => {
		await request("POST", docPath(requireArg(id, "文書ID"), "/restore"));
		return {id, archived: false};
	},
	links: async ([id]) => request("GET", docPath(requireArg(id, "文書ID"), "/links")),
	link: async ([id, relatedId]) => {
		requireArg(id, "文書ID");
		requireArg(relatedId, "相手の文書ID");
		await request("PUT", docPath(id, `/links/${encodeURIComponent(relatedId)}`));
		return {id, relatedId, linked: true};
	},
	unlink: async ([id, relatedId]) => {
		requireArg(id, "文書ID");
		requireArg(relatedId, "相手の文書ID");
		await request("DELETE", docPath(id, `/links/${encodeURIComponent(relatedId)}`));
		return {id, relatedId, linked: false};
	},
	// 既に別々に登録された文書同士を、後から新旧の版として紐づける。旧版はアーカイブされる
	"link-previous": async ([id, previousId]) => {
		requireArg(id, "新しい版の文書ID");
		requireArg(previousId, "旧版の文書ID");
		return request("PUT", docPath(id, "/previous"), {json: {previousId}});
	},
	"unlink-previous": async ([id]) => {
		await request("DELETE", docPath(requireArg(id, "文書ID"), "/previous"));
		return {id, previousId: null, note: "アーカイブされた旧版は元に戻りません。必要なら restore してください"};
	},
	projects: async (_rest, opts) => request("GET", opts.archived ? "api/projects/archived" : "api/projects"),
	"project-create": async ([name]) => request("POST", "api/projects", {json: {name: requireArg(name, "プロジェクト名")}}),
	"folder-create": async ([project, name], opts) => {
		requireArg(name, "フォルダ名");
		const resolved = await resolveProject(project);
		const parentFolderId = await resolveFolder(resolved.id, opts.parent);
		const folder = await request("POST", `api/projects/${encodeURIComponent(resolved.id)}/folders`, {json: {name, parentFolderId}});
		return {projectId: resolved.id, projectName: resolved.name, ...(folder || {})};
	},
	tree: async ([project]) => {
		const resolved = await resolveProject(project);
		const tree = await request("GET", `api/projects/${encodeURIComponent(resolved.id)}/tree`);
		return {projectId: resolved.id, projectName: resolved.name, ...tree};
	},
	place: async ([project, id], opts) => {
		requireArg(id, "文書ID");
		return {documentId: id, ...(await placeDocument(project, id, opts.folder))};
	},
	unplace: async ([project, id]) => {
		requireArg(id, "文書ID");
		const resolved = await resolveProject(project);
		await request("DELETE", `api/projects/${encodeURIComponent(resolved.id)}/documents/${encodeURIComponent(id)}`);
		return {projectId: resolved.id, projectName: resolved.name, documentId: id, removed: true};
	}
};

// APIの仕様をそのまま出力する(同梱コマンドに無い操作を直接呼ぶときの参照用)。
// JSONで包まずそのまま流すため、commandsとは別に扱う
const spec = async (opts) => {
	const payload = await request("GET", opts.openapi ? "api/openapi.json" : "api/usage.md", {raw: true});
	process.stdout.write(payload.toString("utf8"));
};

// SSEはサーバーが30秒ごとにハートビートを送るため、それより十分長く無通信なら切れたとみなして再接続する
const WATCH_IDLE_TIMEOUT_MS = 75 * 1000;
const WATCH_ACTIVITY_EVENT = "document-activity";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SSEのレスポンスボディから {event, data} を順に返す。コメント行(:heartbeat 等)は読み捨てる。
// データを受け取るたびに onActivity() を呼び、無通信の監視に使う
async function* iterSseEvents(body, onActivity) {
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let data = [];
	for await (const chunk of body) {
		onActivity();
		buffer += decoder.decode(chunk, {stream: true});
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line === "") {
				if (data.length > 0) yield {event, data: data.join("\n")};
				event = "message";
				data = [];
			} else if (line.startsWith(":")) {
				continue;
			} else if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice(5).trimStart());
			}
		}
	}
}

// 操作の通知を待ち受けて、1イベント1行のJSON(NDJSON)で標準出力へ流す。
// 切断されたら自動で再接続する(切断中のイベントは再送されない)
const watch = async (opts) => {
	const {baseUrl, apiKey} = loadConfig();
	const count = opts.count ? Number(opts.count) : null;
	const actions = opts.action ? new Set(opts.action.split(",").map((a) => a.trim()).filter(Boolean)) : null;
	const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : null;
	let printed = 0;
	let backoffMs = 1000;
	for (;;) {
		if (deadline != null && Date.now() >= deadline) {
			console.error("タイムアウトしました");
			return;
		}
		const controller = new AbortController();
		let idleTimer = null;
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => controller.abort(new Error("無通信のため切断")), WATCH_IDLE_TIMEOUT_MS);
		};
		// 全体の期限が来たら接続を閉じて、待ち受けを終わらせる
		const deadlineTimer = deadline == null ? null : setTimeout(() => controller.abort(new Error("timeout")), Math.max(0, deadline - Date.now()));
		try {
			resetIdle();
			const res = await fetch(new URL("api/documents/events", baseUrl), {
				headers: {Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream", "User-Agent": USER_AGENT},
				signal: controller.signal
			});
			if (res.status === 401 || res.status === 403) {
				throw new DmError(JSON.stringify({status: res.status, error: await res.text()}));
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			backoffMs = 1000;
			for await (const {event, data} of iterSseEvents(res.body, resetIdle)) {
				if (event !== WATCH_ACTIVITY_EVENT && !opts.all) continue;
				let payload;
				try {
					payload = data ? JSON.parse(data) : {};
				} catch {
					payload = {data};
				}
				if (event === WATCH_ACTIVITY_EVENT && actions != null && !actions.has(payload.action)) continue;
				process.stdout.write(`${JSON.stringify({event, ...payload})}\n`);
				printed++;
				if (count != null && printed >= count) return;
			}
			if (opts["no-reconnect"]) throw new DmError("サーバーが接続を閉じました");
		} catch (err) {
			if (err instanceof DmError) throw err;
			if (deadline != null && Date.now() >= deadline) {
				console.error("タイムアウトしました");
				return;
			}
			if (opts["no-reconnect"]) throw new DmError(`接続が切れました: ${err.message}`);
			console.error(`接続が切れました(${err.cause?.message || err.message})。${backoffMs / 1000}秒後に再接続します`);
		} finally {
			clearTimeout(idleTimer);
			clearTimeout(deadlineTimer);
			controller.abort();
		}
		await sleep(backoffMs);
		backoffMs = Math.min(backoffMs * 2, 30000);
	}
};

function requireArg(value, label) {
	if (!value) throw new DmError(`${label}を指定してください`);
	return value;
}

const main = async () => {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {
			"previous-id": {type: "string"},
			"replace-same-name": {type: "boolean"},
			preview: {type: "string"},
			tags: {type: "string"},
			output: {type: "string", short: "o"},
			count: {type: "string"},
			timeout: {type: "string"},
			action: {type: "string"},
			all: {type: "boolean"},
			archived: {type: "boolean"},
			semantic: {type: "boolean"},
			limit: {type: "string"},
			set: {type: "string"},
			add: {type: "string"},
			remove: {type: "string"},
			project: {type: "string"},
			folder: {type: "string"},
			parent: {type: "string"},
			openapi: {type: "boolean"},
			version: {type: "boolean", short: "V"},
			"no-reconnect": {type: "boolean"}
		}
	});
	const [command, ...rest] = positionals;
	if (values.version && command == null) {
		console.log(`dm_client.mjs ${CLIENT_VERSION}`);
		process.exit(0);
	}
	if (command === "spec") {
		// specはMarkdown/JSONをそのまま流すため、最後のJSON一括出力はしない
		try {
			await spec(values);
			process.exit(0);
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			console.error(err.message);
			process.exit(1);
		}
	}
	if (command === "watch") {
		// watchは自分で1行ずつ出力するため、最後のJSON一括出力はしない
		try {
			await watch(values);
			process.exit(0);
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			console.error(err.message);
			process.exit(1);
		}
	}
	if (!commands[command]) {
		console.error(`使い方: node dm_client.mjs <${[...Object.keys(commands), "watch", "spec"].join("|")}> ...`);
		process.exit(2);
	}
	try {
		console.log(JSON.stringify(await commands[command](rest, values), null, 2));
	} catch (err) {
		if (!(err instanceof DmError)) throw err;
		console.error(err.message);
		process.exit(1);
	}
};

main();
