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

const SCHEMA_VERSION = 15;

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
			vector_indexed_at TEXT,
			previous_id TEXT,
			content_truncated INTEGER NOT NULL DEFAULT 0,
			render_status TEXT,
			render_error TEXT,
			render_file TEXT,
			rendered_at TEXT
		)
	`);
	// 版の紐付け(v10で追加): previous_idは「この文書が置き換えた旧版」の文書ID。
	// 旧版→新版の逆引き(nextの解決)に使うためインデックスを張る
	targetDb.exec(`
		CREATE INDEX IF NOT EXISTS idx_documents_previous_id ON documents (previous_id)
	`);

	// ---- モックアップ(ビルド済みの静的サイト一式。docs/mockup.md 参照) ----
	// 文書とは別のコレクションとして扱う。文書側は「実体は1ファイル」が前提で、
	// 多ファイルのZIPを同じ表に入れると入口の決め方もプレビューも歪むため混ぜない。
	// タグ・プロジェクトは持たない(割り切り)。版の鎖は文書と同じ考え方で持つ。
	// 全文検索は content_text への LIKE で行う(FTSの索引は作らない)。
	// モックアップは件数が少なく、抜けるのもHTMLのテキストだけで、
	// 索引を別に持つ手間に見合わないため
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS mockups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			zip_file TEXT NOT NULL,
			entry_file TEXT,
			preview_file TEXT,
			file_count INTEGER NOT NULL DEFAULT 0,
			total_bytes INTEGER NOT NULL DEFAULT 0,
			zip_bytes INTEGER NOT NULL DEFAULT 0,
			content_text TEXT,
			memo TEXT,
			uploaded_by TEXT,
			uploaded_at TEXT NOT NULL,
			deleted_by TEXT,
			deleted_at TEXT,
			previous_id TEXT
		)
	`);
	targetDb.exec(`
		CREATE INDEX IF NOT EXISTS idx_mockups_previous_id ON mockups (previous_id)
	`);

	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS document_tags (
			document_id TEXT NOT NULL,
			tag TEXT NOT NULL,
			PRIMARY KEY (document_id, tag)
		)
	`);

	// 関連文書(v11で追加): 文書同士の対等な(種類・方向を持たない)紐付け。
	// 1つの関係を1行で持ち、(document_id_a < document_id_b)に正規化して重複を防ぐ。
	// 版の紐付け(documents.previous_id)とは別で、そちらは新旧の直列関係を表す
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS document_links (
			document_id_a TEXT NOT NULL,
			document_id_b TEXT NOT NULL,
			created_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (document_id_a, document_id_b)
		)
	`);
	targetDb.exec(`
		CREATE INDEX IF NOT EXISTS idx_document_links_b ON document_links (document_id_b)
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
			revoked_at TEXT,
			-- このキーに対して「サーバーが更新された」と最後に知らせたときのビルド(VERSION.jsonのVERSION)。
			-- 現在のビルドと違うときだけ知らせ、知らせたら書き込む。これにより1回の更新につき
			-- キーごとに1回だけになる。起動時のリセットは行わない(クラッシュ復帰やホスト再起動でも
			-- 起動するため、起動を合図にすると何も変わっていないのに知らせてしまう)
			notified_build TEXT
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
	// アーカイブ(論理削除)された文書はこの索引から外す(アーカイブが増えても索引が肥大しないように)。
	// アーカイブ済みの検索は documents.content_text へのLIKEで行い、復元時にここへ入れ直す。
	targetDb.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
			id UNINDEXED,
			entry_file,
			content_text,
			tokenize = 'trigram'
		)
	`);

	// ベクトル検索のチャンク分割設定(v8で追加)・ベクトライザー選択(v9で追加)。id=1固定の
	// シングルトン行。chunk_size/chunk_overlap/vectorizerがNULLの間は環境変数
	// (VECTOR_CHUNK_SIZE/VECTOR_CHUNK_OVERLAP/WEAVIATE_VECTORIZER)の既定値を使う
	// (admin画面から上書きされたらそちらを優先する。vector-search.js参照)。vectorizerの
	// 実際の認証情報(APIキー等)はDBには保存せず環境変数のまま(vector-search.js冒頭のコメント参照)
	targetDb.exec(`
		CREATE TABLE IF NOT EXISTS vector_search_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			chunk_size INTEGER,
			chunk_overlap INTEGER,
			vectorizer TEXT,
			updated_by TEXT,
			updated_at TEXT
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
	},
	8: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at FROM old.documents;

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
			// vector_search_settingsはv7に存在しないため対象外(空のまま=環境変数の既定値を使う)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	9: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at FROM old.documents;

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

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// vector_search_settings.vectorizerはv8に存在しないため対象外(NULLのまま=環境変数の既定値を使う)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	10: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at FROM old.documents;

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

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// documents.previous_idはv9に存在しないため対象外(NULLのまま=旧版の紐付けなしとして移行される)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	11: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id FROM old.documents;

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

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// document_linksはv10に存在しないため対象外(createSchema()で空のまま作られたものをそのまま使う)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	15: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated, render_status, render_error, render_file, rendered_at)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated, render_status, render_error, render_file, rendered_at FROM old.documents;

				INSERT INTO document_tags (document_id, tag)
				SELECT document_id, tag FROM old.document_tags;

				INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at, notified_build)
				SELECT id, label, key_hash, role, created_by, created_at, expires_at, last_used_at, revoked_at, notified_build FROM old.api_keys;

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

				INSERT INTO document_links (document_id_a, document_id_b, created_by, created_at)
				SELECT document_id_a, document_id_b, created_by, created_at FROM old.document_links;

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// mockups はv15で新しく作る表のため、引き継ぐものが無い
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	14: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated, render_status, render_error, render_file, rendered_at)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated, render_status, render_error, render_file, rendered_at FROM old.documents;

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

				INSERT INTO document_links (document_id_a, document_id_b, created_by, created_at)
				SELECT document_id_a, document_id_b, created_by, created_at FROM old.document_links;

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// api_keys.notified_build はv13に存在しないため対象外。NULLのまま移行されるので、
			// 移行後の最初のアクセスで「サーバーが更新された」と1回知らせることになる(意図どおり)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	13: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id, content_truncated FROM old.documents;

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

				INSERT INTO document_links (document_id_a, document_id_b, created_by, created_at)
				SELECT document_id_a, document_id_b, created_by, created_at FROM old.document_links;

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// documents.render_status/render_error/render_file/rendered_atはv12に存在しないため対象外
			// (移行後は未変換として扱われ、必要になったときに変換される)
		} finally {
			newDb.exec("DETACH DATABASE old");
		}
	},
	12: (newDb, oldDbPath) => {
		newDb.prepare("ATTACH DATABASE ? AS old").run(oldDbPath);
		try {
			newDb.exec(`
				INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id)
				SELECT id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, vector_index_status, vector_index_error, vector_indexed_at, previous_id FROM old.documents;

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

				INSERT INTO document_links (document_id_a, document_id_b, created_by, created_at)
				SELECT document_id_a, document_id_b, created_by, created_at FROM old.document_links;

				INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at)
				SELECT id, chunk_size, chunk_overlap, vectorizer, updated_by, updated_at FROM old.vector_search_settings;
			`);
			// documents.content_truncatedはv11に存在しないため対象外(0=切り詰めなしとして移行される)
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

// 全文検索の索引を「アーカイブされていない文書だけ」の状態に揃える(起動のたびに実行して安全な差分処理)。
// 1) まだ索引に無いアクティブな文書を取り込む(移行直後・この対応より前のデータもここで拾われる)
// 2) 既に索引に入っているアーカイブ済み文書を外す(本文はdocumentsに残るため、復元時に入れ直せる)
db.exec(`
	INSERT INTO documents_fts (id, entry_file, content_text)
	SELECT id, entry_file, content_text FROM documents
	WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM documents_fts)
`);
db.exec(`
	DELETE FROM documents_fts
	WHERE id IN (SELECT id FROM documents WHERE deleted_at IS NOT NULL)
`);

logger.info({DB_PATH: DB_PATH, SCHEMA_VERSION}, "sqlite database ready");

module.exports = db;
