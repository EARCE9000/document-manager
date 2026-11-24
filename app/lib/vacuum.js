/*!
 * vacuum.js : SQLite のファイルを詰める(VACUUM)。管理の画面の「サーバー」のタブの設定の節のボタンから動かす
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 共通アーキテクチャ「構成」の sqlite_vacuum に合わせて作った(AI Gateway と同じ作り)。
 * SQLite は行を消しても、空いたページをファイルの中に残すだけで、ファイルは小さくならない(使い回されるだけ)。
 * ここで詰めて、空いた所を除いた大きさのファイルに作り直す。
 *
 *   - データを SQLite に置くとき(DATABASE_BACKEND=sqlite。既定)だけ使える。PostgreSQL のときは available: false
 *     (そのときは ./db.js を読み込まない。読み込むと、使わない SQLite のファイルを作ってしまう)
 *   - 詰めるのは、いまの版のデータのファイル(db.DB_PATH)だけ。切り戻し用に残してある古い版のファイルは詰めない。
 *     ログインのセッションも同じファイルの sessions の表にあるので、一緒に詰まる(中身は残るので、終わればそのまま使える)
 *   - 走っている間はメンテナンス中にする(server.js。画面の要求・API は 503 maintenance)。
 *     念のため本体の接続の busy_timeout も 0 にする(./db.js の runMaintenance。裏で動く処理の書き込みを、待たせずに失敗させる)
 *   - VACUUM は別のスレッド(./vacuum-worker.js)で流し、_ping とメンテナンス中かの問い合わせには返し続ける
 *   - 始める前に空きディスクを見る。詰めた後の大きさ(使っているページ)ぶんを、一時のファイルと WAL のそれぞれに要る量とする
 *     (同じフォルダなら 2 倍)。一時のファイルは、コンテナの /tmp でなく、データのフォルダに作る(SQLITE_TMPDIR。./db.js で入れる)
 *   - 状態はメモリにだけ持つ(再起動すると前回の結果は消える。監査ログには残る)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {Worker} = require("node:worker_threads");
const logger = require("./logger.js")(path.basename(__filename));

const enabled = (process.env.DATABASE_BACKEND || "sqlite").toLowerCase() === "sqlite";
const state = {running: false, startedAt: null, startedBy: null, finishedAt: null, beforeBytes: null, afterBytes: null, durationMs: null, error: null};
let current = null;

// SQLite のときだけ読み込む(上の説明)
const db = () => require("./db.js");

// 本体のファイル(-wal・-shm も足す)の大きさ
const fileBytes = () => {
	let total = 0;
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			total += fs.statSync(db().DB_PATH + suffix).size;
		} catch (err) { /* 無いファイルは 0 */ }
	}
	return total;
};

const freeBytesOf = (dir) => {
	try {
		const stat = fs.statfsSync(dir);
		return Number(stat.bavail) * Number(stat.bsize);
	} catch (err) {
		return null;
	}
};

// 空きディスクの見積もり。WAL はデータのフォルダ、一時のファイルは SQLITE_TMPDIR に、それぞれ使っているページぶん要る
const spaceCheck = (usedBytes) => {
	const dataDir = path.dirname(db().DB_PATH);
	const tmpDir = path.resolve(process.env.SQLITE_TMPDIR || os.tmpdir());
	const dataFree = freeBytesOf(dataDir);
	if (usedBytes == null) return {diskFreeBytes: dataFree, requiredBytes: null, enough: true};
	if (tmpDir === path.resolve(dataDir)) {
		return {diskFreeBytes: dataFree, requiredBytes: usedBytes * 2, enough: dataFree == null || dataFree >= usedBytes * 2};
	}
	const tmpFree = freeBytesOf(tmpDir);
	return {diskFreeBytes: dataFree, requiredBytes: usedBytes, tmpFreeBytes: tmpFree,
		enough: (dataFree == null || dataFree >= usedBytes) && (tmpFree == null || tmpFree >= usedBytes)};
};

/**
 * 画面に返す形。詰めている間はページを数えられない(数えるとデータベースを読む)ので、usedBytes / freeBytes は null。
 * ファイルの場所(パス)は返さない(ディレクトリ構成を晒さない。api/server-status と同じ)
 */
const describe = () => {
	if (!enabled) return {available: false};
	let pages = {usedBytes: null, freeBytes: null};
	if (!state.running) {
		try {
			pages = db().pageStats();
		} catch (err) {
			pages = {usedBytes: null, freeBytes: null};
		}
	}
	const {enough, ...space} = spaceCheck(pages.usedBytes);
	return {available: true, ...state, fileName: path.basename(db().DB_PATH), fileBytes: fileBytes(),
		usedBytes: pages.usedBytes, freeBytes: pages.freeBytes, ...space, enoughSpace: enough};
};

const runWorker = () => new Promise((resolve, reject) => {
	const worker = new Worker(path.join(__dirname, "vacuum-worker.js"), {workerData: {file: db().DB_PATH}});
	let settled = false;
	worker.once("message", (message) => {
		settled = true;
		if (message.ok) resolve(message);
		else reject(Object.assign(new Error(message.error), {code: message.code}));
	});
	worker.once("error", (err) => {
		if (!settled) {
			settled = true;
			reject(err);
		}
	});
	worker.once("exit", (code) => {
		if (!settled) {
			settled = true;
			reject(new Error(`VACUUM のスレッドが途中で終わりました(終了コード ${code})`));
		}
	});
});

/**
 * 詰め始める(終わるのは待たない。終わりは describe() の running で見る)。
 * 始められないときは {status} を返す: unavailable(SQLite でないとき)/ running(走っている)/ insufficient_space(空きディスクが足りない)
 */
const start = (by) => {
	if (!enabled) return {status: "unavailable"};
	if (state.running) return {status: "running"};
	const info = describe();
	if (!info.enoughSpace) {
		return {status: "insufficient_space", diskFreeBytes: info.diskFreeBytes, requiredBytes: info.requiredBytes};
	}

	Object.assign(state, {running: true, startedAt: new Date().toISOString(), startedBy: by || null, finishedAt: null,
		beforeBytes: info.fileBytes, afterBytes: null, durationMs: null, error: null});
	const startedMs = Date.now();
	logger.info({file: info.fileName, beforeBytes: info.fileBytes}, "vacuum started");
	current = db().runMaintenance(runWorker)
		.then(() => {
			state.afterBytes = fileBytes();
			logger.info({beforeBytes: state.beforeBytes, afterBytes: state.afterBytes, durationMs: Date.now() - startedMs}, "vacuum finished");
		})
		.catch((err) => {
			state.error = err.message;
			state.afterBytes = fileBytes();
			logger.error(err, "::vacuum");
		})
		.finally(() => {
			state.running = false;
			state.finishedAt = new Date().toISOString();
			state.durationMs = Date.now() - startedMs;
			current = null;
		});
	return {status: "started"};
};

/** 終わるのを待つ(テストから) */
const wait = () => current || Promise.resolve();

/** いま詰めている最中か(server.js のメンテナンス中の扱い) */
const isRunning = () => state.running;

module.exports = {enabled, describe, start, wait, isRunning};
