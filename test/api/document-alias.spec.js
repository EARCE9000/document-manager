/*!
 * document-alias.spec.js : 版をまたいで変わらない共有用のID(Alias)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 文書は更新のたびに新しいIDになる(その仕様は変えない)。そのままだと人に配ったリンクが
 * 古い版を指したままになり、受け取った側は「どれが最新か」を判断できない。
 * Aliasは**いまの版を指す、差し替え可能な矢印**である。
 *
 * いちばん確かめたいのは「**配ったリンクが更新後も最新を指す**」こと。ここが崩れると、
 * 見た目は正常なまま古い版が配られ続ける(リンクは開けるので、誰も気づかない)。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const STAMP = Date.now();

const upload = async (request, name, body, previousId) => {
	const multipart = {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(body, "utf-8")}};
	if (previousId) multipart.previousId = previousId;
	const res = await request.post("api/documents", {headers: rw, multipart});
	expect(res.status()).toBe(200);
	return res.json();
};

test.describe.serial("共有用のAlias", () => {
	test("登録すると自動で付き、応答に入る", async ({request}) => {
		const doc = await upload(request, `Alias基本${STAMP}.txt`, "v1の本文");
		expect(doc.alias, "Aliasが付いていない").toBeTruthy();
		expect(doc.alias).toMatch(/^[0-9a-f]{12}$/);
	});

	// この機能の目的そのもの
	test("新しい版を上げても、同じAliasが最新を指す", async ({request}) => {
		const v1 = await upload(request, `引き継ぎ${STAMP}.txt`, "v1の本文");
		const alias = v1.alias;

		const v2 = await upload(request, `引き継ぎ${STAMP}.txt`, "v2の本文", v1.id);
		expect(v2.id).not.toBe(v1.id);
		expect(v2.alias, "新しい版にAliasが引き継がれていない").toBe(alias);

		// 配ったリンク(Alias)は、最新を指している
		const resolved = await (await request.get(`api/documents/alias/${alias}`, {headers: ro})).json();
		expect(resolved.id, "配ったリンクが古い版を指したままになっている").toBe(v2.id);

		// 旧版からはAliasが外れている(矢印は1本)
		const oldDoc = await (await request.get(`api/documents/${v1.id}`, {headers: ro})).json();
		expect(oldDoc.alias, "旧版にもAliasが残っている(矢印が2本になる)").toBeNull();
	});

	test("3世代でも最新を指し続ける", async ({request}) => {
		const v1 = await upload(request, `三世代${STAMP}.txt`, "v1");
		const v2 = await upload(request, `三世代${STAMP}.txt`, "v2", v1.id);
		const v3 = await upload(request, `三世代${STAMP}.txt`, "v3", v2.id);
		expect(v3.alias).toBe(v1.alias);

		const resolved = await (await request.get(`api/documents/alias/${v1.alias}`, {headers: ro})).json();
		expect(resolved.id).toBe(v3.id);
	});

	test("Aliasのリンクは、いまの版のプレビューへ転送される", async ({request}) => {
		const v1 = await upload(request, `転送${STAMP}.txt`, "v1");
		const v2 = await upload(request, `転送${STAMP}.txt`, "v2", v1.id);

		const res = await request.get(`api/documents/alias/${v1.alias}/viewer`, {
			headers: {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`}, maxRedirects: 0
		});
		expect([301, 302, 307]).toContain(res.status());
		expect(res.headers()["location"], "最新の版へ転送していない").toContain(v2.id);
	});

	// 転送をブラウザに覚えられると、同じURLを開き直しても古い版へ行き続ける。
	// 配ったリンクが最新を指す、というこの仕組みの目的が丸ごと壊れる(実際にそうなった)
	test("Aliasの転送は、ブラウザに覚えさせない", async ({request}) => {
		const v1 = await upload(request, `覚えさせない${STAMP}.txt`, "v1");
		const res = await request.get(`api/documents/alias/${v1.alias}/viewer`, {
			headers: {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`}, maxRedirects: 0
		});
		expect([301, 302, 307]).toContain(res.status());
		expect(res.headers()["cache-control"], "転送が保存され、古い版を開き続ける").toContain("no-store");
	});

	// 開き直したら最新になる、が成り立っていること。
	// 転送先そのものを見る(転送を追うと、その先の中身は版のURLの話になってしまう)
	test("同じURLを開き直すと、転送先が新しい版に変わる", async ({request}) => {
		const session = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
		const v1 = await upload(request, `開き直し${STAMP}.txt`, "v1の本文");
		const url = `api/documents/alias/${v1.alias}/viewer`;

		const before = await request.get(url, {headers: session, maxRedirects: 0});
		expect(before.headers()["location"]).toContain(v1.id);

		const v2 = await upload(request, `開き直し${STAMP}.txt`, "v2の本文", v1.id);
		const after = await request.get(url, {headers: session, maxRedirects: 0});
		expect(after.headers()["location"], "開き直しても古い版へ送られる").toContain(v2.id);
		expect(after.headers()["location"]).not.toContain(v1.id);

		// 送られた先が、実際に新しい中身であること
		expect(await (await request.get(`api/documents/${v2.id}/file`, {headers: ro})).text()).toBe("v2の本文");
	});

	// 「この版を見てほしい」と明示したいときのために、版のURLは従来どおり生きている
	test("版のリンクは、更新後もその版を指したまま", async ({request}) => {
		const v1 = await upload(request, `版指定${STAMP}.txt`, "v1の本文");
		await upload(request, `版指定${STAMP}.txt`, "v2の本文", v1.id);

		const res = await request.get(`api/documents/${v1.id}/file`, {headers: ro});
		expect(res.status()).toBe(200);
		expect(await res.text(), "版のリンクまで最新に動いてしまっている").toBe("v1の本文");
	});

	// 新しい版が間違いだった、というのは起こる
	test("古い版へ付け直せる", async ({request}) => {
		const v1 = await upload(request, `つけなおし${STAMP}.txt`, "v1の本文");
		const v2 = await upload(request, `つけなおし${STAMP}.txt`, "v2の本文", v1.id);
		const alias = v1.alias;

		const moved = await request.put(`api/documents/alias/${alias}`, {headers: rw, data: {documentId: v1.id}});
		expect(moved.status()).toBe(200);
		expect((await moved.json()).documentId).toBe(v1.id);

		const resolved = await (await request.get(`api/documents/alias/${alias}`, {headers: ro})).json();
		expect(resolved.id, "古い版へ戻っていない").toBe(v1.id);

		// 矢印が外れた側にはAliasが無い(版のURLは生きている)
		const newer = await (await request.get(`api/documents/${v2.id}`, {headers: ro})).json();
		expect(newer.alias).toBeNull();
		expect((await request.get(`api/documents/${v2.id}/file`, {headers: ro})).status()).toBe(200);
	});

	test("矢印が外れた文書へ、新しく発行できる", async ({request}) => {
		const v1 = await upload(request, `再発行${STAMP}.txt`, "v1");
		const v2 = await upload(request, `再発行${STAMP}.txt`, "v2", v1.id);
		await request.put(`api/documents/alias/${v1.alias}`, {headers: rw, data: {documentId: v1.id}});

		const created = await request.post(`api/documents/${v2.id}/alias`, {headers: rw});
		expect(created.status()).toBe(200);
		const body = await created.json();
		expect(body.alias).toMatch(/^[0-9a-f]{12}$/);
		expect(body.alias).not.toBe(v1.alias);
		expect(body.documentId).toBe(v2.id);
	});

	// 2本目ができると、共有リンクをコピーするときにどちらを出すか決められない
	test("既にAliasのある文書へ向けようとすると断る", async ({request}) => {
		const a = await upload(request, `衝突A${STAMP}.txt`, "A");
		const b = await upload(request, `衝突B${STAMP}.txt`, "B");
		const res = await request.put(`api/documents/alias/${a.alias}`, {headers: rw, data: {documentId: b.id}});
		expect(res.status()).toBe(409);

		// 断ったので、どちらも元のまま
		expect((await (await request.get(`api/documents/alias/${a.alias}`, {headers: ro})).json()).id).toBe(a.id);
		expect((await (await request.get(`api/documents/alias/${b.alias}`, {headers: ro})).json()).id).toBe(b.id);
	});

	test("後から版として紐づけても引き継がれる", async ({request}) => {
		const older = await upload(request, `後追い旧${STAMP}.txt`, "旧");
		const newer = await upload(request, `後追い新${STAMP}.txt`, "新");
		const aliasOfOlder = older.alias;

		const linked = await request.put(`api/documents/${newer.id}/previous`, {headers: rw, data: {previousId: older.id}});
		expect(linked.status()).toBe(200);

		// 旧版に付いていたAliasは畳まれ、新版のAliasが残る(矢印は1本)
		const resolvedOld = await request.get(`api/documents/alias/${aliasOfOlder}`, {headers: ro});
		expect(resolvedOld.status()).toBe(404);
		const resolvedNew = await (await request.get(`api/documents/alias/${newer.alias}`, {headers: ro})).json();
		expect(resolvedNew.id).toBe(newer.id);
	});

	test("無いAliasは404、形が違うものも404", async ({request}) => {
		for (const alias of ["000000000000", "../../etc/passwd", "short", "ZZZZZZZZZZZZ"]) {
			const res = await request.get(`api/documents/alias/${encodeURIComponent(alias)}`, {headers: ro});
			expect(res.status(), `${alias} で404以外が返った`).toBe(404);
		}
	});

	test("指す先を変えられるのは admin/readwrite だけ", async ({request}) => {
		const doc = await upload(request, `権限${STAMP}.txt`, "本文");
		expect((await request.put(`api/documents/alias/${doc.alias}`, {headers: ro, data: {documentId: doc.id}})).status()).toBe(403);
		expect((await request.post(`api/documents/${doc.id}/alias`, {headers: ro})).status()).toBe(403);
		// 読むのは readonly でもできる
		expect((await request.get(`api/documents/alias/${doc.alias}`, {headers: ro})).status()).toBe(200);
	});

	// 人に渡すURLの作り方が、ここで決まる
	test("AI向けガイドに、人へ渡すのはAliasだと書いてある", async ({request}) => {
		const guide = await (await request.get("api/usage.md", {headers: ro})).text();
		expect(guide).toContain("Alias");
		expect(guide).toContain("/api/documents/alias/");
	});
});
