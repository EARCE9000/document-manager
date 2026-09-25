/*!
 * mockup-storage.js : モックアップのファイルの置き場所と、配信のための読み出し
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 置き場所は文書とは別(`<DATA_DIR>/mockups/<ID>/`)。理由は docs/mockup.md を参照。
 *
 *   <ID>/
 *     source.zip        原本(ダウンロードはこれを返す)
 *     preview.<ext>     一覧に出すプレビュー画像(アップロードしてもらう)
 *     site/             ZIPを展開したもの(配信するのはここだけ)
 *
 * ---- 配信で守ること ----
 * 展開時にエントリ名を厳しく検査しているが、配信時のパスは**利用者が送ってくるURL**であり
 * 別物なので、ここでもう一度確かめる。ブラウザは送る前にURLを正規化するため通常は届かないが、
 * 直接叩かれる可能性があるため、解決後のパスが site/ の内側に収まることを毎回確かめる。
 *
 * ---- ローカル保存のみ ----
 * S3/GCSは、多数の小さなファイルを個別に配信することになり費用と遅延の面で別問題になる。
 * 第一弾はローカルのみ対応とし、それ以外の構成ではこの機能を無効にする(docs/mockup.md)。
 */

const fs = require("fs");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const Storage = require("./storage.js");

const DATA_DIR = process.env.DATA_DIR || "/data";
const MOCKUPS_DIR = path.join(DATA_DIR, "mockups");
const SITE_DIR = "site";
const ZIP_FILE = "source.zip";

// サーバーが採番するID(YYYYMM_UUID)。ディレクトリ名として使う前に必ず確かめる
const MOCKUP_ID = /^[0-9]{6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id) => {
	if (typeof id !== "string" || !MOCKUP_ID.test(id)) throw new Error(`扱えないモックアップIDです: ${JSON.stringify(id)}`);
};

/** この構成で使えるか(ローカル保存のみ対応) */
module.exports.isEnabled = () => Storage.STORAGE_BACKEND === "local";
module.exports.MOCKUPS_DIR = MOCKUPS_DIR;
module.exports.ZIP_FILE = ZIP_FILE;

module.exports.mockupDir = (id) => {
	assertId(id);
	return path.join(MOCKUPS_DIR, id);
};
module.exports.siteDir = (id) => path.join(module.exports.mockupDir(id), SITE_DIR);

module.exports.prepare = (id) => {
	const dir = module.exports.siteDir(id);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
};

module.exports.writeFile = (id, name, buffer) => {
	assertId(id);
	// name はこのモジュールの呼び出し側が決める固定の名前(source.zip / preview.<ext>)。
	// 念のため、区切り文字を含むものは受け付けない
	if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
		throw new Error(`扱えないファイル名です: ${JSON.stringify(name)}`);
	}
	fs.writeFileSync(path.join(module.exports.mockupDir(id), name), buffer);
};

module.exports.readFile = (id, name) => {
	assertId(id);
	if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
	try {
		return fs.readFileSync(path.join(module.exports.mockupDir(id), name));
	} catch {
		return null;
	}
};

/**
 * 配信するファイルの実体パスを解決する。
 *
 * @param {string} id モックアップID
 * @param {string} requestPath URLから取り出した、site/ からの相対パス(利用者が送ってくる値)
 * @returns {string|null} 読み出してよい絶対パス。外を指す・存在しない場合は null
 */
module.exports.resolveSiteFile = (id, requestPath) => {
	let root;
	try {
		root = path.resolve(module.exports.siteDir(id));
	} catch {
		return null;
	}
	// URLのパスは符号化されていることがある(日本語のファイル名など)
	let decoded;
	try {
		decoded = decodeURIComponent(String(requestPath || ""));
	} catch {
		return null;
	}
	// 制御文字・NULを含むものは受け付けない
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
	// 先頭の / を落とし、空なら入口を指しているものとして扱う(呼び出し側が入口名を渡す)
	const relative = decoded.replace(/^\/+/, "");
	if (relative === "") return null;

	const target = path.resolve(root, relative);
	// 展開時にも名前を検査しているが、ここで来るのは利用者が送ってきたURLで別物。
	// 解決した結果が site/ の内側に収まることを必ず確かめる
	if (target !== root && !target.startsWith(root + path.sep)) {
		logger.warn({mockupId: id, requestPath}, "::resolveSiteFile: 置き場所の外を指す要求を拒否しました");
		return null;
	}
	try {
		const stat = fs.statSync(target);
		if (!stat.isFile()) return null;
	} catch {
		return null;
	}
	return target;
};

/**
 * 登録に失敗したときの後始末。書いたファイルを名前で指定して捨てる。
 * 文書側の discardUpload と同じ考え方で、再帰削除は使わない。
 * site/ の中身は展開処理が報告したファイル名を渡す。
 */
module.exports.discard = (id, siteFiles = []) => {
	assertId(id);
	const dir = module.exports.mockupDir(id);
	const site = module.exports.siteDir(id);

	for (const relative of siteFiles) {
		if (typeof relative !== "string" || relative === "" || relative.includes("..")) continue;
		const target = path.resolve(site, relative);
		if (target !== site && !target.startsWith(site + path.sep)) continue;
		try { fs.rmSync(target, {force: true}); } catch {}
	}
	// 固定の名前のものを消す(原本とプレビュー画像)
	for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
		if (name === ZIP_FILE || name.startsWith("preview.")) {
			try { fs.rmSync(path.join(dir, name), {force: true}); } catch {}
		}
	}
	// 空になった入れ物だけを片付ける。再帰削除ではないため、想定外のものが残っていれば
	// 失敗する(=消さない)。それが正しい
	const removeIfEmpty = (target) => { try { fs.rmdirSync(target); } catch {} };
	// site/ の中に作られた下位ディレクトリを、深いものから順に畳む
	const directories = [];
	const walk = (current) => {
		let entries = [];
		try { entries = fs.readdirSync(current, {withFileTypes: true}); } catch { return; }
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const child = path.join(current, entry.name);
				directories.push(child);
				walk(child);
			}
		}
	};
	walk(site);
	for (const child of directories.sort((a, b) => b.length - a.length)) removeIfEmpty(child);
	removeIfEmpty(site);
	removeIfEmpty(dir);
};
