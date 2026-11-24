/*!
 * vacuum-worker.js : SQLite のファイルを詰める(VACUUM)。./vacuum.js が別のスレッド(worker_threads)で動かす
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 大きなファイルだと数分かかる。本体のスレッドで流すと、その間 _ping も画面も返らなくなるので、別のスレッドで流す。
 * 本体の接続は、その間 ./db.js の runMaintenance で busy_timeout を 0 にしてある(書こうとしても待たずに失敗する)。
 * 要求はメンテナンス中として server.js で断っている。
 * 詰めた後に WAL を書き戻して -wal のファイルを 0 にする(VACUUM は WAL に全部のページを書くため、そのままだと -wal が大きく残る)。
 */

const {parentPort, workerData} = require("node:worker_threads");
const Database = require("better-sqlite3");

let database = null;
try {
	database = new Database(workerData.file);
	// 本体の接続は止めてあるが、詰め始める前に受けた要求が読み書きしている途中かもしれないので、少し待つ
	database.pragma("busy_timeout = 30000");
	database.exec("VACUUM");
	const [checkpoint] = database.pragma("wal_checkpoint(TRUNCATE)");
	parentPort.postMessage({ok: true, checkpoint});
} catch (err) {
	parentPort.postMessage({ok: false, error: err.message, code: err.code || null});
} finally {
	if (database != null) {
		try { database.close(); } catch (err) { /* 閉じられなくても結果は返してある */ }
	}
}
