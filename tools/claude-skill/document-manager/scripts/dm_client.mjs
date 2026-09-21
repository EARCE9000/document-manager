#!/usr/bin/env node
/*!
 * dm_client.mjs : Document Manager の API クライアント(Node.js 18+ / 外部依存なし)
 *
 * Claude Code の Skill から呼び出す想定のコマンドラインツール。結果は JSON で標準出力へ出す。
 * コマンド・オプション・接続情報の与え方は dm_client.py と同じ。
 *
 * 接続情報(いずれか。上から優先):
 *   1. 環境変数 DM_BASE_URL / DM_API_KEY
 *   2. 設定ファイル ~/.document-manager.json  {"baseUrl": "https://.../", "apiKey": "dm_..."}
 *      (環境変数 DM_CONFIG で別パスを指定可)
 *
 * 使い方:
 *   node dm_client.mjs config
 *   node dm_client.mjs search [検索語]
 *   node dm_client.mjs get <文書ID>
 *   node dm_client.mjs versions <文書ID>
 *   node dm_client.mjs upload <ファイル> [--previous-id ID | --replace-same-name] [--preview 画像] [--tags タグ1,タグ2]
 *   node dm_client.mjs download <文書ID> [-o 保存先]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {parseArgs} from "node:util";

const CONFIG_PATH = process.env.DM_CONFIG || path.join(os.homedir(), ".document-manager.json");

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
	const headers = {Authorization: `Bearer ${apiKey}`};
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

const commands = {
	config: async () => {
		const {baseUrl, apiKey} = loadConfig();
		return {baseUrl, apiKey: `${apiKey.slice(0, 6)}...`, configPath: CONFIG_PATH};
	},
	search: async ([query]) => request("GET", "api/documents", {query: query ? {q: query} : undefined}),
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
			const extra = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
			const tags = [...new Set([...(uploaded.tags || []), ...extra])];
			uploaded.tags = (await request("PUT", docPath(uploaded.id, "/tags"), {json: {tags}})).tags;
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
			output: {type: "string", short: "o"}
		}
	});
	const [command, ...rest] = positionals;
	if (!commands[command]) {
		console.error(`使い方: node dm_client.mjs <${Object.keys(commands).join("|")}> ...`);
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
