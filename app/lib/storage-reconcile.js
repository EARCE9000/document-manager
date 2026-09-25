/*!
 * storage-reconcile.js : データベースと実ファイルの食い違いを調べる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 2方向の食い違いがある。
 *
 *   1. 実ファイルはあるのにDBに無い(孤立ファイル)
 *      アップロードは「先にファイルを書き、後からDBへ登録する」順序で、途中で失敗した
 *      ときの後始末が無い。つまり失敗のたびに増える。復元できる。
 *
 *   2. DBにあるのに実ファイルが無い
 *      報告するだけで、**消さない**。ボリュームが未マウントのときは全件が欠損に見えるため、
 *      自動で消すと「復旧可能な障害」を「恒久的なデータ消失」に変えてしまう。
 *      しかも失われるのはタグ・メモ・版の鎖・アップロード者で、ファイルからは再生できない。
 *
 * 詳細な方針は docs/admin-screen.md を参照。
 */

const fs = require("fs");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");
const Storage = require("./storage.js");

// 一度に調べる上限。文書数が多い環境で管理画面の操作がいつまでも返らないのを避ける
const MAX_ENTRIES = Number(process.env.RECONCILE_MAX_ENTRIES || 5000);

// アップロード時にサーバーが作る名前。孤立ディレクトリの中から「元のファイル」を
// 見分けるために使う(これら以外が1つだけあれば、それが元のファイル)
const GENERATED_FILE = /^(preview\.(html|svg|png|jpe?g)|render\.pdf)$/i;

// サーバーが採番する文書ID(YYYYMM_UUID)。復元の要求で受け取った値を、
// ディレクトリ名として使う前に必ずこの形で確かめる(パスの外へ出させない)
const DOCUMENT_ID = /^[0-9]{6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
module.exports.isValidDocumentId = (value) => typeof value === "string" && DOCUMENT_ID.test(value);

const SQL_SELECT_ALL_DOCUMENTS = `
	SELECT id, entry_file, deleted_at FROM documents
`;

/**
 * 調べられる構成かどうか。
 * S3/GCSは一覧取得の費用とページングが別問題になるため、第一弾はローカルのみ扱う。
 */
module.exports.isSupported = () => Storage.STORAGE_BACKEND === "local";

/**
 * DBと実ファイルの食い違いを調べる(読み取りのみ。何も変更しない)。
 *
 * @param {string} documentsDir 文書ファイルの置き場所
 */
module.exports.scan = async (documentsDir) => {
	const scannedAt = new Date().toISOString();
	if (!module.exports.isSupported()) {
		return {supported: false, backend: Storage.STORAGE_BACKEND, scannedAt};
	}

	const rows = await ds.all(SQL_SELECT_ALL_DOCUMENTS);

	// ---- ストレージに到達できているかを先に確かめる ----
	// ここを飛ばすと、ボリュームが未マウントのときに「全件が失われた」と報告してしまう。
	// 報告を信じて手を動かされると取り返しがつかないため、疑わしければ何も報告しない
	let directories;
	try {
		directories = fs.readdirSync(documentsDir, {withFileTypes: true})
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (err) {
		logger.error({err, documentsDir}, "::scan: 文書の置き場所を読めません");
		return {
			supported: true, backend: Storage.STORAGE_BACKEND, scannedAt,
			unavailable: true,
			reason: "文書の置き場所を読めません。ストレージが正しく接続されているか確認してください。"
		};
	}
	if (directories.length === 0 && rows.length > 0) {
		logger.error({documentsDir, documentCount: rows.length}, "::scan: DBに文書があるのに実ファイルが1つも無い");
		return {
			supported: true, backend: Storage.STORAGE_BACKEND, scannedAt,
			unavailable: true,
			reason: `DBには${rows.length}件の文書がありますが、実ファイルが1つも見つかりません。`
				+ "ストレージが接続されていない可能性が高いため、照合を中止しました。"
		};
	}

	const knownIds = new Set(rows.map((row) => row.id));
	const truncated = directories.length > MAX_ENTRIES || rows.length > MAX_ENTRIES;

	// ---- 1. 実ファイルだけある(DBに無い) ----
	const orphanFiles = [];
	for (const id of directories.slice(0, MAX_ENTRIES)) {
		if (knownIds.has(id)) continue;
		let files = [];
		let modifiedAt = null;
		let sizeBytes = 0;
		try {
			files = fs.readdirSync(path.join(documentsDir, id), {withFileTypes: true})
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
			for (const name of files) {
				const stat = fs.statSync(path.join(documentsDir, id, name));
				sizeBytes += stat.size;
				if (modifiedAt == null || stat.mtime > modifiedAt) modifiedAt = stat.mtime;
			}
		} catch (err) {
			logger.warn({err, id}, "::scan: 孤立ディレクトリを読めません");
		}
		const candidates = files.filter((name) => !GENERATED_FILE.test(name));
		orphanFiles.push({
			id,
			files,
			// 元のファイルが1つに定まるときだけ復元できる。0個や複数のときは人が判断する
			entryFile: candidates.length === 1 ? candidates[0] : null,
			restorable: candidates.length === 1,
			sizeBytes,
			modifiedAt: modifiedAt != null ? modifiedAt.toISOString() : null
		});
	}

	// ---- 2. DBにあるのに実ファイルが無い ----
	const missingFiles = [];
	for (const row of rows.slice(0, MAX_ENTRIES)) {
		if (row.entry_file == null) continue;
		const filePath = path.join(documentsDir, row.id, row.entry_file);
		if (fs.existsSync(filePath)) continue;
		missingFiles.push({
			id: row.id,
			entryFile: row.entry_file,
			archived: row.deleted_at != null
		});
	}

	return {
		supported: true,
		backend: Storage.STORAGE_BACKEND,
		scannedAt,
		documentCount: rows.length,
		directoryCount: directories.length,
		truncated,
		maxEntries: MAX_ENTRIES,
		orphanFiles,
		missingFiles
	};
};

/**
 * 孤立ディレクトリを調べ直して、復元に必要な情報を返す(復元そのものは呼び出し側が行う)。
 * 走査時の結果を信じず、その場でもう一度確かめる(走査から時間が経っていることがあるため)。
 */
module.exports.inspectOrphan = (documentsDir, id) => {
	if (!module.exports.isValidDocumentId(id)) return {ok: false, reason: "文書IDの形式が正しくありません"};
	const dir = path.join(documentsDir, id);
	let files;
	try {
		files = fs.readdirSync(dir, {withFileTypes: true}).filter((entry) => entry.isFile()).map((entry) => entry.name);
	} catch {
		return {ok: false, reason: "対象のディレクトリが見つかりません"};
	}
	const candidates = files.filter((name) => !GENERATED_FILE.test(name));
	if (candidates.length !== 1) {
		return {ok: false, reason: `元のファイルを1つに特定できません(候補 ${candidates.length} 件)`};
	}
	const entryFile = candidates[0];
	const stat = fs.statSync(path.join(dir, entryFile));
	return {ok: true, entryFile, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString()};
};
