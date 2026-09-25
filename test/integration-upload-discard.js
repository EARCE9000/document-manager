/*!
 * integration-upload-discard.js : アップロード失敗時の後始末を、実サーバーで検証する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm run test:discard`
 *
 * このアプリで実ファイルが消えるのはこの経路だけ(文書の削除=アーカイブは論理削除で、
 * 実ファイルは残す)。単体の検証(test/storage-discard.test.js)に加えて、実際のアップロードで
 * 確かめる。いちばん確かめたいのは「成功した文書を消さないこと」。
 *
 * 失敗は、別の接続から全文検索用のテーブルを落として起こす。アップロードはファイルを書いた後に
 * documents と documents_fts への登録を1トランザクションで行うため、後者が失敗すると
 * 「ファイルは書けているのに登録できていない」という、後始末が必要な状態そのものになる。
 *
 * (ファイルの権限で止める方法は使えない。SQLiteは既に開いている接続で書き続けるため、
 *  後から読み取り専用にしても効かない。WindowsでもLinuxでも同じだった)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");

const REPO = path.join(__dirname, "..");
// アプリの置き場所。既定はこのリポジトリだが、コンテナ内で動かすときは /app を指す
const APP_DIR = process.env.APP_DIR || path.join(REPO, "app");
const PORT = Number(process.env.DISCARD_PORT || 18180);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (ok, message, detail) => {
	console.log(`${ok ? "  ok   " : "  FAIL "}${message}${detail != null ? ` … ${detail}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-discard-int-"));
const documentsDir = path.join(dataDir, "documents");

const upload = async (name, body, type = "text/html") => {
	const form = new FormData();
	form.append("uploadfile", new Blob([Buffer.from(body)], {type}), name);
	const res = await fetch(`${BASE}/api/documents`, {method: "POST", body: form});
	let json = null;
	try { json = await res.json(); } catch {}
	return {status: res.status, body: json};
};

const listDocumentDirs = () => {
	try {
		return fs.readdirSync(documentsDir, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
};

const main = async () => {
	const server = spawn(process.execPath, ["server.js"], {
		cwd: APP_DIR,
		env: {
			...process.env,
			AUTH_DISABLED: "true", SESSION_SECRET: "dev", BASE_PATH: "/",
			LISTEN_PORT: String(PORT), DATA_DIR: dataDir, LOG_LEVEL: "error"
		},
		stdio: ["ignore", "ignore", "inherit"]
	});
	try {
		for (let i = 0; i < 40; i++) {
			try { if ((await fetch(`${BASE}/api/version`)).ok) break; } catch {}
			await sleep(300);
		}

		console.log("■ 成功したアップロード(ファイルは残らなければならない)");
		const ok1 = await upload("残るべき文書.html", "<html><body>残るべき本文</body></html>");
		check(ok1.status === 200, "登録できる");
		check(listDocumentDirs().includes(ok1.body.id), "実ファイルが置かれている");
		check(fs.readdirSync(path.join(documentsDir, ok1.body.id)).includes("残るべき文書.html"), "原本がある");

		console.log("\n■ アーカイブしても実ファイルは残る(論理削除のため)");
		await fetch(`${BASE}/api/documents/${ok1.body.id}`, {method: "DELETE"});
		check(listDocumentDirs().includes(ok1.body.id), "アーカイブでは実ファイルを消さない");
		await fetch(`${BASE}/api/documents/${ok1.body.id}/restore`, {method: "POST"});

		console.log("\n■ 複数の文書が並んでいても混ざらない");
		const ok2 = await upload("もう1件.html", "<html><body>もう1件の本文</body></html>");
		check(ok2.status === 200 && listDocumentDirs().includes(ok2.body.id), "2件目も登録できる");

		console.log("\n■ 登録に失敗したアップロード(書いたものを捨てる)");
		const before = listDocumentDirs().length;
		// 全文検索用のテーブルを別の接続から落とし、登録のトランザクションを失敗させる
		const Database = require(path.join(APP_DIR, "node_modules", "better-sqlite3"));
		const dbDir = path.join(dataDir, "db");
		const dbFile = fs.readdirSync(dbDir).filter((name) => name.endsWith(".sqlite")).sort().pop();
		const side = new Database(path.join(dbDir, dbFile));
		side.exec("DROP TABLE IF EXISTS documents_fts");
		side.close();

		const failed = await upload("消えるべき文書.html", "<html><body>失敗する本文</body></html>");
		check(failed.status === 500, "登録に失敗する", `status=${failed.status}`);

		const after = listDocumentDirs();
		check(after.length === before, "失敗したぶんの入れ物が残っていない", `${before} → ${after.length}`);
		check(after.includes(ok1.body.id) && after.includes(ok2.body.id), "成功していた文書は無事");
		// 中身まで確認する(入れ物だけ残る/中身だけ残る、のどちらも無いこと)
		const leftovers = after.flatMap((id) => fs.readdirSync(path.join(documentsDir, id)).map((f) => `${id}/${f}`));
		check(!leftovers.some((entry) => entry.includes("消えるべき")), "失敗したファイルが残っていない", leftovers.join(", "));
		check(leftovers.some((entry) => entry.includes("残るべき文書.html")), "成功した文書の原本は残っている");
		check(leftovers.some((entry) => entry.includes("もう1件.html")), "2件目の原本も残っている");

		console.log("\n■ プレビューを別に作る形式でも、両方とも捨てる");
		// Markdownは原本に加えてプレビュー用のHTML(preview.html)も書く。
		// 原本だけ捨ててプレビューが残る、という取りこぼしが無いことを確かめる
		const failedMd = await upload("消えるべき資料.md", "# 見出し\n\n本文", "text/markdown");
		check(failedMd.status === 500, "登録に失敗する", `status=${failedMd.status}`);
		const afterMd = listDocumentDirs().flatMap((id) => fs.readdirSync(path.join(documentsDir, id)).map((f) => `${id}/${f}`));
		check(!afterMd.some((entry) => entry.includes("消えるべき資料")), "原本が残っていない");
		check(!afterMd.some((entry) => entry.endsWith("/preview.html")), "プレビューも残っていない", afterMd.join(", "));

		console.log("\n■ 照合で孤立ファイルとして現れないこと");
		const reconcile = await (await fetch(`${BASE}/api/storage-reconcile`)).json();
		check(reconcile.orphanFiles.length === 0, "孤立ファイルが増えていない", JSON.stringify(reconcile.orphanFiles));
		check(reconcile.missingFiles.length === 0, "欠損も無い", JSON.stringify(reconcile.missingFiles));

		console.log("\n■ 後始末のあとも通常のアップロードができる");
		// 落としたテーブルを戻して、後始末がDBやストレージに悪い影響を残していないことを見る
		const restore = new Database(path.join(dbDir, dbFile));
		restore.exec("CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(id UNINDEXED, entry_file, content_text, tokenize = 'trigram')");
		restore.close();
		const ok3 = await upload("あとから登録.md", "# あとから\n\n本文");
		check(ok3.status === 200, "登録できる", `status=${ok3.status}`);
		const ok3Files = ok3.body?.id ? fs.readdirSync(path.join(documentsDir, ok3.body.id)) : [];
		check(ok3Files.includes("あとから登録.md") && ok3Files.includes("preview.html"), "原本とプレビューの両方が置かれる", ok3Files.join(", "));
	} finally {
		server.kill();
		await sleep(500);
		try { fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 3}); } catch {}
	}

	console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
	process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
