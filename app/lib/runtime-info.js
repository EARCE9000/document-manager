/*!
 * runtime-info.js : 動いている部品(コンテナ・土台・ライブラリ)の版を集める(管理画面の「サーバー」タブ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 土台の部品(Node.js・OpenSSL・OS・DB・ライブラリ)に脆弱性が見つかったとき、「うちは当てはまるか」を
 * SSH せずに管理画面から判断できるようにする。本体だけでなく、変換サービス(Office・PDF)・Weaviate・DB の版もまとめる。
 *
 * ライブラリの版は、イメージを作るときに実際に入ったもの(node_modules/.package-lock.json。npm が書く)から読む。
 * イメージは package.json からその場で npm install するので、リポジトリの package-lock.json とは食い違うことがある。
 *
 * 版の情報は弱点を探す手がかりにもなるので、管理者だけが見られる API からだけ返す(公開の api/version には載せない)。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");

/** OS の名前(コンテナの /etc/os-release。無ければ null) */
const osRelease = () => {
	try {
		return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync("/etc/os-release", "utf8"))?.[1] ?? null;
	} catch {
		return null;
	}
};

/** 本体の土台(Node.js・V8・OpenSSL・OS・カーネル・CPU・メモリ) */
module.exports.appRuntime = () => {
	const memory = process.memoryUsage();
	return {
		node: process.versions.node,
		v8: process.versions.v8,
		openssl: process.versions.openssl ?? null,
		uv: process.versions.uv,
		os: osRelease() ?? `${os.type()} ${os.release()}`,
		kernel: os.release(),
		arch: process.arch,
		cpus: os.cpus().length,
		memory: {rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, totalBytes: os.totalmem()}
	};
};

let packagesCache = null;
/**
 * 入っている npm の部品の一覧(版つき)。直接使っているもの(package.json の dependencies)には direct: true。
 * 起動中は変わらないので 1 回だけ読む
 * @returns {{source: string, packages: Array<{name: string, version: string, direct: boolean, path: string}>}}
 */
const packages = () => {
	if (packagesCache != null) return packagesCache;
	let direct = new Set();
	try {
		direct = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).dependencies ?? {}));
	} catch {
		// package.json が読めなくても、一覧は出す
	}
	const list = [];
	let source = "node_modules/.package-lock.json";
	try {
		const lock = JSON.parse(fs.readFileSync(path.join(APP_DIR, "node_modules", ".package-lock.json"), "utf8"));
		for (const [where, info] of Object.entries(lock.packages ?? {})) {
			if (!where.startsWith("node_modules/") || info?.version == null) continue;
			// 入れ子(node_modules/a/node_modules/b)は最後の node_modules/ の後ろが名前
			const name = info.name ?? where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length);
			const nested = where.split("node_modules/").length > 2;
			list.push({name, version: String(info.version), direct: !nested && direct.has(name), path: where});
		}
	} catch {
		// npm の一覧が無いとき(開発環境の古い npm など)は、直接使っているものだけを node_modules から読む
		source = "node_modules/*/package.json";
		for (const name of direct) {
			try {
				const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, "node_modules", name, "package.json"), "utf8")).version;
				list.push({name, version: String(version), direct: true, path: `node_modules/${name}`});
			} catch {
				// 入っていないものは出さない
			}
		}
	}
	list.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	packagesCache = {source, packages: list};
	return packagesCache;
};
module.exports.packages = packages;

/** DB の版(SQLite は sqlite_version()、PostgreSQL は server_version)。読めなければ null */
module.exports.databaseVersion = async (ds) => {
	try {
		if (ds.backend === "sqlite") return (await ds.get("SELECT sqlite_version() AS v", []))?.v ?? null;
		return (await ds.get("SHOW server_version", []))?.server_version ?? null;
	} catch {
		return null;
	}
};

/** Weaviate の版と、入っているモジュール(埋め込みモデルなど)。使っていなければ null、届かなければ {reachable: false} */
module.exports.weaviateInfo = async (url, {timeoutMs = 5000} = {}) => {
	if (!url) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(new URL("v1/meta", url.endsWith("/") ? url : `${url}/`), {signal: controller.signal});
		if (!res.ok) return {reachable: false, error: `HTTP ${res.status}`};
		const meta = await res.json();
		// モジュールの中身は種類ごとに形が違う。版・モデルの名前に当たるものだけを拾う
		const modules = Object.entries(meta.modules ?? {}).map(([name, info]) => ({
			name,
			model: info?.model?._name_or_path ?? info?.model?.name ?? info?.name ?? null,
			version: info?.version ?? null
		}));
		return {reachable: true, version: meta.version ?? null, modules};
	} catch (err) {
		return {reachable: false, error: err.name === "AbortError" ? "応答がありません" : err.message};
	} finally {
		clearTimeout(timer);
	}
};
