/*!
 * project-manifest.spec.js : プロジェクトのお品書きのAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * お品書き＝プロジェクトの資料一覧に、資料ごとの説明書きを付けたもの。
 * 説明書きは「この資料がこのプロジェクトではどういう位置づけか」なので、
 * **文書そのもののメモとは別に、プロジェクトごとに持つ**。同じ文書を2つのプロジェクトへ
 * 登録して、説明が混ざらないことまで確かめる。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const upload = async (request, name, body) => (await (await request.post("api/documents", {
	headers: rw,
	multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body)}}
})).json()).id;

test.describe.serial("プロジェクトのお品書き", () => {
	let projectId;
	let otherProjectId;
	let folderId;
	let coverId;
	let specId;

	test.beforeAll(async ({request}) => {
		projectId = (await (await request.post("api/projects", {headers: rw, data: {name: `お品書きPJ ${Date.now()}`}})).json()).id;
		otherProjectId = (await (await request.post("api/projects", {headers: rw, data: {name: `別PJ ${Date.now()}`}})).json()).id;

		coverId = await upload(request, `cover-${Date.now()}.txt`, "表紙");
		specId = await upload(request, `spec-${Date.now()}.txt`, "要件定義の本文");

		folderId = (await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name: "要件"}})).json()).id;

		await request.put(`api/projects/${projectId}/documents/${coverId}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${projectId}/documents/${specId}`, {headers: rw, data: {folderId}});
	});

	test("説明書きを書くと、お品書きに載る", async ({request}) => {
		const res = await request.put(`api/projects/${projectId}/documents/${specId}/note`, {
			headers: rw, data: {note: "3章が今回の変更点です。"}
		});
		expect(res.status()).toBe(200);
		expect((await res.json()).note).toBe("3章が今回の変更点です。");

		const manifest = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		expect(manifest.folders[0].documents[0].note).toBe("3章が今回の変更点です。");
	});

	test("フォルダにも説明を付けられる(章立ての前書きになる)", async ({request}) => {
		const res = await request.put(`api/projects/${projectId}/folders/${folderId}/note`, {
			headers: rw, data: {note: "この案件で合意した範囲です。"}
		});
		expect(res.status()).toBe(200);

		const manifest = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		expect(manifest.folders[0].note).toBe("この案件で合意した範囲です。");
	});

	test("お品書きは読む順(直下の資料→フォルダ)に並ぶ", async ({request}) => {
		const manifest = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		expect(manifest.rootDocuments.map((d) => d.documentId)).toEqual([coverId]);
		expect(manifest.folders.map((f) => f.name)).toEqual(["要件"]);
		expect(manifest.documentCount).toBe(2);
	});

	// ここが設計の要。文書側のメモと混ざってはいけない
	test("同じ資料でも、プロジェクトごとに違う説明を持てる", async ({request}) => {
		await request.put(`api/projects/${otherProjectId}/documents/${specId}`, {headers: rw, data: {folderId: null}});
		await request.put(`api/projects/${otherProjectId}/documents/${specId}/note`, {
			headers: rw, data: {note: "こちらでは参考資料の扱いです。"}
		});

		const a = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		const b = await (await request.get(`api/projects/${otherProjectId}/manifest`, {headers: ro})).json();
		expect(a.folders[0].documents[0].note).toBe("3章が今回の変更点です。");
		expect(b.rootDocuments[0].note).toBe("こちらでは参考資料の扱いです。");

		// 文書そのもののメモは空のまま(説明書きが文書側へ漏れていない)
		const doc = await (await request.get(`api/documents/${specId}`, {headers: ro})).json();
		expect(doc.memo == null || doc.memo === "").toBe(true);
	});

	test("Markdownで持ち出せる", async ({request}) => {
		const res = await request.get(`api/projects/${projectId}/manifest.md`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("text/markdown");

		const md = await res.text();
		expect(md).toContain("お品書き");
		expect(md).toContain("## 要件");
		expect(md).toContain("この案件で合意した範囲です。");
		expect(md).toContain("3章が今回の変更点です。");
		// 直下の資料が章より前に来る
		expect(md.indexOf("cover-")).toBeLessThan(md.indexOf("## 要件"));
	});

	// 説明書きは自由入力で、それがそのままMarkdownの本文になる。ブラウザがこれをHTMLとして
	// 解釈すると、書いた人が見た人のブラウザで同一オリジンのまま好きなことをできてしまう
	test("Markdownの配信をブラウザにHTMLとして解釈させない", async ({request}) => {
		await request.put(`api/projects/${projectId}/documents/${coverId}/note`, {
			headers: rw, data: {note: "<html><script>window.x=1</scr" + "ipt><h1>見出し</h1>"}
		});
		const res = await request.get(`api/projects/${projectId}/manifest.md`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
		expect(res.headers()["x-content-type-options"], "型を推測させない").toBe("nosniff");
		expect(res.headers()["x-frame-options"], "他所の画面に埋め込ませない").toBe("SAMEORIGIN");
		expect(res.headers()["cache-control"]).toBe("no-store");

		// 中身は消さずそのまま返す(見せるための文字なので、勝手に削らない)
		expect(await res.text()).toContain("<h1>見出し</h1>");
	});

	// 案件全体ではなく「この章だけ渡したい」ことがある(画面でもフォルダを押すとこれになる)
	test("章を指定すると、その章から下だけが返る", async ({request}) => {
		const sub = (await (await request.post(`api/projects/${projectId}/folders`, {
			headers: rw, data: {name: "画面", parentFolderId: folderId}
		})).json()).id;
		const screenDoc = await upload(request, `screen-${Date.now()}.txt`, "画面一覧の本文");
		await request.put(`api/projects/${projectId}/documents/${screenDoc}`, {headers: rw, data: {folderId: sub}});

		const scoped = await (await request.get(`api/projects/${projectId}/manifest?folderId=${folderId}`, {headers: ro})).json();
		expect(scoped.folderName).toBe("要件");
		expect(scoped.rootDocuments.map((d) => d.documentId)).toEqual([specId]);
		expect(scoped.folders.map((f) => f.name)).toEqual(["画面"]);
		// 件数はその章から下だけ(プロジェクト直下の表紙は数えない)
		expect(scoped.documentCount).toBe(2);

		const md = await (await request.get(`api/projects/${projectId}/manifest.md?folderId=${folderId}`, {headers: ro})).text();
		expect(md).toContain("› 要件 お品書き");
		expect(md).not.toContain("cover-");

		// 無い章を指定したら404(空のお品書きを返して「資料が無い」と誤解させない)
		expect((await request.get(`api/projects/${projectId}/manifest?folderId=no-such`, {headers: ro})).status()).toBe(404);
		expect((await request.get(`api/projects/${projectId}/manifest.md?folderId=no-such`, {headers: ro})).status()).toBe(404);
	});

	// お品書きではフォルダがそのまま章の順番になる。作成順のままだと章立てを直せない
	test("フォルダを並び替えると、お品書きの章の順番が変わる", async ({request}) => {
		const names = ["あとで読む", "先に読む"];
		const ids = [];
		for (const name of names) {
			ids.push((await (await request.post(`api/projects/${projectId}/folders`, {headers: rw, data: {name}})).json()).id);
		}
		const before = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		const order = (m) => m.folders.map((f) => f.name);
		expect(order(before)).toEqual(expect.arrayContaining(names));
		expect(order(before).indexOf("あとで読む")).toBeLessThan(order(before).indexOf("先に読む"));

		const res = await request.put(`api/projects/${projectId}/folders/reorder`, {
			headers: rw, data: {parentFolderId: null, folderIds: [ids[1], ids[0]]}
		});
		expect(res.status()).toBe(200);

		const after = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		expect(order(after).indexOf("先に読む")).toBeLessThan(order(after).indexOf("あとで読む"));
	});

	test("並び替えは readwrite 以上・配列以外は400・施錠中は423", async ({request}) => {
		expect((await request.put(`api/projects/${projectId}/folders/reorder`, {headers: ro, data: {folderIds: []}})).status()).toBe(403);
		expect((await request.put(`api/projects/${projectId}/folders/reorder`, {headers: rw, data: {folderIds: "x"}})).status()).toBe(400);

		await request.post(`api/projects/${projectId}/lock`, {headers: rw});
		expect((await request.put(`api/projects/${projectId}/folders/reorder`, {headers: rw, data: {folderIds: []}})).status()).toBe(423);
		await request.post(`api/projects/${projectId}/unlock`, {headers: rw});
	});

	// "reorder" がフォルダIDとして拾われると、名前が "reorder" のフォルダを探しにいってしまう
	test("folders/reorder が :folderId のルートに食われていない", async ({request}) => {
		const res = await request.put(`api/projects/${projectId}/folders/reorder`, {headers: rw, data: {folderIds: []}});
		expect(res.status()).toBe(200);
		expect(await res.json()).toHaveProperty("folders");
	});

	test("空文字を送ると説明が消える", async ({request}) => {
		await request.put(`api/projects/${projectId}/documents/${coverId}/note`, {headers: rw, data: {note: "いったん書く"}});
		const cleared = await request.put(`api/projects/${projectId}/documents/${coverId}/note`, {headers: rw, data: {note: "   "}});
		expect(cleared.status()).toBe(200);
		expect((await cleared.json()).note).toBeNull();
	});

	test("長すぎる説明は切り詰める(ツリー取得の応答が膨らまないように)", async ({request}) => {
		const res = await request.put(`api/projects/${projectId}/documents/${coverId}/note`, {
			headers: rw, data: {note: "あ".repeat(2000)}
		});
		expect(res.status()).toBe(200);
		expect((await res.json()).note.length).toBe(500);
	});

	test("そのプロジェクトに登録されていない資料には書けない", async ({request}) => {
		const strayId = await upload(request, `stray-${Date.now()}.txt`, "どこにも登録しない");
		const res = await request.put(`api/projects/${projectId}/documents/${strayId}/note`, {headers: rw, data: {note: "x"}});
		expect(res.status()).toBe(404);
	});

	test("readonlyキーでは書けないが、読める", async ({request}) => {
		expect((await request.put(`api/projects/${projectId}/documents/${specId}/note`, {headers: ro, data: {note: "x"}})).status()).toBe(403);
		expect((await request.put(`api/projects/${projectId}/folders/${folderId}/note`, {headers: ro, data: {note: "x"}})).status()).toBe(403);
		expect((await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).status()).toBe(200);
		expect((await request.get(`api/projects/${projectId}/manifest.md`, {headers: ro})).status()).toBe(200);
	});

	test("未認証では読めない", async ({request}) => {
		expect((await request.get(`api/projects/${projectId}/manifest`)).status()).toBe(401);
		expect((await request.get(`api/projects/${projectId}/manifest.md`)).status()).toBe(401);
	});

	test("施錠中は説明を書き換えられない", async ({request}) => {
		expect((await request.post(`api/projects/${projectId}/lock`, {headers: rw})).ok()).toBe(true);
		const res = await request.put(`api/projects/${projectId}/documents/${specId}/note`, {headers: rw, data: {note: "施錠中"}});
		expect(res.status()).toBe(423);
		const folderRes = await request.put(`api/projects/${projectId}/folders/${folderId}/note`, {headers: rw, data: {note: "施錠中"}});
		expect(folderRes.status()).toBe(423);

		// 読む方は施錠中でもできる
		expect((await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).status()).toBe(200);
		expect((await request.post(`api/projects/${projectId}/unlock`, {headers: rw})).ok()).toBe(true);
	});

	test("存在しないプロジェクトは404", async ({request}) => {
		expect((await request.get("api/projects/no-such-project/manifest", {headers: ro})).status()).toBe(404);
		expect((await request.get("api/projects/no-such-project/manifest.md", {headers: ro})).status()).toBe(404);
	});

	test("プロジェクトから外すと、説明書きも一緒に消える", async ({request}) => {
		await request.put(`api/projects/${projectId}/documents/${specId}/note`, {headers: rw, data: {note: "外す前の説明"}});
		expect((await request.delete(`api/projects/${projectId}/documents/${specId}`, {headers: rw})).ok()).toBe(true);

		// 入れ直しても、前の説明が残っていてはいけない
		await request.put(`api/projects/${projectId}/documents/${specId}`, {headers: rw, data: {folderId: null}});
		const manifest = await (await request.get(`api/projects/${projectId}/manifest`, {headers: ro})).json();
		const back = manifest.rootDocuments.find((d) => d.documentId === specId);
		expect(back.note, "外した時点で説明も消えている").toBeNull();
	});
});
