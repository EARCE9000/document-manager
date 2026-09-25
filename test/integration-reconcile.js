/*!
 * integration-reconcile.js : DBと実ファイルの照合を、実際に食い違いを作って検証する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm run test:reconcile`
 *
 * この機能は「壊れているように見える状態」を正しく扱えるかが本体で、正常系だけ見ても
 * 意味がない。特に「ストレージに到達できていないときに何も報告しない」ガードは、
 * これが無いと未マウント時に全件を欠損として報告し、それを信じた操作で
 * 取り返しのつかないことになる。実サーバーを起動して、食い違いを作って確かめる。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");

const REPO = path.join(__dirname, "..");
const PORT = 18160;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (ok, message, detail) => {
	console.log(`${ok ? "  ok   " : "  FAIL "}${message}${detail != null ? ` … ${detail}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-reconcile-"));
const documentsDir = path.join(dataDir, "documents");

const main = async () => {
	const server = spawn(process.execPath, ["server.js"], {
		cwd: path.join(REPO, "app"),
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

		// 正常な文書を1件アップロードする
		const form = new FormData();
		form.append("uploadfile", new Blob([Buffer.from("<html><body>正常な文書</body></html>")], {type: "text/html"}), "正常.html");
		const uploaded = await (await fetch(`${BASE}/api/documents`, {method: "POST", body: form})).json();
		console.log(`[準備] 文書を1件登録: ${uploaded.id}`);

		console.log("\n■ 食い違いが無いとき");
		let result = await (await fetch(`${BASE}/api/storage-reconcile`)).json();
		check(result.supported === true && !result.unavailable, "照合できる", JSON.stringify({documentCount: result.documentCount}));
		check(result.orphanFiles.length === 0 && result.missingFiles.length === 0, "食い違いなしと報告される");

		console.log("\n■ 孤立ファイル(アップロード途中で失敗した残骸を再現)");
		const orphanId = "202609_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		fs.mkdirSync(path.join(documentsDir, orphanId), {recursive: true});
		fs.writeFileSync(path.join(documentsDir, orphanId, "孤立した資料.html"), "<html><body>孤立した本文サンプル</body></html>");
		result = await (await fetch(`${BASE}/api/storage-reconcile`)).json();
		const orphan = result.orphanFiles.find((item) => item.id === orphanId);
		check(orphan != null, "孤立ファイルとして報告される");
		check(orphan?.entryFile === "孤立した資料.html", "元のファイルを特定できる", orphan?.entryFile);
		check(orphan?.restorable === true, "復元できると判定される");

		console.log("\n■ 復元(アーカイブ済みとして登録される)");
		const restored = await (await fetch(`${BASE}/api/storage-reconcile/restore`, {
			method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: orphanId})
		})).json();
		check(restored.archived === true, "アーカイブ済みとして登録される", JSON.stringify(restored.entryFile));
		const active = await (await fetch(`${BASE}/api/documents`)).json();
		check(!active.some((doc) => doc.id === orphanId), "現役の一覧には現れない(一覧を汚さない)");
		const archived = await (await fetch(`${BASE}/api/documents/archived`)).json();
		check(archived.some((doc) => doc.id === orphanId), "アーカイブ一覧に現れる");
		// 復元操作で全文検索に戻る
		await fetch(`${BASE}/api/documents/${orphanId}/restore`, {method: "POST"});
		const searched = await (await fetch(`${BASE}/api/documents?q=${encodeURIComponent("孤立した本文サンプル")}`)).json();
		check(searched.some((doc) => doc.id === orphanId), "復元すると全文検索で見つかる(本文を抽出し直している)");

		console.log("\n■ 二重復元と不正なID");
		const again = await fetch(`${BASE}/api/storage-reconcile/restore`, {
			method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: orphanId})
		});
		check(again.status === 409, "既に登録済みなら409", `status=${again.status}`);
		for (const bad of ["../../etc", "not-an-id", "202609_zzzz"]) {
			const res = await fetch(`${BASE}/api/storage-reconcile/restore`, {
				method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: bad})
			});
			check(res.status === 400, `不正なIDは400: ${JSON.stringify(bad)}`, `status=${res.status}`);
		}

		console.log("\n■ DBにあるのに実ファイルが無い(消さないこと)");
		fs.rmSync(path.join(documentsDir, uploaded.id), {recursive: true, force: true});
		result = await (await fetch(`${BASE}/api/storage-reconcile`)).json();
		check(result.missingFiles.some((item) => item.id === uploaded.id), "欠損として報告される");
		const stillThere = await (await fetch(`${BASE}/api/documents/${uploaded.id}`)).json();
		check(stillThere.id === uploaded.id, "DBの行は消されない(メタ情報を失わない)");

		console.log("\n■ ストレージに到達できないとき(最重要のガード)");
		// 全ディレクトリを退避して「未マウント」を再現する
		const stash = path.join(dataDir, "stash");
		fs.renameSync(documentsDir, stash);
		fs.mkdirSync(documentsDir, {recursive: true});
		result = await (await fetch(`${BASE}/api/storage-reconcile`)).json();
		check(result.unavailable === true, "障害として扱い、照合を中止する", result.reason);
		check(result.missingFiles === undefined, "欠損一覧を報告しない(全件が失われたと誤報しない)");
		fs.rmSync(documentsDir, {recursive: true, force: true});
		fs.renameSync(stash, documentsDir);
	} finally {
		server.kill();
		await sleep(500);
		try { fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 3}); } catch {}
	}

	console.log(failures === 0 ? "\nすべて成功しました" : `\n${failures} 件失敗しました`);
	process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
