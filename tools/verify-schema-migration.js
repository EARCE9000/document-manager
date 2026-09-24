/*!
 * verify-schema-migration.js : SQLiteスキーマの移行が、データを失わずに行われるかを実際に動かして確かめる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * SCHEMA_VERSION を上げたときに手で実行する。移行は運用中のデータに対して一度だけ走る処理で、
 * 失敗しても旧ファイルが残るため復旧はできるが、「新しい列を足したついでに既存の列を
 * INSERT文から書き落とす」類の取りこぼしは静かにデータを失う。そこを捕まえるためのもの。
 *
 * 使い方(移行元のコミットを指定する。通常は SCHEMA_VERSION を上げる直前のコミット):
 *   node tools/verify-schema-migration.js HEAD
 *   node tools/verify-schema-migration.js <移行元のコミット/タグ>
 *
 * やること:
 *   1. 指定したコミットの db.js で、当時のバージョンのDBを作り、各表に行を入れる
 *   2. 作業ツリーの db.js を同じ DATA_DIR に対して読み込む(= 移行が走る)
 *   3. 新しいファイルに行が引き継がれたか、旧ファイルが残っているかを確認する
 *
 * 自動テスト(npm test)には入れていない。「移行元」は常に過去の特定時点であって、
 * HEADを指すテストにするとコミット後に同一版の比較になり、通ったのに何も見ていない状態になるため。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");

const REPO = path.join(__dirname, "..");
const APP = path.join(REPO, "app");
// 相対require(./logger.js等)を壊さないため、取り出した旧db.jsは同じディレクトリに置く
const OLD_DB_JS = path.join(APP, "lib", ".db-previous-for-migration-check.js");

const ref = process.argv[2];
if (!ref) {
	console.error("移行元のコミットを指定してください。例: node tools/verify-schema-migration.js HEAD");
	process.exit(2);
}

let failures = 0;
const check = (ok, message, detail) => {
	console.log(`${ok ? "  ok   " : "  FAIL "}${message}${detail != null ? ` … ${detail}` : ""}`);
	if (!ok) failures++;
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-migrate-"));
const dbDir = path.join(dataDir, "db"); // db.js は DATA_DIR/db 配下に置く

const runNode = (code) => execFileSync(process.execPath, ["-e", code], {
	cwd: APP,
	env: {...process.env, DATA_DIR: dataDir, LOG_LEVEL: "error"},
	encoding: "utf-8",
	stdio: ["ignore", "pipe", "pipe"]
});

const currentVersion = /const SCHEMA_VERSION = (\d+);/.exec(fs.readFileSync(path.join(APP, "lib", "db.js"), "utf-8"))[1];

try {
	const oldSource = execFileSync("git", ["show", `${ref}:app/lib/db.js`], {cwd: REPO, encoding: "utf-8"});
	fs.writeFileSync(OLD_DB_JS, oldSource);
	const oldVersion = /const SCHEMA_VERSION = (\d+);/.exec(oldSource)[1];
	console.log(`[移行元] ${ref} = v${oldVersion} → [作業ツリー] v${currentVersion}`);
	if (oldVersion === currentVersion) {
		console.log("両者が同じバージョンです。移行は起きないため、確認する意味がありません");
		console.log("SCHEMA_VERSION を上げる直前のコミットを指定してください");
		process.exitCode = 2;
	} else {
		// 1. 移行元のバージョンのDBを作り、各表に1行入れる
		runNode(`
			const db = require("./lib/${path.basename(OLD_DB_JS)}");
			const now = new Date().toISOString();
			db.prepare("INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, memo) VALUES (?,?,?,?,?,?,?,?)")
				.run("doc-1", "報告書.xlsx", "preview.html", "本文テキスト", 123, "someone@example.com", now, "メモ本文");
			db.prepare("INSERT INTO document_tags (document_id, tag) VALUES (?,?)").run("doc-1", "設計");
			db.prepare("INSERT INTO api_keys (id, label, key_hash, role, created_by, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?,?,?)")
				.run("key-1", "既存キー", "hash-1", "readwrite", "someone@example.com", now, "2099-01-01T00:00:00.000Z", now);
			db.prepare("INSERT INTO allowed_users (email, role, added_by, added_at) VALUES (?,?,?,?)").run("someone@example.com", "admin", "seed", now);
			db.prepare("INSERT INTO tag_order (tag, sort_order, updated_by, updated_at) VALUES (?,?,?,?)").run("設計", 1, "seed", now);
			db.prepare("INSERT INTO projects (id, name, created_by, created_at, sort_order) VALUES (?,?,?,?,?)").run("prj-1", "案件A", "someone@example.com", now, 1);
			db.prepare("INSERT INTO project_documents (project_id, document_id, sort_order, added_by, added_at) VALUES (?,?,?,?,?)").run("prj-1", "doc-1", 1, "someone@example.com", now);
			db.prepare("INSERT INTO audit_log (id, user_identifier, action, document_id, entry_file, created_at) VALUES (?,?,?,?,?,?)").run("log-1", "someone@example.com", "upload", "doc-1", "報告書.xlsx", now);
			db.close();
		`);
		check(fs.existsSync(path.join(dbDir, `document_manager_v${oldVersion}.sqlite`)), `移行元(v${oldVersion})のDBを用意した`);

		// 2. 作業ツリーの db.js を読み込む = 移行が走る
		const out = runNode(`
			const db = require("./lib/db.js");
			const one = (sql) => db.prepare(sql).get();
			console.log(JSON.stringify({
				doc: one("SELECT id, entry_file, preview_file, memo, content_text, size, uploaded_by FROM documents WHERE id='doc-1'"),
				tag: one("SELECT tag FROM document_tags WHERE document_id='doc-1'"),
				key: one("SELECT id, label, role, expires_at FROM api_keys WHERE id='key-1'"),
				user: one("SELECT email, role FROM allowed_users WHERE email='someone@example.com'"),
				tagOrder: one("SELECT tag, sort_order FROM tag_order WHERE tag='設計'"),
				project: one("SELECT id, name FROM projects WHERE id='prj-1'"),
				placement: one("SELECT project_id, document_id FROM project_documents WHERE document_id='doc-1'"),
				log: one("SELECT id, action, entry_file FROM audit_log WHERE id='log-1'"),
				fts: one("SELECT id FROM documents_fts WHERE id='doc-1'")
			}));
		`);
		const result = JSON.parse(out.trim().split("\n").pop());

		console.log("\n■ 移行後のデータ");
		check(result.doc != null && result.doc.entry_file === "報告書.xlsx", "文書");
		check(result.doc != null && result.doc.memo === "メモ本文" && result.doc.content_text === "本文テキスト", "メモ・全文検索用の本文");
		check(result.doc != null && result.doc.size === 123 && result.doc.uploaded_by === "someone@example.com", "サイズ・アップロード者");
		check(result.tag != null && result.tag.tag === "設計", "文書のタグ");
		check(result.key != null && result.key.label === "既存キー" && result.key.role === "readwrite", "APIキー");
		check(result.user != null && result.user.role === "admin", "許可ユーザー");
		check(result.tagOrder != null && result.tagOrder.sort_order === 1, "タグの並び順");
		check(result.project != null && result.project.name === "案件A", "プロジェクト");
		check(result.placement != null && result.placement.project_id === "prj-1", "プロジェクトへの配置");
		check(result.log != null && result.log.action === "upload", "操作履歴");
		check(result.fts != null && result.fts.id === "doc-1", "全文検索の索引");

		console.log("\n■ 切り戻しのための旧ファイル");
		const files = fs.readdirSync(dbDir).filter((f) => f.endsWith(".sqlite")).sort();
		check(files.includes(`document_manager_v${oldVersion}.sqlite`), `v${oldVersion} が残っている(切り戻し可能)`, files.join(", "));
		check(files.includes(`document_manager_v${currentVersion}.sqlite`), `v${currentVersion} が作られた`);

		console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
		if (failures > 0) process.exitCode = 1;
	}
} finally {
	fs.rmSync(OLD_DB_JS, {force: true});
	fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 3});
}
