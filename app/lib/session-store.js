/*!
 * session-store.js : express-session 用の永続セッションストア(バックエンド切替の土台)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * DATABASE_BACKEND環境変数で保存先を切り替える(既定はsqlite)。呼び出し側(server.js)は
 * createSessionStore(session)で得たStoreをexpress-sessionに渡すだけでよく、保存先が
 * SQLiteかPostgres等かを意識しない。将来ECS/Cloud Run等で複数インスタンスに水平スケール
 * する際は、DATABASE_BACKEND=postgres 等の実装をここに追加してcreateSessionStore()の
 * 分岐に足すだけで、全インスタンスでセッションを共有できる(server.js側は不変)。
 *
 * 既定のMemoryStoreと異なり、このストアはプロセス再起動をまたいでセッションを保持する
 * (ただしSESSION_SECRETが未設定で毎回ランダム生成される場合は、署名鍵が変わるため
 *  結局ログインし直しになる。永続化の恩恵を受けるにはSESSION_SECRETの固定が前提)。
 *
 * ---- sessionsテーブルの位置づけ ----
 * セッションはtransient(揮発)なデータであり、documents等の業務スキーマとは性質が異なる。
 * そのためdb.jsのスキーマバージョン移行(世代間の行コピー)の対象には含めず、ここで
 * CREATE TABLE IF NOT EXISTS するだけとする(SCHEMA_VERSIONも上げない)。スキーマ
 * バージョンが上がった場合は新バージョンのファイルに空のsessionsが作られ、利用者は
 * 再ログインする(従来から再起動時に発生していたのと同じ挙動なので実害はない)。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const DATABASE_BACKEND = (process.env.DATABASE_BACKEND || "sqlite").toLowerCase();

// 期限切れセッションを掃除する間隔
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1h
// cookieから失効時刻を決められない場合のフォールバック(express-session既定に倣う)
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// cookie.expires(またはoriginalMaxAge)から失効時刻(epoch ms)を求める(両バックエンド共通)
const getExpiresAt = (sess) => {
	const expires = sess && sess.cookie && sess.cookie.expires;
	if (expires) return new Date(expires).getTime();
	const maxAge = sess && sess.cookie && sess.cookie.originalMaxAge;
	return Date.now() + (typeof maxAge === "number" ? maxAge : FALLBACK_TTL_MS);
};

/**
 * SQLite(better-sqlite3)上の sessions テーブルに保存するストアを生成する。
 * better-sqlite3は同期APIなので、各Storeメソッドはその場で完了しコールバックを呼ぶ。
 */
const createSqliteStore = (session) => {
	const db = require("./db.js");

	// 業務スキーマの移行対象外(冒頭コメント参照)。起動のたびに安全に呼べる
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			sid TEXT PRIMARY KEY,
			data TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)");

	const selectStmt = db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?");
	const upsertStmt = db.prepare(`
		INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
		ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
	`);
	const touchStmt = db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?");
	const deleteStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
	const pruneStmt = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

	class SqliteSessionStore extends session.Store {
		get(sid, cb) {
			try {
				const row = selectStmt.get(sid);
				if (!row) return cb(null, null);
				// 期限切れは無い扱いにして掃除する(実際の一括掃除は下のタイマーが行う)
				if (row.expires_at <= Date.now()) {
					deleteStmt.run(sid);
					return cb(null, null);
				}
				return cb(null, JSON.parse(row.data));
			} catch (err) {
				return cb(err);
			}
		}

		set(sid, sess, cb) {
			try {
				upsertStmt.run(sid, JSON.stringify(sess), getExpiresAt(sess));
				return cb(null);
			} catch (err) {
				return cb(err);
			}
		}

		// resave:false でも、cookie寿命を延ばすためにexpress-sessionが呼ぶ。失効時刻だけ更新する
		touch(sid, sess, cb) {
			try {
				touchStmt.run(getExpiresAt(sess), sid);
				return cb(null);
			} catch (err) {
				return cb(err);
			}
		}

		destroy(sid, cb) {
			try {
				deleteStmt.run(sid);
				return cb(null);
			} catch (err) {
				return cb(err);
			}
		}
	}

	const store = new SqliteSessionStore();

	// 期限切れセッションを定期掃除。unref()でこのタイマーがプロセス終了を妨げないようにする
	const timer = setInterval(() => {
		try {
			const info = pruneStmt.run(Date.now());
			if (info.changes > 0) logger.debug({removed: info.changes}, "expired sessions pruned");
		} catch (err) {
			logger.warn({err}, "session prune failed");
		}
	}, PRUNE_INTERVAL_MS);
	if (timer.unref) timer.unref();

	logger.info("session store ready (backend=sqlite)");
	return store;
};

/**
 * Postgres上の sessions テーブルに保存するストアを生成する。datastore経由で非同期に
 * 読み書きし、コールバックへ橋渡しする。sessionsテーブルは schema-pg.js が作成する
 * (このストアはDDLを行わない。expires_atはepoch msのBIGINTで、pgは文字列で返すためNumber化する)
 */
const createPostgresStore = (session) => {
	const ds = require("./datastore.js");

	const SELECT_SQL = "SELECT data, expires_at FROM sessions WHERE sid = ?";
	const UPSERT_SQL = `
		INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
		ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
	`;
	const TOUCH_SQL = "UPDATE sessions SET expires_at = ? WHERE sid = ?";
	const DELETE_SQL = "DELETE FROM sessions WHERE sid = ?";
	const PRUNE_SQL = "DELETE FROM sessions WHERE expires_at <= ?";

	class PostgresSessionStore extends session.Store {
		get(sid, cb) {
			ds.get(SELECT_SQL, [sid])
				.then((row) => {
					if (!row) return cb(null, null);
					if (Number(row.expires_at) <= Date.now()) {
						return ds.run(DELETE_SQL, [sid]).then(() => cb(null, null));
					}
					return cb(null, JSON.parse(row.data));
				})
				.catch(cb);
		}

		set(sid, sess, cb) {
			ds.run(UPSERT_SQL, [sid, JSON.stringify(sess), getExpiresAt(sess)])
				.then(() => cb(null))
				.catch(cb);
		}

		touch(sid, sess, cb) {
			ds.run(TOUCH_SQL, [getExpiresAt(sess), sid])
				.then(() => cb(null))
				.catch(cb);
		}

		destroy(sid, cb) {
			ds.run(DELETE_SQL, [sid])
				.then(() => cb(null))
				.catch(cb);
		}
	}

	const store = new PostgresSessionStore();

	const timer = setInterval(() => {
		ds.run(PRUNE_SQL, [Date.now()])
			.then((info) => {
				if (info.changes > 0) logger.debug({removed: info.changes}, "expired sessions pruned");
			})
			.catch((err) => logger.warn({err}, "session prune failed"));
	}, PRUNE_INTERVAL_MS);
	if (timer.unref) timer.unref();

	logger.info("session store ready (backend=postgres)");
	return store;
};

/**
 * DATABASE_BACKENDに応じたセッションストアを返す。引数にはexpress-sessionの
 * sessionモジュール(session.Storeを継承するため)を渡す
 */
module.exports.createSessionStore = (session) => {
	switch (DATABASE_BACKEND) {
		case "sqlite":
			return createSqliteStore(session);
		case "postgres":
			return createPostgresStore(session);
		default:
			throw new Error(`未対応のDATABASE_BACKEND: ${DATABASE_BACKEND}`);
	}
};

module.exports.DATABASE_BACKEND = DATABASE_BACKEND;
