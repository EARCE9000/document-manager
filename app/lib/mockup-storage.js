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
 * ---- 原本はS3等へ、展開したものはローカルへ ----
 * モックアップは1ページ開くたびにHTML/CSS/JS/画像と何十回も取りに行くため、展開後のものまで
 * S3から都度配信すると、リクエスト課金と往復遅延が効いてくる。そこで置き場所を2つに分ける。
 *
 *   source.zip / preview.<ext> … STORAGE_BACKEND に従う(local / s3 / gcs)。**原本**
 *   site/                       … 常にローカルディスク。**捨ててよい控え**
 *
 * site/ は原本から作り直せるので、無ければ配信の手前で ensureSite() が作り直す。これにより
 *   - 複数インスタンス(ECS等)で、登録した台と配信する台が違っても動く
 *   - コンテナを作り直してローカルが空になっても動く
 * ようになる。逆に言うと、**site/ を先に作っておく前提のコードを書いてはいけない**。
 *
 * localのときは原本も site/ も同じ <DATA_DIR>/mockups/<ID>/ の下に来る(従来と同じ並び)。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js")(path.basename(__filename));
const Storage = require("./storage.js");

const DATA_DIR = process.env.DATA_DIR || "/data";
const MOCKUPS_DIR = path.join(DATA_DIR, "mockups");
const SITE_DIR = "site";
const ZIP_FILE = "source.zip";

// 原本の置き場所。文書と同じ入れ物へ混ぜると、文書とファイルの突き合わせ(storage-reconcile)が
// 互いを身元不明のファイルとして拾うため、prefixを分ける
const objectStore = Storage.createStorage(MOCKUPS_DIR, {prefix: process.env.MOCKUP_STORAGE_PREFIX || "mockups"});
// 原本がローカルにあるときは、site/ は控えではなく原本の隣に置かれたもの。取り直す先も同じ場所
const REMOTE_OBJECTS = Storage.STORAGE_BACKEND !== "local";

// サーバーが採番するID(YYYYMM_UUID)。ディレクトリ名として使う前に必ず確かめる
const MOCKUP_ID = /^[0-9]{6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id) => {
	if (typeof id !== "string" || !MOCKUP_ID.test(id)) throw new Error(`扱えないモックアップIDです: ${JSON.stringify(id)}`);
};

/** この構成で使えるか */
// 原本はSTORAGE_BACKENDに従い、展開したものはローカルの控えになるため、どの構成でも使える。
// 「展開したものを置くローカルディスクが要る」ことだけが条件で、これは常に満たされる。
// 機能そのもののOn/Off(既定Off・管理画面からの切り替え)は server.js 側で判断する
module.exports.isEnabled = () => true;
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

const assertObjectName = (name) => {
	// name はこのモジュールの呼び出し側が決める固定の名前(source.zip / preview.<ext>)。
	// 念のため、区切り文字を含むものは受け付けない
	if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
		throw new Error(`扱えないファイル名です: ${JSON.stringify(name)}`);
	}
};

/** 原本を書く(source.zip / preview.<ext>) */
module.exports.writeFile = async (id, name, buffer) => {
	assertId(id);
	assertObjectName(name);
	await objectStore.writeFile(id, name, buffer);
};

/** 原本を読む。無ければ null */
module.exports.readFile = async (id, name) => {
	assertId(id);
	try {
		assertObjectName(name);
	} catch {
		return null;
	}
	try {
		if (!await objectStore.exists(id, name)) return null;
		return await objectStore.readFile(id, name);
	} catch (err) {
		logger.warn({err, mockupId: id, name}, "::readFile: 原本を読めませんでした");
		return null;
	}
};

// ---- 展開したもの(site/)の用意 ----
//
// 同じモックアップに同時に来たときに二重展開しないよう、IDごとに1本にまとめる。
// 展開は一時ディレクトリへ行い、終わってから site/ へ差し替える。途中の状態を配信しないため。
const inFlight = new Map();

const hasSite = (id) => {
	try {
		return fs.readdirSync(module.exports.siteDir(id)).length > 0;
	} catch {
		return false;
	}
};

const extractToSite = async (id) => {
	const MockupZip = require("./mockup-zip.js");
	const zip = await module.exports.readFile(id, ZIP_FILE);
	if (zip == null) return false;

	const dir = module.exports.mockupDir(id);
	const staging = path.join(dir, `${SITE_DIR}.tmp-${crypto.randomBytes(6).toString("hex")}`);
	fs.mkdirSync(staging, {recursive: true});
	try {
		MockupZip.extract(zip, staging);
		const site = module.exports.siteDir(id);
		// 直前に別の経路が作り終えていたら、そちらを使う(消してから置き換えると、その隙に
		// 配信が来たときに404になる)
		if (hasSite(id)) {
			fs.rmSync(staging, {recursive: true, force: true});
			return true;
		}
		fs.rmSync(site, {recursive: true, force: true});
		fs.renameSync(staging, site);
		logger.info({mockupId: id}, "展開したものが無かったため、原本から作り直しました");
		return true;
	} catch (err) {
		fs.rmSync(staging, {recursive: true, force: true});
		logger.error({err, mockupId: id}, "::extractToSite");
		return false;
	}
};

/**
 * 配信できる状態にする。展開したものが無ければ原本から作り直す。
 *
 * 登録した台と配信する台が違う場合(ECS等)や、コンテナを作り直してローカルが空になった
 * 場合にここが効く。**配信の手前で必ず呼ぶこと。**
 *
 * @returns {Promise<boolean>} 配信できる状態になったか
 */
module.exports.ensureSite = async (id) => {
	assertId(id);
	if (hasSite(id)) return true;
	if (inFlight.has(id)) return inFlight.get(id);

	const work = extractToSite(id).finally(() => inFlight.delete(id));
	inFlight.set(id, work);
	return work;
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
 *
 * @param siteFiles   展開処理が報告した site/ 配下のファイル名
 * @param objectNames 原本として書いたものの名前(source.zip / preview.<ext>)。
 *                    受け付ける拡張子は呼び出し側が持っているため、ここで一覧を持たない
 *                    (二重に持つと、片方だけ増えたときに捨て漏れる)
 */
module.exports.discard = async (id, siteFiles = [], objectNames = []) => {
	assertId(id);
	const dir = module.exports.mockupDir(id);
	const site = module.exports.siteDir(id);

	// 原本は置き場所側に任せる(localのときも同じ場所を指す)
	const names = objectNames.filter((name) => typeof name === "string" && name !== "");
	if (names.length > 0) {
		try {
			await objectStore.discardUpload(id, names);
		} catch (err) {
			logger.warn({err, mockupId: id}, "::discard: 原本を捨てられませんでした");
		}
	}

	for (const relative of siteFiles) {
		if (typeof relative !== "string" || relative === "" || relative.includes("..")) continue;
		const target = path.resolve(site, relative);
		if (target !== site && !target.startsWith(site + path.sep)) continue;
		try { fs.rmSync(target, {force: true}); } catch {}
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
