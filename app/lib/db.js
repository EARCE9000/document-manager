/*!
 * db.js : SQLite Resource Module (documents / tags / api keys / allowed users)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- スキーマバージョニング ----
 * 破壊的なスキーマ変更(テーブルの追加・列構成の変更など)が必要になった場合は、
 * SCHEMA_VERSIONを1つ上げ、ファイル名にバージョン番号を付けた新しいsqliteファイル
 * (document_manager_v{N}.sqlite)を作る。旧バージョンのファイルは削除せずそのまま
 * 残すため、常に1つ前のバージョンへすぐ戻せる(安全性優先)。
 * v1のみ既存デプロイとの互換のため無印の document_manager.sqlite のまま。
 * 新バージョンへの移行手順はMIGRATIONS[新バージョン番号]に定義する
 * (旧ファイルをATTACHして、テーブルごとに列を明示してコピーする)。
 */

const path = require("path");
const fs = require("fs");

const logger = require("./logger.js")(path.basename(__filename));

const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_DIR = path.join(DATA_DIR, "db");

fs.mkdirSync(DB_DIR, {recursive: true});

const Database = require("better-sqlite3");

const SCHEMA_VERSION = 7;

// v1のみ既存デプロイ互換のため無印ファイル名。v2以降は _v{N} を付ける
const dbFileNameForVersion = (version) => (version === 1 ? "document_manager.sqlite" : `document_manager_v${version}.sqlite`);
const dbPathForVersion = (version) => path.join(DB_DIR, dbFileNameForVersion(version));

/**
 * 現在の(最新)スキーマを定義する。CREATE TABLE IF NOT EXISTSなので、
 * 新規作成・移行直後・通常再起動のいずれに対しても安全に呼び出せる
 */
