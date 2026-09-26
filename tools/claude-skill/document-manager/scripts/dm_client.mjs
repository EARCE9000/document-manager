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
 *   node dm_client.mjs download <文書ID> [-o 保存先] [--render]
 *       --render で「体裁つき」のPDFを取得する(Office文書のみ)
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
import zlib from "node:zlib";
import {parseArgs} from "node:util";

const CONFIG_PATH = process.env.DM_CONFIG || path.join(os.homedir(), ".document-manager.json");

// このクライアント(Skill)のバージョン。dm_client.py と必ず揃える(結合テストで検証している)。
// 変更したらタグ skill-v<この値> を打つと、CIがGitHub Releaseを作る
const CLIENT_VERSION = "1.3.0";
const USER_AGENT = `document-manager-skill/${CLIENT_VERSION} (node ${process.versions.node})`;

class DmError extends Error {}

// サーバーが「より新しいクライアントがある」と知らせてきたら、1度だけ標準エラーへ出す。
// AIエージェントはこの文面を読み、利用者へ更新を促せる
let updateNotified = false;
// サーバーが更新されたことを知らせてきたら、1度だけ標準エラーへ出す
let serverUpdateNotified = false;
const notifyIfServerUpdated = (res) => {
	const build = res.headers.get("x-server-updated");
	// サーバーが名乗った値をそのまま文面に入れるため、形を検査する(日時のタグを想定)
	if (!build || !/^[0-9A-Za-z._-]{1,40}$/.test(build) || serverUpdateNotified) return;
	serverUpdateNotified = true;
	console.error(
		`[サーバー更新のお知らせ] Document Managerが更新されました(build ${build})。\n`
		+ `  手元の手順書(SKILL.md)や以前取得したAPI仕様は古い可能性があります。`
		+ `対応ファイル形式やAPIが増えていることがあるため、`
		+ `\`spec\` コマンドで最新の利用ガイドを取り直してから作業してください。`
	);
};

const notifyIfOutdated = (res, baseUrl) => {
	const latest = res.headers.get("x-skill-latest-version");
	// この値はサーバが名乗ったもので、そのまま自分の文面(AIが「ツールの言葉」として読む文)に
	// 埋め込む。接続先が正規でない場合(設定ミス・DNSの乗っ取り・平文通信)に任意の文章を
	// 混ぜ込まれないよう、数字3組だけを受け付ける。サーバ側でも同じ検査をしている
	if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return;
	if (updateNotified || latest === CLIENT_VERSION) return;
	updateNotified = true;
	console.error(
		`[更新のお知らせ] このDocument Manager用クライアントは ${CLIENT_VERSION} ですが、サーバーには ${latest} があります。\n`
		+ `  更新方法: ${baseUrl}api/claude-skill.zip を取得し、いま使っている document-manager フォルダを中身ごと置き換えてください`
		+ `(画面右上の「APIキー管理」→「AIエージェント用 Skill」からも取得できます)。\n`
		+ `  この作業は利用者の環境で行う必要があります。ユーザーに伝えてください。`
	);
};

// サーバから受け取ったファイル名を、そのままローカルの保存先に使わないための正規化。
// 名前を決めるのはアップロードした人であって、こちらではない。パス区切り(/ \)が
// 混じっていると、書き込み先を作業場所の外へ持ち出せてしまう(Windowsでは \ も区切り)。
// サーバ側でも入口で拒否しているが、古いサーバや正規でない接続先が相手でも
// 破られないよう、書き込む直前にもう一度絞る
const safeLocalFilename = (name) => {
	const last = String(name ?? "").replace(/\\/g, "/").split("/").pop();
	// eslint-disable-next-line no-control-regex
	const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+|\.+$/g, "");
	return cleaned || "download";
};

const MIME_BY_EXT = {
	".html": "text/html", ".htm": "text/html", ".mhtml": "multipart/related", ".mht": "multipart/related",
	".md": "text/markdown", ".markdown": "text/markdown", ".pdf": "application/pdf",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".csv": "text/csv", ".tsv": "text/tab-separated-values", ".txt": "text/plain", ".log": "text/plain",
	".json": "application/json", ".drawio": "application/xml",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".docm": "application/vnd.ms-word.document.macroEnabled.12",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
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
	notifyIfOutdated(res, baseUrl);
	notifyIfServerUpdated(res);
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

// ---- モックアップ用: ディレクトリをZIPに固める ----
// 外部依存を持たない方針のため、zlib だけで最小限のZIP(deflate)を書く。
// 読む側(サーバー)は lib/mockup-zip.js で、ここで作る形をそのまま扱える
const crc32Table = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c;
	}
	return table;
})();

