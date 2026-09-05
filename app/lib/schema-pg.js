/*!
 * schema-pg.js : Postgresバックエンド用スキーマDDL(DATABASE_BACKEND=postgres時に使用)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * db.js(SQLite)のcreateSchemaに対応するPostgres版。テーブル構成は同一に保ちつつ、方言差を吸収する:
 *   - タイムスタンプ列はTEXTのまま(アプリがISO8601文字列を渡す運用。expires_at等の文字列比較を
 *     SQLiteと同一挙動にするため。timestamptzにするとpgがDateを返し比較が変わってしまう)
 *   - datetime('now')のデフォルトは廃止(挿入時にアプリが必ず値を渡すため不要)
 *   - locked等の真偽値はINTEGER(0/1)のまま(アプリが locked===1 / locked?1:0 で扱う)
 *   - FTS5仮想テーブル(documents_fts)は作らない。代わりにpg_trgm拡張とGIN trigramインデックスを
 *     用意し、全文部分一致検索をPostgres側で実現する(検索クエリの実装はserver.js側で別途対応)
 *   - sessionsテーブルも用意する(session-storeのpostgresバックエンド用。expires_atはepoch msのBIGINT)
 *
 * すべて IF NOT EXISTS のため、起動のたびに安全に実行できる(datastore.init()から呼ばれる)。
 */

const PG_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS documents (
	id TEXT PRIMARY KEY,
	entry_file TEXT NOT NULL,
	preview_file TEXT,
	content_text TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	uploaded_by TEXT,
	uploaded_at TEXT NOT NULL,
	deleted_by TEXT,
	deleted_at TEXT,
	memo TEXT,
	vector_index_status TEXT,
	vector_index_error TEXT,
	vector_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
	document_id TEXT NOT NULL,
	tag TEXT NOT NULL,
	PRIMARY KEY (document_id, tag)
);

CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL CHECK (role IN ('readonly', 'readwrite')),
	created_by TEXT,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS allowed_users (
	email TEXT PRIMARY KEY,
	role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('admin', 'readwrite', 'readonly')),
	added_by TEXT,
	added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_order (
	tag TEXT PRIMARY KEY,
	sort_order INTEGER NOT NULL,
	updated_by TEXT,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_by TEXT,
	created_at TEXT NOT NULL,
	sort_order INTEGER NOT NULL DEFAULT 0,
	archived_by TEXT,
	archived_at TEXT,
	locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_folders (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	parent_folder_id TEXT,
	name TEXT NOT NULL,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_by TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_documents (
	project_id TEXT NOT NULL,
	document_id TEXT NOT NULL,
	folder_id TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	added_by TEXT,
	added_at TEXT NOT NULL,
	PRIMARY KEY (project_id, document_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
	id TEXT PRIMARY KEY,
	user_identifier TEXT NOT NULL,
	action TEXT NOT NULL,
	document_id TEXT,
	entry_file TEXT,
	project_id TEXT,
	project_name TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_identifier, created_at);

CREATE TABLE IF NOT EXISTS vector_search_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	chunk_size INTEGER,
	chunk_overlap INTEGER,
	vectorizer TEXT,
	updated_by TEXT,
	updated_at TEXT
);

-- express-session の永続ストア(session-storeのpostgresバックエンド用)。
-- expires_atはepoch ms。sqlite版のsessionsと同じ役割(揮発データ)
CREATE TABLE IF NOT EXISTS sessions (
	sid TEXT PRIMARY KEY,
	data TEXT NOT NULL,
	expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- 全文部分一致検索(SQLiteのFTS5 trigramの代替)。pg_trgmのGINインデックスで
-- entry_file/content_text/memo/tag のILIKE '%...%' 部分一致を高速化する
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_documents_entry_file_trgm ON documents USING gin (entry_file gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_content_text_trgm ON documents USING gin (content_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_memo_trgm ON documents USING gin (memo gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag_trgm ON document_tags USING gin (tag gin_trgm_ops);
`;

/**
 * Postgresスキーマを冪等に作成する。datastore.init()(postgresバックエンド)から呼ばれる
 */
module.exports.ensureSchema = async (ds) => {
	await ds.exec(PG_SCHEMA_DDL);
};

module.exports.PG_SCHEMA_DDL = PG_SCHEMA_DDL;
