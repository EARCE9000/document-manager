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

	// 変更通知(SSE等)のpub/sub。SQLiteは単一インスタンス前提のため、プロセス内で
	// 登録済みハンドラを直接呼ぶだけでよい(NOTIFY相当をインメモリで完結させる)
	const subscribers = [];

	const datastore = {
		backend: "sqlite",

		// チャンネル横断の変更通知を購読する。handlerは通知チャンネル名を受け取る
		subscribe(channels, handler) {
			subscribers.push(handler);
		},

		// 変更を通知する。単一プロセスなので登録ハンドラを同期的に呼ぶ
		async notify(channel) {
			for (const handler of subscribers) {
				try {
					handler(channel);
				} catch (err) {
					logger.error({err, channel}, "notify handler failed");
				}
			}
		},

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

		// スキーマはdb.jsのrequire時に同期的に作成済みのためno-op(IFの統一のために用意)
		async init() {},

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

/**
 * SQLite形式のSQL(位置パラメータ ? / 名前付き @name)を pg 形式($n)へ変換する。
 * 各モジュールのSQLを書き換えずにそのまま流せるようにするための互換層。
 *   - params が配列  : ? を出現順に $1,$2,... へ
 *   - params がオブジェクト: @name を $n へ(同名は同じ $n を再利用)。値は初出順の配列にする
 * 注意: この変換はプレースホルダのみを対象とする。文字列リテラル内に ? や @ を含むSQLは
 * 想定しない(現状の全SQLは該当しない)。INSERT OR IGNORE や FTS5 MATCH 等の方言、および
 * camelCaseエイリアス(pgは小文字化する)は、呼び出し側SQLの可搬化で別途吸収する。
 */
const translatePlaceholders = (sql, params) => {
	if (params == null) {
		return {text: sql, values: []};
	}
	if (Array.isArray(params)) {
		let i = 0;
		const text = sql.replace(/\?/g, () => `$${++i}`);
		return {text, values: params};
	}
	const values = [];
	const indexByName = new Map();
	const text = sql.replace(/@(\w+)/g, (_match, name) => {
		if (!indexByName.has(name)) {
			values.push(params[name]);
			indexByName.set(name, values.length); // 1-based の $n
		}
		return `$${indexByName.get(name)}`;
	});
	return {text, values};
};

/**
 * Postgresバックエンド。executor(プール または トランザクション用client)に対して
 * get/all/run/exec を提供する共通API。
 */
const makePgApi = (executor) => ({
	async get(sql, params) {
		const {text, values} = translatePlaceholders(sql, params);
		const result = await executor.query(text, values);
		return result.rows[0];
	},
	async all(sql, params) {
		const {text, values} = translatePlaceholders(sql, params);
		const result = await executor.query(text, values);
		return result.rows;
	},
	async run(sql, params) {
		const {text, values} = translatePlaceholders(sql, params);
		const result = await executor.query(text, values);
		// pgはlastInsertRowid相当を返さない(本アプリのidはUUID採番のため未使用)
		return {changes: result.rowCount, lastInsertRowid: undefined};
	},
	async exec(sql) {
		// パラメータ無しのDDL等。pgのsimple query protocolは複数文(;区切り)を一括実行できる
		await executor.query(sql);
	},
});

const createPostgresDatastore = () => {
	const {Pool, Client} = require("pg");

	// 接続情報は DATABASE_URL(接続文字列) を優先。未指定なら pg が標準の
	// PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE 環境変数を読む。
	// マネージドPG(RDS/Cloud SQL等)でTLSが要る場合は DATABASE_SSL=true を指定する
	const poolConfig = process.env.DATABASE_URL ? {connectionString: process.env.DATABASE_URL} : {};
	if (process.env.DATABASE_SSL === "true") {
		poolConfig.ssl = {rejectUnauthorized: false};
	}
	const pool = new Pool(poolConfig);
	pool.on("error", (err) => logger.error({err}, "postgres pool error (idle client)"));

	const api = makePgApi(pool);

	// ---- 変更通知(SSE等)のpub/sub: LISTEN/NOTIFY ----
	// 複数インスタンスへ横断的に通知するため、専用の常設接続でLISTENし、通知を全インスタンスの
	// ローカルハンドラへ配る。NOTIFYは発行元インスタンス自身のLISTEN接続にも届くため、
	// 発行元・他インスタンスを区別せず一様に扱える。
	// 注意: LISTEN/NOTIFYは標準PostgreSQL(RDS/Cloud SQL等)の機能。Aurora PostgreSQLは非対応、
	// AlloyDBは要確認。横断通知が必要な水平スケール構成では RDS/Cloud SQL を使うこと。
	const listenHandlers = [];
	const listenChannels = new Set();
	let listenClient = null;
	let listenStarting = false;

	// チャンネル名は固定リテラル(documents_changed/projects_changed)のみを想定。
	// LISTENは識別子をパラメータ化できないため、英数字とアンダースコアのみ許可して埋め込む
	const isSafeChannel = (channel) => /^[a-z_][a-z0-9_]*$/i.test(channel);

	const ensureListenClient = async () => {
		if (listenClient != null || listenStarting || listenChannels.size === 0) {
			return;
		}
		listenStarting = true;
		const client = new Client(poolConfig);
		try {
			await client.connect();
			for (const channel of listenChannels) {
				if (isSafeChannel(channel)) {
					await client.query(`LISTEN ${channel}`);
				}
			}
			client.on("notification", (msg) => {
				for (const handler of listenHandlers) {
					try {
						handler(msg.channel);
					} catch (err) {
						logger.error({err, channel: msg.channel}, "notify handler failed");
					}
				}
			});
			const onLost = (err) => {
				if (err) logger.warn({err}, "postgres LISTEN connection lost; reconnecting");
				listenClient = null;
				try { client.removeAllListeners(); } catch {}
				const timer = setTimeout(() => ensureListenClient().catch((e) => logger.error({err: e}, "LISTEN reconnect failed")), 2000);
				if (timer.unref) timer.unref();
			};
			client.on("error", onLost);
			client.on("end", () => onLost(null));
			listenClient = client;
			logger.info({channels: [...listenChannels]}, "postgres LISTEN active");
		} catch (err) {
			logger.error({err}, "postgres LISTEN connect failed; will retry");
			try { await client.end(); } catch {}
			const timer = setTimeout(() => ensureListenClient().catch((e) => logger.error({err: e}, "LISTEN reconnect failed")), 2000);
			if (timer.unref) timer.unref();
		} finally {
			listenStarting = false;
		}
	};

	const datastore = {
		backend: "postgres",
		get: api.get,
		all: api.all,
		run: api.run,
		exec: api.exec,

		// 変更通知の購読。専用のLISTEN接続を(必要になった時点で)確立する
		subscribe(channels, handler) {
			listenHandlers.push(handler);
			for (const channel of channels) {
				listenChannels.add(channel);
			}
			ensureListenClient().catch((err) => logger.error({err}, "ensureListenClient failed"));
		},

		// 変更を全インスタンスへ通知する(pg_notify。チャンネル名を安全に渡せる)
		async notify(channel) {
			await pool.query("SELECT pg_notify($1, '')", [channel]);
		},

		// Postgresスキーマ(schema-pg.js)を冪等に作成する。SQLiteと異なり接続後に
		// 非同期で実行する必要があるため、server.jsの起動時(main)から一度呼ぶ
		async init() {
			const {ensureSchema} = require("./schema-pg.js");
			await ensureSchema(datastore);
			logger.info("postgres schema ensured");
		},

		async transaction(fn) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				// tx内はこのclient上でのみ実行する。fnにはclientスコープのAPIを渡す
				// (このスコープのtransactionは入れ子を張らずfnをそのまま実行する。入れ子は想定しない)
				const clientApi = makePgApi(client);
				clientApi.transaction = (innerFn) => innerFn(clientApi);
				const result = await fn(clientApi);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				try {
					await client.query("ROLLBACK");
				} catch (rollbackErr) {
					logger.error({err: rollbackErr}, "transaction rollback failed");
				}
				throw err;
			} finally {
				client.release();
			}
		},
	};

	logger.info("datastore ready (backend=postgres)");
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
		case "postgres":
			instance = createPostgresDatastore();
			break;
		default:
			throw new Error(`未対応のDATABASE_BACKEND: ${DATABASE_BACKEND}`);
	}
	return instance;
};

module.exports = getDatastore();
module.exports.DATABASE_BACKEND = DATABASE_BACKEND;
// テスト用に公開(プレースホルダ変換は純関数で副作用が無い)
module.exports.translatePlaceholders = translatePlaceholders;
