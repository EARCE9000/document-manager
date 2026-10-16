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
 *   node dm_client.mjs setup --edit [--base-url URL]   設定ファイルをメモ帳などで開く(無ければひな形を作る)
 *   node dm_client.mjs setup [--base-url URL]           利用者が自分の端末で、接続先とAPIキーを入力して保存する
 *       (どちらも、APIキーをAIエージェントとのチャットに貼らずに済ませるためのもの)
 *   node dm_client.mjs config
 *   node dm_client.mjs search [検索語] [--archived]
 *   node dm_client.mjs search <検索語> --semantic [--limit N]
 *   node dm_client.mjs get <文書ID>
 *   node dm_client.mjs versions <文書ID>
 *   node dm_client.mjs upload <ファイル> [--previous-id ID | --replace-same-name] [--tags タグ1,タグ2]
 *                                        [--preview 画像(.drawioの代替表示用。通常は不要)]
 *                                        [--project プロジェクト] [--folder フォルダ]
 *   node dm_client.mjs download <文書ID> [-o 保存先] [--render | --pdf]
 *       --render で「体裁つき」のPDFを取得する(Office文書のみ)
 *       --pdf で、プレビューの見た目のままPDFにする(HTML・Markdown・MHTML・draw.ioのみ。draw.ioは図の1ページが1ページ)
 *   node dm_client.mjs tags <文書ID> [--add A,B | --remove A,B | --set A,B]
 *   node dm_client.mjs memo <文書ID> <メモ本文>
 *   node dm_client.mjs archive <文書ID> / restore <文書ID>
 *   node dm_client.mjs links <文書ID> / link <文書ID> <相手の文書ID> / unlink <文書ID> <相手の文書ID>
 *   node dm_client.mjs link-previous <新版ID> <旧版ID> / unlink-previous <文書ID>
 *   node dm_client.mjs projects [--archived] / project-create <名前> / tree <プロジェクト>
 *   node dm_client.mjs project-url <プロジェクト>
 *       人に渡す、プロジェクトを開くリンク
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
import {spawn, spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {parseArgs} from "node:util";
import {fileURLToPath} from "node:url";

const CONFIG_PATH = process.env.DM_CONFIG || path.join(os.homedir(), ".document-manager.json");

// このクライアント(Skill)のバージョン。dm_client.py と必ず揃える(結合テストで検証している)。
// 変更したらタグ skill-v<この値> を打つと、CIがGitHub Releaseを作る
const CLIENT_VERSION = "1.9.0";
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

// ---- 接続情報の登録(setup) ----
// **APIキーはAIエージェントとのチャットに貼らない。** チャットに貼ると、会話の記録やログなど、
// 利用者の手を離れた場所に残る。キーは利用者が自分で、次のどちらかで保存する(dm_client.py と同じ)。
//   setup --edit : 設定ファイル(無ければひな形を作る)をメモ帳などで開く。貼り付けて保存するだけ。
//                  開くところまでをコマンドが行うので、AIエージェントが実行してよい(キーはAIを通らない)
//   setup        : 利用者が自分の端末で実行し、表示されない入力欄に貼り付ける。接続を確かめてから保存する
const API_KEY_PLACEHOLDER = "ここにAPIキーを貼り付けてください";
const BASE_URL_PLACEHOLDER = "ここに接続先のURLを書いてください(例: https://docs.example.com/)";

/** 未設定(空、またはひな形のまま)か */
const isPlaceholder = (value) => !value || String(value).includes(API_KEY_PLACEHOLDER) || String(value).includes("ここに");

const readConfigFile = () => {
	if (!fs.existsSync(CONFIG_PATH)) return {};
	try {
		// メモ帳で保存すると先頭にBOMが付くことがある
		const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
		return data != null && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch {
		throw new DmError(`${CONFIG_PATH} の書き方が正しくありません(JSONとして読めません)。setup --edit で開いて直してください。引用符(")やカンマが消えていないかを確かめること`);
	}
};

/** 設定ファイルを書く。キーを含むので、本人以外が読めないようにする(Windowsでは効かない) */
const writeConfigFile = (data) => {
	fs.mkdirSync(path.dirname(path.resolve(CONFIG_PATH)), {recursive: true});
	const tempPath = `${CONFIG_PATH}.tmp`;
	fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
	fs.renameSync(tempPath, CONFIG_PATH);
};

/**
 * ファイルをエディタで開く。既定は、Windowsはメモ帳、macOSはテキストエディット、Linuxは既定のアプリ。
 * 開いたら待たずに戻る(AIエージェントから実行しても止まらないように)。
 * 環境変数 DM_EDITOR を指定した場合はそのコマンドで開き、閉じるまで待つ
 */
const openInEditor = (filePath) => {
	const custom = process.env.DM_EDITOR;
	if (custom) {
		const [command, ...args] = custom.split(" ").filter(Boolean);
		const result = spawnSync(command, [...args, filePath], {stdio: "inherit"});
		return result.status === 0 ? custom : null;
	}
	const command = process.platform === "win32" ? ["notepad.exe", filePath]
		: process.platform === "darwin" ? ["open", "-t", filePath]
			: ["xdg-open", filePath];
	try {
		const child = spawn(command[0], command.slice(1), {detached: true, stdio: "ignore"});
		child.on("error", () => {});
		child.unref();
		return command[0];
	} catch {
		return null;
	}
};

/** 利用者が端末の前にいて、キーを打てるか。AIエージェントから実行されたときは入力待ちで止まらないよう断る */
const isInteractive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === "function");

const askVisible = (question, defaultValue) => new Promise((resolve) => {
	process.stderr.write(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
	process.stdin.setEncoding("utf8");
	process.stdin.resume();
	process.stdin.once("data", (chunk) => {
		process.stdin.pause();
		resolve(String(chunk).trim() || defaultValue || "");
	});
});

// 打った・貼り付けた文字は出さず、1文字ごとに * を出す(後ろから覗かれる・画面共有に映る、を避けつつ、
// 貼り付けが入ったことは分かるようにする。dm_client.py と同じ)
const askSecret = (question) => new Promise((resolve, reject) => {
	process.stderr.write(`${question}: `);
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	let value = "";
	const finish = (callback) => {
		stdin.setRawMode(false);
		stdin.pause();
		stdin.removeListener("data", onData);
		process.stderr.write("\n");
		callback();
	};
	const onData = (chunk) => {
		for (const ch of chunk) {
			if (ch === "\r" || ch === "\n") {
				finish(() => resolve(value.trim()));
				return;
			}
			if (ch === "\u0003") {
				finish(() => reject(new DmError("中止しました")));
				return;
			}
			if (ch === "\u007f" || ch === "\b") {
				if (value.length > 0) {
					value = value.slice(0, -1);
					process.stderr.write("\b \b");
				}
			} else if (ch >= " ") {
				value += ch;
				process.stderr.write("*");
			}
		}
	};
	stdin.on("data", onData);
});

// 貼り付けたキーの前後に付いてきがちなもの(空白・引用符・末尾のカンマ)を取り除く
const cleanPastedKey = (value) => {
	let cleaned = value.trim().replace(/,$/, "").trim();
	if (cleaned.length >= 2 && cleaned[0] === cleaned.at(-1) && `"'`.includes(cleaned[0])) cleaned = cleaned.slice(1, -1).trim();
	return cleaned;
};

// Document Manager のキーは dm_ と、32バイトを base64url にした43文字(合わせて46文字)
const API_KEY_PATTERN = /^dm_[A-Za-z0-9_-]{43}$/;

/** キーの形が違うとき、キーそのものは出さずに、何が違うかだけを説明する */
const describeKeyShape = (apiKey) => (API_KEY_PATTERN.test(apiKey) ? null
	: "入力されたものが、Document Manager のAPIキーの形になっていません(保存していません)。"
		+ `APIキーは dm_ で始まる46文字ですが、入力は ${apiKey.length} 文字で、先頭が dm_ で${apiKey.startsWith("dm_") ? "始まっています" : "始まっていません"}。`
		+ "キー以外の文字まで一緒にコピーしていないかを確かめて、キーだけを貼り付け直してください");

const setup = async (opts) => {
	let data = readConfigFile();
	let baseUrl = opts["base-url"] || (isPlaceholder(data.baseUrl) ? null : data.baseUrl) || process.env.DM_BASE_URL || null;

	if (opts.edit) {
		const created = !fs.existsSync(CONFIG_PATH);
		let changed = created;
		if (created) data = {};
		if (baseUrl && data.baseUrl !== baseUrl) {
			data.baseUrl = baseUrl;
			changed = true;
		}
		if (!data.baseUrl) {
			data.baseUrl = BASE_URL_PLACEHOLDER;
			changed = true;
		}
		if (!data.apiKey) {
			data.apiKey = API_KEY_PLACEHOLDER;
			changed = true;
		}
		if (changed) writeConfigFile(data);
		const editor = openInEditor(CONFIG_PATH);
		const configPath = path.resolve(CONFIG_PATH);
		return {
			configPath, created, opened: editor != null, editor,
			next: editor == null
				? `エディタを自動で開けませんでした。${configPath} をメモ帳などで開き、apiKey の値を発行したAPIキーに書き換えて保存してもらってください`
				: "開いたファイルの apiKey の値(\"\" の中)を、発行したAPIキーに書き換えて保存してもらってください。保存したら config と search で接続を確かめます。APIキーをチャットで受け取らないこと"
		};
	}

	// ここから先は、利用者が自分の端末で入力する。AIエージェントが実行すると入力待ちで止まるため、断る
	if (!isInteractive()) {
		throw new DmError("setup は、利用者が自分の端末で実行するコマンドです(APIキーの入力欄が出ます)。AIエージェントは実行せず、"
			+ "利用者が実行できるよう、このコマンドをコードブロックで示してください(Claude Code のデスクトップアプリなら、"
			+ "実行ボタンから右側の端末で実行できます)。メモ帳で書き込んでもらう場合は setup --edit を使ってください。"
			+ "APIキーをチャットで受け取ってはいけません");
	}
	const currentKey = isPlaceholder(data.apiKey) ? null : data.apiKey;
	if (currentKey) {
		// 期限切れなどで発行し直したキーに入れ替える使い方。何が起きるかを先に見せる
		process.stderr.write(`いま登録されているキー(${currentKey.slice(0, 6)}...)を、これから入力するキーに置き換えます。`
			+ "接続を確かめてから保存し、繋がらなければ置き換えません(Enter だけなら中止)\n");
	}
	baseUrl = await askVisible("接続先のURL", baseUrl);
	if (!baseUrl) throw new DmError("接続先のURLが入力されていません");
	const apiKey = cleanPastedKey(await askSecret("APIキー(貼り付けた文字は * で表示されます)"));
	if (!apiKey) throw new DmError("APIキーが入力されていないため、中止しました(設定は変えていません)");
	const shapeProblem = describeKeyShape(apiKey);
	if (shapeProblem) throw new DmError(shapeProblem);
	if (!baseUrl.endsWith("/")) baseUrl += "/";
	if (!opts["no-verify"]) {
		// 入力した内容で実際に繋いでみる。繋がらないキーは保存しない(あとで分かりにくい失敗になるため)
		process.env.DM_BASE_URL = baseUrl;
		process.env.DM_API_KEY = apiKey;
		try {
			await request("GET", "api/projects");
		} catch (err) {
			if (!(err instanceof DmError)) throw err;
			throw new DmError(`この内容では接続できませんでした(保存していません): ${err.message}`);
		}
	}
	writeConfigFile({...data, baseUrl, apiKey});
	return {configPath: path.resolve(CONFIG_PATH), baseUrl, apiKey: `${apiKey.slice(0, 6)}...`, verified: !opts["no-verify"]};
};

/**
 * 利用者が実行して、APIキーを登録し直すためのコマンド。AIエージェントはこれをそのままコードブロックで示す。
 * いま動いているNode.jsとこのファイルを絶対パスで指す。Windowsは PowerShell の書き方にする(dm_client.py と同じ)
 */
const setupCommand = (baseUrl) => {
	const script = fileURLToPath(import.meta.url);
	const command = `"${process.execPath}" "${script}" setup --base-url ${baseUrl}`;
	return process.platform === "win32" ? `& ${command}` : command;
};

/** 401(キーが期限切れ・失効・違う)のときに、エラーに添える次の手順 */
const unauthorizedDetail = (baseUrl) => ({
	hint: "APIキーが期限切れか、無効です。利用者に Document Manager の「APIキー管理」で新しいキーを発行してもらい、"
		+ "setupCommand のコマンドを利用者が実行して登録し直してもらってください(コマンドをコードブロックで示す。"
		+ "自分では実行しない。APIキーをチャットで受け取らない)。登録し直したら、同じ操作をやり直す",
	setupCommand: setupCommand(baseUrl)
});

const loadConfig = () => {
	let baseUrl = process.env.DM_BASE_URL;
	let apiKey = process.env.DM_API_KEY;
	if (!baseUrl || !apiKey) {
		const data = readConfigFile();
		baseUrl = baseUrl || data.baseUrl;
		apiKey = apiKey || data.apiKey;
	}
	if (isPlaceholder(baseUrl) || isPlaceholder(apiKey)) {
		throw new DmError(`接続情報がまだ設定されていません。setup --edit で設定ファイルを開き、利用者に接続先URLとAPIキーを書き込んで保存してもらってください(${CONFIG_PATH})。APIキーをチャットで受け取ってはいけません`);
	}
	// BASE_PATH配下(例: https://host/docs/)でも相対パスで正しく結合できるよう末尾を / に揃える
	return {baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`, apiKey};
};

// withHeaders: true を付けると、raw の本体に加えて応答ヘッダーも返す({payload, headers})
const request = async (method, apiPath, {query, json, formData, raw = false, withHeaders = false} = {}) => {
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
		throw new DmError(JSON.stringify({status: res.status, ...detail, ...(res.status === 401 ? unauthorizedDetail(baseUrl) : {})}));
	}
	if (raw && withHeaders) return {payload: Buffer.from(await res.arrayBuffer()), headers: res.headers};
	if (raw) return Buffer.from(await res.arrayBuffer());
	const text = await res.text();
	return text ? JSON.parse(text) : null;
};

// download --pdf でPDFにできる文書(元ファイルの拡張子)。サーバー側(lib/html-pdf.js)と揃える
const PDF_SOURCE_EXTENSIONS = [".html", ".htm", ".md", ".markdown", ".mhtml", ".mht", ".drawio"];
// download --render の対象(Office文書)。取り違えたときに、正しいほうを案内するために持つ
const OFFICE_EXTENSIONS = [".xlsx", ".docx", ".pptx", ".xlsm", ".docm", ".pptm"];

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
	setup: async (_rest, opts) => setup(opts),
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
		const extension = path.extname(doc.entryFile || "").toLowerCase();
		if (opts.render && opts.pdf) {
			throw new DmError("--render と --pdf は同時に指定できません(--render はOffice文書、--pdf はHTML・Markdown・MHTML・draw.io)");
		}
		// --render はOffice文書を元の体裁のまま見るためのPDF(サーバー側で変換済みのもの)
		if (opts.render && doc.renderStatus !== "ok") {
			throw new DmError(JSON.stringify({
				error: "体裁つきのPDFは用意されていません",
				renderStatus: doc.renderStatus ?? null,
				hint: PDF_SOURCE_EXTENSIONS.includes(extension)
					? "HTML・Markdown・MHTML・draw.ioの文書は --render ではなく --pdf でPDFにできる"
					: "対象はExcel/Word/PowerPoint。変換中(pending)なら少し待つ。failedなら管理者に再実行を依頼する"
			}));
		}
		// --pdf はHTML・Markdown・MHTML・draw.ioを、プレビューの見た目のままPDF(draw.ioは図の1ページが1ページ)にする(その場で変換する)。
		// メール添付など、人に渡すための形
		if (opts.pdf && !PDF_SOURCE_EXTENSIONS.includes(extension)) {
			let hint = "PDFにできるのはHTML・Markdown・MHTML・draw.ioの文書だけ。それ以外は download で原本を取得する";
			if (OFFICE_EXTENSIONS.includes(extension)) hint = "Office文書は --pdf ではなく --render で体裁つきのPDFを取得できる(get の renderStatus が ok のとき)";
			else if (extension === ".pdf") hint = "この文書は元からPDF。download でそのまま取得する";
			throw new DmError(JSON.stringify({error: `この形式はPDFにできません: ${extension || "(拡張子なし)"}`, hint}));
		}
		let payload;
		let blocked = null;
		if (opts.pdf) {
			const res = await request("GET", docPath(id, "/pdf"), {raw: true, withHeaders: true});
			payload = res.payload;
			blocked = Number(res.headers.get("x-blocked-requests") || 0);
		} else {
			payload = await request("GET", docPath(id, "/file"), {
				query: opts.render ? {render: "1"} : {download: "1"},
				raw: true
			});
		}
		const entryFile = safeLocalFilename(doc.entryFile);
		const name = opts.render || opts.pdf ? `${path.basename(entryFile, path.extname(entryFile))}.pdf` : entryFile;
		let out = opts.output || name;
		if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, name);
		fs.writeFileSync(out, payload);
		const result = {id: doc.id, entryFile: doc.entryFile, savedTo: path.resolve(out), size: payload.length, rendered: Boolean(opts.render)};
		if (opts.pdf) {
			result.pdf = true;
			// 外部に置かれた画像などは読み込まないため、PDFでは抜ける。渡す前に利用者へ伝えられるようにする
			result.blockedRequests = blocked;
			if (blocked > 0) {
				result.warning = `この文書は外部に置かれた画像やスタイルを ${blocked} 件参照しているが、PDFには入っていない`
					+ "(変換時に外部へ接続しないため)。人に渡す前に、PDFを開いて見た目を確かめるようユーザーに伝えること";
			}
		}
		return result;
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

	// ---- おしながき(プロジェクトの資料一覧＋説明書き) ----
	manifest: async ([project], opts) => {
		requireArg(project, "プロジェクト");
		const resolved = await resolveProject(project);
		// 章だけを切り出す(案件全体ではなく「この章だけ渡したい」ことがある)
		const query = {};
		if (opts.folder) {
			const folderId = await resolveFolder(resolved.id, opts.folder);
			if (!folderId) throw new DmError(`フォルダが見つかりません: ${opts.folder}`);
			query.folderId = folderId;
		}
		return request("GET", `api/projects/${encodeURIComponent(resolved.id)}/manifest`, {query});
	},
	// おしながきではフォルダがそのまま章の順番になるため、人に渡す前に整えるために使う
	"folder-reorder": async ([project, folders], opts) => {
		requireArg(project, "プロジェクト");
		requireArg(folders, "並べたい順のフォルダ(カンマ区切り)");
		const resolved = await resolveProject(project);
		const parentFolderId = opts.parent ? await resolveFolder(resolved.id, opts.parent) : null;
		const folderIds = [];
		for (const value of splitList(folders)) {
			const folderId = await resolveFolder(resolved.id, value);
			if (!folderId) throw new DmError(`フォルダが見つかりません: ${value}`);
			folderIds.push(folderId);
		}
		return request("PUT", `api/projects/${encodeURIComponent(resolved.id)}/folders/reorder`,
			{json: {parentFolderId, folderIds}});
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
	// その文書のAlias。無ければ発行する(発行は冪等で、既にあればそれを返す)
	alias: async ([id]) => {
		requireArg(id, "文書ID");
		const document = await request("GET", docPath(id));
		if (document.alias) return {alias: document.alias, documentId: document.id, created: false};
		return {...await request("POST", docPath(id, "/alias")), created: true};
	},
	// 人に渡すURL。**版が変わっても同じURL**で、常に最新版が開く。
	// 文書IDのURLはその版を指したままになるため、人へ渡すとあとで「古い版を見ていた」が起きる
	"share-url": async ([id]) => {
		requireArg(id, "文書ID");
		const {baseUrl} = loadConfig();
		const result = await commands.alias([id]);
		return {
			shareUrl: `${baseUrl}api/documents/alias/${encodeURIComponent(result.alias)}/viewer`,
			alias: result.alias,
			documentId: result.documentId,
			note: "版が変わっても同じURLで、常に最新版が開きます"
		};
	},
	// 人に渡す、プロジェクトを開くURL。開くとログイン後にそのプロジェクトのおしながきが表示される。
	// 資料1件を渡すなら share-url、資料の一覧を文面にして渡すなら manifest --markdown を使う
	"project-url": async ([project]) => {
		const {baseUrl} = loadConfig();
		const resolved = await resolveProject(project);
		return {
			projectUrl: `${baseUrl}?project=${encodeURIComponent(resolved.id)}`,
			projectId: resolved.id,
			name: resolved.name ?? null,
			note: "開くにはログインが必要です。開くと、このプロジェクトの資料一覧と説明書き(おしながき)が表示されます"
		};
	},
	"alias-move": async ([alias, id]) => {
		requireArg(alias, "Alias");
		requireArg(id, "指す先にしたい文書ID");
		return request("PUT", `api/documents/alias/${encodeURIComponent(alias)}`, {json: {documentId: id}});
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

// おしながきのMarkdownは人に渡す文面なので、JSONで包まずそのまま流す(specと同じ扱い)
const manifestMarkdown = async (project, opts) => {
	requireArg(project, "プロジェクト");
	const resolved = await resolveProject(project);
	const query = {};
	if (opts.folder) {
		const folderId = await resolveFolder(resolved.id, opts.folder);
		if (!folderId) throw new DmError(`フォルダが見つかりません: ${opts.folder}`);
		query.folderId = folderId;
	}
	// 各資料には開けるリンクが付く。URLを載せたくない文面では --no-links で外す
	if (opts["no-links"]) query.links = "0";
	const payload = await request("GET", `api/projects/${encodeURIComponent(resolved.id)}/manifest.md`, {query, raw: true});
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
				throw new DmError(JSON.stringify({status: res.status, error: await res.text(), ...(res.status === 401 ? unauthorizedDetail(baseUrl) : {})}));
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
			"no-links": {type: "boolean"},
			edit: {type: "boolean"},
			"base-url": {type: "string"},
			"no-verify": {type: "boolean"},
			render: {type: "boolean"},
			pdf: {type: "boolean"},
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
			await manifestMarkdown(rest[0], values);
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