const crc32 = (buffer) => {
	let c = -1;
	for (let i = 0; i < buffer.length; i += 1) c = crc32Table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

const listFilesRecursive = (directory, prefix = "") => fs.readdirSync(directory, {withFileTypes: true})
	.flatMap((entry) => {
		const full = path.join(directory, entry.name);
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? listFilesRecursive(full, rel) : [{full, rel}];
	});

const buildZipFromDirectory = (directory) => {
	const entries = listFilesRecursive(directory).sort((a, b) => a.rel.localeCompare(b.rel));
	if (entries.length === 0) throw new DmError(`ファイルがありません: ${directory}`);
	if (!entries.some((e) => e.rel === "index.html")) {
		// ここで止めないと、登録はできるのに開けないモックアップが出来上がる
		throw new DmError(`${directory} の直下に index.html がありません(これが表示の入口になります)。\n`
			+ `含まれていたもの: ${entries.slice(0, 10).map((e) => e.rel).join(", ")}`);
	}
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const {full, rel} of entries) {
		const name = Buffer.from(rel, "utf-8");
		const body = fs.readFileSync(full);
		const deflated = zlib.deflateRawSync(body, {level: 9});
		const sum = crc32(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // ファイル名はUTF-8
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(deflated.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, deflated);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(sum, 16);
		central.writeUInt32LE(deflated.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + deflated.length;
	}
	const localPart = Buffer.concat(locals);
	const centralPart = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralPart.length, 12);
	end.writeUInt32LE(localPart.length, 16);
	return Buffer.concat([localPart, centralPart, end]);
};

const mockupPath = (id, suffix = "") => `api/mockups/${encodeURIComponent(id)}${suffix}`;
const mockupViewUrl = (id) => new URL(mockupPath(id, "/view"), loadConfig().baseUrl).toString();

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
		// --render はOffice文書を元の体裁のまま見るためのPDF(サーバー側で変換済みのもの)
		if (opts.render && doc.renderStatus !== "ok") {
			throw new DmError(JSON.stringify({
				error: "体裁つきのPDFは用意されていません",
				renderStatus: doc.renderStatus ?? null,
				hint: "対象はExcel/Word/PowerPoint。変換中(pending)なら少し待つ。failedなら管理者に再実行を依頼する"
			}));
		}
		const payload = await request("GET", docPath(id, "/file"), {
			query: opts.render ? {render: "1"} : {download: "1"},
			raw: true
		});
		const entryFile = safeLocalFilename(doc.entryFile);
		const name = opts.render ? `${path.basename(entryFile, path.extname(entryFile))}.pdf` : entryFile;
		let out = opts.output || name;
		if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, name);
		fs.writeFileSync(out, payload);
		return {id: doc.id, entryFile: doc.entryFile, savedTo: path.resolve(out), size: payload.length, rendered: Boolean(opts.render)};
	},
	// ---- モックアップ(ビルド済みのWebページ一式。文書とは別のコレクション) ----
	mockups: async (_args, opts) => request("GET", opts.archived ? "api/mockups/archived" : "api/mockups",
		{query: opts.q ? {q: opts.q} : undefined}),
	"mockup-get": async ([id]) => {
		requireArg(id, "モックアップID");
		return request("GET", mockupPath(id));
	},
	"mockup-versions": async ([id]) => {
		requireArg(id, "モックアップID");
		return request("GET", mockupPath(id, "/versions"));
	},
	// ZIPでもディレクトリでも受け取る(AIが作るのはたいていディレクトリのため)
	"mockup-upload": async ([target], opts) => {
		requireArg(target, "ZIPまたはディレクトリ");
		if (!fs.existsSync(target)) throw new DmError(`ファイルもディレクトリもありません: ${target}`);
		const isDirectory = fs.statSync(target).isDirectory();
		// ZIPのファイル名は表示名の既定値とダウンロード名に使われるので、ディレクトリ名を付ける
		const zipName = isDirectory
			? `${safeLocalFilename(path.basename(path.resolve(target))) || "mockup"}.zip`
			: path.basename(target);
		const zipBytes = isDirectory ? buildZipFromDirectory(target) : fs.readFileSync(target);

		const formData = new FormData();
		formData.append("mockupfile", new Blob([zipBytes], {type: "application/zip"}), zipName);
		if (opts.name) formData.append("name", opts.name);
		if (opts.preview) formData.append("previewfile", fileBlob(opts.preview), path.basename(opts.preview));
		if (opts["previous-id"]) formData.append("previousId", opts["previous-id"]);
		const created = await request("POST", "api/mockups", {formData});
		// 登録しただけでは意味がないので、利用者に渡すURLを一緒に返す
		created.viewUrl = mockupViewUrl(created.id);
		return created;
	},
	"mockup-url": async ([id]) => {
		requireArg(id, "モックアップID");
		return {id, viewUrl: mockupViewUrl(id), note: "このURLを利用者に伝えて、ブラウザで開いてもらってください"};
	},
	"mockup-download": async ([id], opts) => {
		requireArg(id, "モックアップID");
		const mockup = await request("GET", mockupPath(id));
		const payload = await request("GET", mockupPath(id, "/download"), {raw: true});
		let out = opts.output || safeLocalFilename(mockup.zipFile || `${id}.zip`);
		if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, safeLocalFilename(mockup.zipFile || `${id}.zip`));
		fs.writeFileSync(out, payload);
		return {id, savedTo: path.resolve(out), bytes: payload.length};
	},
	"mockup-memo": async ([id, text]) => {
		requireArg(id, "モックアップID");
		return request("PUT", mockupPath(id, "/memo"), {json: {memo: text ?? ""}});
	},
	"mockup-rename": async ([id, name]) => {
		requireArg(id, "モックアップID");
		requireArg(name, "新しい名前");
		return request("PUT", mockupPath(id, "/name"), {json: {name}});
	},
	"mockup-archive": async ([id]) => {
		requireArg(id, "モックアップID");
		await request("DELETE", mockupPath(id));
		return {id, archived: true, note: "完全削除ではありません。mockup-restore で元に戻せます"};
	},
	"mockup-restore": async ([id]) => {
		requireArg(id, "モックアップID");
		return request("POST", mockupPath(id, "/restore"));
	},

	// ---- お品書き(プロジェクトの資料一覧＋説明書き) ----
	manifest: async ([project]) => {
		requireArg(project, "プロジェクト");
		const resolved = await resolveProject(project);
		return request("GET", `api/projects/${encodeURIComponent(resolved.id)}/manifest`);
	},
	note: async ([project, text], opts) => {
		requireArg(project, "プロジェクト");
		requireArg(text, "説明");
		const resolved = await resolveProject(project);
		if (opts.folder) {
			const folderId = await resolveFolder(resolved.id, opts.folder);
			if (!folderId) throw new DmError(`フォルダが見つかりません: ${opts.folder}`);
			return request("PUT", `api/projects/${encodeURIComponent(resolved.id)}/folders/${encodeURIComponent(folderId)}/note`, {json: {note: text}});
		}
		if (!opts.id) throw new DmError("文書ID(--id)かフォルダID(--folder)のどちらかを指定してください");
		return request("PUT", `api/projects/${encodeURIComponent(resolved.id)}/documents/${encodeURIComponent(opts.id)}/note`, {json: {note: text}});
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

// お品書きのMarkdownは人に渡す文面なので、JSONで包まずそのまま流す(specと同じ扱い)
const manifestMarkdown = async (project) => {
	requireArg(project, "プロジェクト");
	const resolved = await resolveProject(project);
	const payload = await request("GET", `api/projects/${encodeURIComponent(resolved.id)}/manifest.md`, {raw: true});
	process.stdout.write(payload.toString("utf8"));
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

// 異常終了。process.exit は使わない: Windowsでは標準エラーへの書き込みが残っている状態で
// 呼ぶと libuv の assertion でクラッシュし、終了コードが意図した値にならないことがある。
// exitCode を立てておけば、出力を吐き切ってから終了する
function fail(message, code = 1) {
	console.error(message);
	process.exitCode = code;
}

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
			q: {type: "string"},
			name: {type: "string"},
			id: {type: "string"},
			markdown: {type: "boolean"},
			render: {type: "boolean"},
			version: {type: "boolean", short: "V"},
			"no-reconnect": {type: "boolean"}
		}
	});
	const [command, ...rest] = positionals;
	if (values.version && command == null) {
		console.log(`dm_client.mjs ${CLIENT_VERSION}`);
		return;
	}
	if (command === "spec") {
		// specはMarkdown/JSONをそのまま流すため、最後のJSON一括出力はしない
		try {
			await spec(values);
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			fail(err.message);
		}
		return;
	}
	if (command === "manifest" && values.markdown) {
		try {
			await manifestMarkdown(rest[0]);
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			fail(err.message);
		}
		return;
	}
	if (command === "watch") {
		// watchは自分で1行ずつ出力するため、最後のJSON一括出力はしない
		try {
			await watch(values);
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			fail(err.message);
		}
		return;
	}
	if (!commands[command]) {
		fail(`使い方: node dm_client.mjs <${[...Object.keys(commands), "watch", "spec"].join("|")}> ...`, 2);
		return;
	}
	try {
		console.log(JSON.stringify(await commands[command](rest, values), null, 2));
	} catch (err) {
		if (!(err instanceof DmError)) throw err;
		fail(err.message);
	}
};

main();