const createSchema = (targetDb) => {
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			entry_file TEXT NOT NULL,
			preview_file TEXT,
			content_text TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			uploaded_by TEXT,
			uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
			deleted_by TEXT,
			deleted_at TEXT,
			memo TEXT,
			vector_index_status TEXT,
			vector_index_error TEXT,
			vector_indexed_at TEXT
		)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS document_tags (
			document_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (document_id, tag)
		)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL CHECK (role IN ('readonly', 'readwrite')),
			created_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			expires_at TEXT NOT NULL,
			last_used_at TEXT,
			revoked_at TEXT
		)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS allowed_users (
			email TEXT PRIMARY KEY,
			role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('admin', 'readwrite', 'readonly')),
			added_by TEXT,
			added_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	// タグ体系(タグツリー表示)用の並び順。document_tagsとは別で、
	// 「体系化したいタグだけ」をここに登録し表示順序を持たせる(v2で追加)
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS tag_order (
			tag TEXT PRIMARY KEY,
			sort_order INTEGER NOT NULL,
			updated_by TEXT,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	// プロジェクト機能(v3で追加): プロジェクト本体・プロジェクト内のフォルダ階層・
	// 文書のプロジェクトへの登録。1文書は複数プロジェクトに登録できるが、
	// 1プロジェクト内では1箇所(1フォルダ、またはNULL=プロジェクト直下)にしか置けない
	// (PRIMARY KEYがproject_id+document_id)。folder内の並び順はsort_orderで制御する
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			sort_order INTEGER NOT NULL DEFAULT 0,
			archived_by TEXT,
			archived_at TEXT,
			locked INTEGER NOT NULL DEFAULT 0
		)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS project_folders (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			parent_folder_id TEXT,
			name TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS project_documents (
			project_id TEXT NOT NULL,
			document_id TEXT NOT NULL,
			folder_id TEXT,
			sort_order INTEGER NOT NULL DEFAULT 0,
			added_by TEXT,
			added_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (project_id, document_id)
		)
	`);

	// 操作履歴(v5で追加): ユーザーが「自分が何をしたか」を後から確認できるようにするための
	// 監査ログ。標準出力の監査ログ("msg":"audit")とは別に、画面から検索・一覧できるよう
	// DBにも残す。document_id/project_idはそれぞれのレコードが後から削除されても参照が
	// 残るよう、表示に必要な情報(entry_file/project_name)をスナップショットとして
	// 一緒に保存する(JOIN不要にし、対象が消えても履歴自体は読めるようにするため)
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS audit_log (
			id TEXT PRIMARY KEY,
			user_identifier TEXT NOT NULL,
			action TEXT NOT NULL,
			document_id TEXT,
			entry_file TEXT,
			project_id TEXT,
			project_name TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	targetDb.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_identifier, created_at)
	`);

	// 全文検索用のFTS5仮想テーブル (trigramトークナイザ: 日本語等CJKでも単語分割不要で
	// 部分一致検索できるが、3文字未満のクエリはヒットしない制約があるため、
	// 短いクエリはアプリ側でLIKE検索にフォールバックする)。
	// タグは元々短い文字列でLIKEでも十分高速なため、ここには含めない。
	// 論理削除された文書の行もそのまま残す(検索時にdocuments.deleted_atで絞り込む)。
	targetDb.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
			id UNINDEXED,
			entry_file,
			content_text,
			tokenize = 'trigram'
		)
	`);
};

// 旧バージョンのファイルをATTACHし、テーブルごとに列を明示してデータをコピーする。
// 新バージョンで追加されたテーブル(tag_order等)はコピー元に存在しないため対象外とし、
// createSchema()で空のまま作られたものをそのまま使う
const MIGRATIONS = {
	2: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;
			`);
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	3: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;

				INSERT INTO tag_order (tag, sort_order, updated_by, updated_at)
				SELECT tag, sort_order, updated_by, updated_at FROM old.tag_order;
			`);
			// projects/project_folders/project_documentsはv2に存在しないため対象外
			// (createSchema()で空のまま作られたものをそのまま使う)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	4: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;

				INSERT INTO tag_order (tag, sort_order, updated_by, updated_at)
				SELECT tag, sort_order, updated_by, updated_at FROM old.tag_order;

				INSERT INTO projects (id, name, created_by, created_at, sort_order)
				SELECT id, name, created_by, created_at, sort_order FROM old.projects;

				INSERT INTO project_folders (id, project_id, parent_folder_id, name, sort_order, created_by, created_at)
				SELECT id, project_id, parent_folder_id, name, sort_order, created_by, created_at FROM old.project_folders;

				INSERT INTO project_documents (project_id, document_id, folder_id, sort_order, added_by, added_at)
				SELECT project_id, document_id, folder_id, sort_order, added_by, added_at FROM old.project_documents;
			`);
			// projects.archived_by/archived_atはv3に存在しないため対象外(NULLのまま=未アーカイブとして移行される)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	5: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;

				INSERT INTO tag_order (tag, sort_order, updated_by, updated_at)
				SELECT tag, sort_order, updated_by, updated_at FROM old.tag_order;

				INSERT INTO projects (id, name, created_by, created_at, sort_order, archived_by, archived_at)
				SELECT id, name, created_by, created_at, sort_order, archived_by, archived_at FROM old.projects;

				INSERT INTO project_folders (id, project_id, parent_folder_id, name, sort_order, created_by, created_at)
				SELECT id, project_id, parent_folder_id, name, sort_order, created_by, created_at FROM old.project_folders;

				INSERT INTO project_documents (project_id, document_id, folder_id, sort_order, added_by, added_at)
				SELECT project_id, document_id, folder_id, sort_order, added_by, added_at FROM old.project_documents;
			`);
			// audit_logはv4に存在しないため対象外(createSchema()で空のまま作られたものをそのまま使う)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	6: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;

				INSERT INTO tag_order (tag, sort_order, updated_by, updated_at)
				SELECT tag, sort_order, updated_by, updated_at FROM old.tag_order;

				INSERT INTO projects (id, name, created_by, created_at, sort_order, archived_by, archived_at)
				SELECT id, name, created_by, created_at, sort_order, archived_by, archived_at FROM old.projects;

				INSERT INTO project_folders (id, project_id, parent_folder_id, name, sort_order, created_by, created_at)
				SELECT id, project_id, parent_folder_id, name, sort_order, created_by, created_at FROM old.project_folders;

				INSERT INTO project_documents (project_id, document_id, folder_id, sort_order, added_by, added_at)
				SELECT project_id, document_id, folder_id, sort_order, added_by, added_at FROM old.project_documents;

				INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at)
				SELECT id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at FROM old.audit_log;
			`);
			// projects.lockedはv5に存在しないため対象外(既定値0=解錠として移行される)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	7: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at FROM old.api_keys;

				INSERT INTO allowed_users (email, role, added_by, added_at)
				SELECT email, role, added_by, added_at FROM old.allowed_users;

				INSERT INTO tag_order (tag, sort_order, updated_by, updated_at)
				SELECT tag, sort_order, updated_by, updated_at FROM old.tag_order;

				INSERT INTO projects (id, name, created_by, created_at, sort_order, archived_by, archived_at, locked)
				SELECT id, name, created_by, created_at, sort_order, archived_by, archived_at, locked FROM old.projects;

				INSERT INTO project_folders (id, project_id, parent_folder_id, name, sort_order, created_by, created_at)
				SELECT id, project_id, parent_folder_id, name, sort_order, created_by, created_at FROM old.project_folders;

				INSERT INTO project_documents (project_id, document_id, folder_id, sort_order, added_by, added_at)
				SELECT project_id, document_id, folder_id, sort_order, added_by, added_at FROM old.project_documents;

				INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at)
				SELECT id, user_identifier, action, document_id, entry_file, project_id, project_name, created_at FROM old.audit_log;
			`);
			// documents.vector_index_status/vector_index_error/vector_indexed_atはv6に存在しないため対象外
			// (NULLのまま移行される。ベクトル検索の起動時バックフィルが未索引として拾い直す)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	}
};

const findHighestExistingVersion = () => {
	for (let v = SCHEMA_VERSION; v >= 1; v--) {
		if (fs.existsSync(dbPathForVersion(v))) return v;
	}
	return null; // どのバージョンのファイルも無い = 新規インストール
};

const existingVersion = findHighestExistingVersion();

if (existingVersion != null && existingVersion < SCHEMA_VERSION) {
	for (let v = existingVersion + 1; v <= SCHEMA_VERSION; v++) {
		const migrate = MIGRATIONS[v];
		if (migrate == null) {
			throw new Error(`schema migration to version ${v} is not defined`);
		}
		const oldPath = dbPathForVersion(v - 1);
		const newPath = dbPathForVersion(v);
		logger.warn({from: v - 1, to: v, oldPath, newPath}, `DBスキーマをv${v - 1}からv${v}へ移行します(旧ファイルはそのまま残します)`);
		const migrationDb = new Database(newPath);
		migrationDb.pragma("journal_mode = WAL");
		createSchema(migrationDb);
		migrate(migrationDb, oldPath);
		migrationDb.close();
		logger.info({newPath}, `DBスキーマのv${v}への移行が完了しました`);
	}
}

const DB_PATH = dbPathForVersion(SCHEMA_VERSION);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
createSchema(db);

// 既存のdocuments行のうち、documents_ftsにまだ無いものを取り込む
// (起動のたびに実行しても安全な差分バックフィル。移行直後のデータもここで拾われる)
db.exec(`
	INSERT INTO documents_fts (id, entry_file, content_text)
	SELECT id, entry_file, content_text FROM documents
	WHERE id NOT IN (SELECT id FROM documents_fts)
`);

logger.info({DB_PATH: DB_PATH, SCHEMA_VERSION}, "sqlite database ready");

module.exports = db;
