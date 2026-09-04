/*!
 * datastore.js : DBアクセスの抽象層(同期better-sqlite3をasync IFの裏に隠す。将来のPostgres対応の土台)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * このモジュールの目的は、アプリ全体をクラウド中立に保つために「DBアクセスを非同期IFへ寄せ、
 * 実バックエンド(SQLite/Postgres等)を差し替え可能にする」こと。DATABASE_BACKEND環境変数で
 * バックエンドを選ぶ(既定はsqlite)。呼び出し側(server.js/各lib)は下記の非同期IFだけを見る:
 *
 *   await ds.get(sql, params)   -> 先頭1行(オブジェクト) または undefined
 *   await ds.all(sql, params)   -> 全行(配列)
 *   await ds.run(sql, params)   -> {changes, lastInsertRowid}
 *   await ds.exec(sql)          -> 複数文の一括実行(戻り値なし)
 *   await ds.transaction(fn)    -> fn(tx) をトランザクション内で実行し、戻り値を返す
 *
 * paramsは配列(位置パラメータ ? 用)またはオブジェクト(名前付き @name 用)。
 *
 * ---- 移行方針(共存) ----
 * 既存の db.js は当面そのまま生ハンドル(better-sqlite3インスタンス)をexportし続け、
 * このdatastoreと共存させる。各モジュールを1つずつ「生ハンドル直呼び」から「datastore経由」へ
 * 置き換え、全て移行し終えたら db.js の生ハンドルexportを廃止する。SQLiteは同期APIのため、
 * 移行途中で await 漏れがあっても実DB書き込み自体は同期的に完了しており(promise解決前に
 * 実行済み)、挙動が大きく壊れにくい。ただしエラー時のunhandled rejectionを避けるため、
 * 最終的には全呼び出しで await すること。
 *
 * ---- トランザクションの実装上の注意 ----
 * better-sqlite3の db.transaction() は同期関数専用で async body(await)を包めないため、
 * ここでは明示的な BEGIN / COMMIT / ROLLBACK で実装する。SQLiteは単一コネクション・同期実行の
 * ため、fn内が純粋なDB操作(外部ネットワーク等のawaitを挟まない)である限り、他リクエストが
 * トランザクションの途中に割り込む余地はない。トランザクションの入れ子・外部awaitは想定しない。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const DATABASE_BACKEND = (process.env.DATABASE_BACKEND || "sqlite").toLowerCase();

/**
 * better-sqlite3のstmtに対し、paramsの形(配列=位置 / オブジェクト=名前付き / null)に応じて
 * 正しくバインドして実行する。better-sqlite3は配列をそのまま1引数では受けないためspreadする。
 */
const invoke = (stmt, method, params) => {
	if (params == null) return stmt[method]();
	if (Array.isArray(params)) return stmt[method](...params);
	return stmt[method](params);
};

/**
 * SQLiteバックエンド。現状の db.js の生ハンドルをラップする。
 * prepare済みstatementはSQL文字列単位でキャッシュし、同一SQLの再prepareを避ける。
 */
const createSqliteDatastore = () => {
	const db = require("./db.js");

	const stmtCache = new Map();
	const prepare = (sql) => {
		let stmt = stmtCache.get(sql);
		if (stmt == null) {
			stmt = db.prepare(sql);
			stmtCache.set(sql, stmt);
		}
		return stmt;
	};

	const datastore = {
		backend: "sqlite",

		async get(sql, params) {
			return invoke(prepare(sql), "get", params);
		},

		async all(sql, params) {
			return invoke(prepare(sql), "all", params);
		},

		async run(sql, params) {
			const info = invoke(prepare(sql), "run", params);
			return {changes: info.changes, lastInsertRowid: info.lastInsertRowid};
		},

		async exec(sql) {
			db.exec(sql);
		},

		async transaction(fn) {
			db.exec("BEGIN");
			try {
				// txスコープのハンドルとして同じdatastoreを渡す(単一コネクション)。
				// fnはこのdatastore経由のget/all/run/execだけを使うこと
				const result = await fn(datastore);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				try {
					db.exec("ROLLBACK");
				} catch (rollbackErr) {
					logger.error({err: rollbackErr}, "transaction rollback failed");
				}
				throw err;
			}
		},
	};

	logger.info("datastore ready (backend=sqlite)");
	return datastore;
};

let instance = null;

/**
 * DATABASE_BACKENDに応じたdatastoreのシングルトンを返す
 */
const getDatastore = () => {
	if (instance != null) return instance;
	switch (DATABASE_BACKEND) {
		case "sqlite":
			instance = createSqliteDatastore();
			break;
		default:
			throw new Error(`未対応のDATABASE_BACKEND: ${DATABASE_BACKEND}`);
	}
	return instance;
};

module.exports = getDatastore();
module.exports.DATABASE_BACKEND = DATABASE_BACKEND;
