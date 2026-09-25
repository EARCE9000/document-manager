/*!
 * office-render.test.js : 変換サービスへ到達できないときの振る舞いの検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 変換サービス(converter)は別コンテナで、落ちていてもアプリは動き続ける設計になっている
 * (compose の depends_on からも意図的に外してある)。
 * ところが office-render.js がロガーのファクトリを名前付きで呼び忘れていたため、
 * 到達できなかったときに logger.warn が存在せず例外になり、起動時の接続確認では
 * 未処理のPromise拒否としてプロセスごと落ちていた。
 *
 * 「落ちていても動き続ける」は設計の根幹なので、ここで固定する。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

test("到達できない変換サービスでも例外を投げず、null を返す", async () => {
	// 何も待ち受けていないポートを指す
	process.env.OFFICE_RENDER_URL = "http://127.0.0.1:19919";
	delete require.cache[require.resolve("../app/lib/office-render.js")];
	const OfficeRender = require("../app/lib/office-render.js");

	assert.equal(OfficeRender.isEnabled(), true, "URLを設定したら有効になる");
	const health = await OfficeRender.checkHealth();
	assert.equal(health, null, "到達できなければ null(例外ではない)");
});

test("未設定なら機能ごと無効で、接続確認もしない", async () => {
	delete process.env.OFFICE_RENDER_URL;
	delete require.cache[require.resolve("../app/lib/office-render.js")];
	const OfficeRender = require("../app/lib/office-render.js");

	assert.equal(OfficeRender.isEnabled(), false);
	assert.equal(await OfficeRender.checkHealth(), null);
});

test("ロガーはファクトリではなく、名前付きで生成したものを使う", async () => {
	// 呼び忘れるとファクトリ関数そのものが入り、warn/error が存在しないまま実行時に落ちる。
	// 同じ間違いを他のモジュールでもしていないか、まとめて確かめる
	const fs = require("node:fs");
	const path = require("node:path");
	const libDir = path.join(__dirname, "..", "app", "lib");
	const offenders = [];
	for (const file of fs.readdirSync(libDir).filter((name) => name.endsWith(".js"))) {
		const source = fs.readFileSync(path.join(libDir, file), "utf-8");
		// require("./logger.js") の直後に ( が続かない = 呼び忘れ
		if (/require\("\.\/logger\.js"\)\s*;/.test(source)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `ロガーの生成を呼び忘れている: ${offenders.join(", ")}`);
});
