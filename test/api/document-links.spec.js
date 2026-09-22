/*!
 * document-links.spec.js : 関連文書(種類・方向を持たない紐付け)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 紐づけ(冪等)・双方向の参照・解除・異常系(自分自身/存在しないID/権限)を検証する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};

const upload = async (request, name) => (await (await request.post("api/documents", {
	headers: rw,
	multipart: {uploadfile: {name, mimeType: "text/plain", buffer: Buffer.from(name)}}
})).json());

const links = async (request, id, headers = rw) => (await request.get(`api/documents/${id}/links`, {headers})).json();

test.describe.serial("関連文書", () => {
	let estimate;
	let contract;
	let minutes;

	test.beforeAll(async ({request}) => {
		estimate = await upload(request, "関連_見積書.txt");
		contract = await upload(request, "関連_契約書.txt");
		minutes = await upload(request, "関連_議事録.txt");
	});

	test("紐付けが無いうちは空", async ({request}) => {
		expect(await links(request, estimate.id)).toEqual([]);
	});

	test("紐づけるとどちらから引いても相手が返る", async ({request}) => {
		const res = await request.put(`api/documents/${estimate.id}/links/${contract.id}`, {headers: rw});
		expect(res.status()).toBe(200);
		expect((await res.json()).map((d) => d.id)).toEqual([contract.id]);

		expect((await links(request, contract.id)).map((d) => d.id)).toEqual([estimate.id]);
		const fromContract = (await links(request, contract.id))[0];
		expect(fromContract.entryFile).toBe("関連_見積書.txt");
		expect(fromContract.archived).toBe(false);
		expect(fromContract.linkedBy).toBeTruthy();
	});

	test("同じ組み合わせを何度紐づけても増えない(順序が逆でも同じ関係)", async ({request}) => {
		await request.put(`api/documents/${estimate.id}/links/${contract.id}`, {headers: rw});
		await request.put(`api/documents/${contract.id}/links/${estimate.id}`, {headers: rw});
		expect((await links(request, estimate.id)).length).toBe(1);
	});

	test("1つの文書に複数の関連を持てる", async ({request}) => {
		await request.put(`api/documents/${estimate.id}/links/${minutes.id}`, {headers: rw});
		expect((await links(request, estimate.id)).map((d) => d.id).sort()).toEqual([contract.id, minutes.id].sort());
		// 関連は推移しない(契約書から見えるのは見積書だけ)
		expect((await links(request, contract.id)).map((d) => d.id)).toEqual([estimate.id]);
	});

	test("アーカイブしても関連は残り、archivedで判別できる", async ({request}) => {
		expect((await request.delete(`api/documents/${minutes.id}`, {headers: rw})).status()).toBe(204);
		const archivedLink = (await links(request, estimate.id)).find((d) => d.id === minutes.id);
		expect(archivedLink.archived).toBe(true);
		await request.post(`api/documents/${minutes.id}/restore`, {headers: rw});
	});

	test("readonlyキーは参照できるが変更はできない", async ({request}) => {
		expect((await request.get(`api/documents/${estimate.id}/links`, {headers: ro})).status()).toBe(200);
		expect((await request.put(`api/documents/${estimate.id}/links/${contract.id}`, {headers: ro})).status()).toBe(403);
		expect((await request.delete(`api/documents/${estimate.id}/links/${contract.id}`, {headers: ro})).status()).toBe(403);
	});

	test("自分自身は400、存在しない文書は404", async ({request}) => {
		expect((await request.put(`api/documents/${estimate.id}/links/${estimate.id}`, {headers: rw})).status()).toBe(400);
		expect((await request.put(`api/documents/${estimate.id}/links/no-such-id`, {headers: rw})).status()).toBe(404);
		expect((await request.put(`api/documents/no-such-id/links/${estimate.id}`, {headers: rw})).status()).toBe(404);
		expect((await request.get("api/documents/no-such-id/links", {headers: rw})).status()).toBe(404);
	});

	test("解除すると双方から消え、紐付けの無い解除は404", async ({request}) => {
		const res = await request.delete(`api/documents/${contract.id}/links/${estimate.id}`, {headers: rw});
		expect(res.status()).toBe(200);
		expect((await res.json())).toEqual([]);
		expect((await links(request, estimate.id)).map((d) => d.id)).toEqual([minutes.id]);
		expect((await request.delete(`api/documents/${contract.id}/links/${estimate.id}`, {headers: rw})).status()).toBe(404);
	});
});
