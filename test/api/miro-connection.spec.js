/*!
 * miro-connection.spec.js : Miro 連携(管理者が連携し、貼り先のボードを決める)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro には代わりのサーバー(miro-stub.js)を使う。ここで確かめるのはアプリ側の振る舞い:
 *   - 許可の画面とのやりとり(送り出した本人だけが連携できる)
 *   - トークンを応答に出さない・暗号化して持つ
 *   - 期限が来たら更新する(更新用トークンは使うたびに入れ替わる)・切れたら知らせる
 *   - 貼り先のボードは、連携しているチームのものだけ
 *   - 管理者だけが触れる
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${keys.sessionCookie}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const STUB_URL = `http://127.0.0.1:${process.env.MIRO_STUB_PORT || Number(process.env.CONVERTER_STUB_PORT || 18096) + 20}`;
const control = async (request, body) => (await request.post(`${STUB_URL}/__control`, {data: body})).json();
const stubState = async (request) => (await request.get(`${STUB_URL}/__state`)).json();
const stubRequests = async (request) => (await request.get(`${STUB_URL}/__requests`)).json();
const {CLIENT_ID, CLIENT_SECRET} = require("./miro-stub.js");
const saveCredentials = (request, clientId = CLIENT_ID, clientSecret = CLIENT_SECRET) =>
	request.put("api/miro/credentials", {headers: admin, data: {clientId, clientSecret}});

/**
 * 管理者として連携する(許可の画面 → 戻り先 → 画面へ戻る、を手でたどる)。
 * 途中のリダイレクトを1つずつ追い、セッションの cookie を保ったまま戻り先を開く
 */
const connect = async (request) => {
	const start = await request.get("api/miro/connect", {headers: admin, maxRedirects: 0});
	expect(start.status()).toBe(302);
	const authorize = start.headers().location;
	const back = await request.get(authorize, {maxRedirects: 0});
	expect(back.status()).toBe(302);
	const callback = await request.get(back.headers().location, {headers: admin, maxRedirects: 0});
	expect(callback.status()).toBe(302);
	return {authorize, callbackLocation: callback.headers().location};
};

// アプリの値(クライアントID・シークレット)は、環境変数が無ければ管理画面で入れる
test.describe.serial("Miro のアプリの値(管理画面で入力する場合)", () => {
	test.beforeEach(async ({request}) => {
		await request.delete("api/miro/credentials", {headers: admin});
	});
	test.afterAll(async ({request}) => {
		await saveCredentials(request);
	});

	test("未設定のうちは、使えないことと、Miro のアプリに登録する戻り先が分かる", async ({request}) => {
		const status = await (await request.get("api/miro/status", {headers: admin})).json();
		expect(status).toMatchObject({configured: false, connected: false, credentials: {source: null, editable: true}});
		expect(status.redirectUri).toBe(`${BASE_URL.replace(/\/+$/, "")}/api/miro/callback`);
		expect((await (await request.get("api/check_access_token", {headers: admin})).json()).miroEnabled).toBe(false);
		// 連携やボードの操作はまだできない
		expect((await request.get("api/miro/connect", {headers: admin, maxRedirects: 0})).status()).toBe(404);
		expect((await request.get("api/miro/boards", {headers: admin})).status()).toBe(404);
	});

	test("保存すると使えるようになる。シークレットは応答に出さず、暗号化して保存する", async ({request}) => {
		const res = await saveCredentials(request);
		expect(res.status()).toBe(200);
		const text = await res.text();
		expect(text, "シークレットが応答に出ている").not.toContain(CLIENT_SECRET);
		expect(JSON.parse(text)).toMatchObject({configured: true, credentials: {source: "settings", clientId: CLIENT_ID, editable: true}});
		expect((await (await request.get("api/check_access_token", {headers: admin})).json()).miroEnabled).toBe(true);

		const path = require("node:path");
		const Database = require("../../app/node_modules/better-sqlite3");
		const {TEST_DATA_DIR} = require("./config.js");
		const db = new Database(path.join(TEST_DATA_DIR, "db", "document_manager_v21.sqlite"), {readonly: true});
		try {
			const row = db.prepare("SELECT value FROM app_settings WHERE key = 'miro.client_secret'").get();
			expect(row.value).toMatch(/^v1:/);
			expect(row.value).not.toContain(CLIENT_SECRET);
		} finally {
			db.close();
		}
	});

	test("形の違う値は保存しない(貼り損ねの空白・引用符など)", async ({request}) => {
		for (const [clientId, clientSecret] of [["abc", CLIENT_SECRET], [CLIENT_ID, "short"], [CLIENT_ID, `"${CLIENT_SECRET} x"`], ["", ""]]) {
			const res = await saveCredentials(request, clientId, clientSecret);
			expect(res.status(), `${clientId} / ${clientSecret}`).toBe(400);
		}
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).configured).toBe(false);
	});

	test("シークレットだけの入れ替えなら連携はそのまま。クライアントIDが変わったら、連携は別のアプリのものなので消す", async ({request}) => {
		await saveCredentials(request);
		await connect(request);
		await saveCredentials(request, CLIENT_ID, "rotated-secret-0123456789");
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).connected).toBe(true);
		await saveCredentials(request, "3458764600000000777", CLIENT_SECRET);
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).connected).toBe(false);
	});

	test("値を消すと連携も解除され、使えなくなる", async ({request}) => {
		await saveCredentials(request);
		await connect(request);
		expect((await request.delete("api/miro/credentials", {headers: admin})).status()).toBe(204);
		const status = await (await request.get("api/miro/status", {headers: admin})).json();
		expect(status).toMatchObject({configured: false, connected: false});
	});

	test("管理者以外は保存できない", async ({request}) => {
		expect((await request.put("api/miro/credentials", {headers: rw, data: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET}})).status()).toBe(403);
		expect((await request.delete("api/miro/credentials", {headers: rw})).status()).toBe(403);
	});
});

test.describe.serial("Miro 連携(管理者)", () => {
	test.beforeAll(async ({request}) => {
		await saveCredentials(request);
	});
	test.beforeEach(async ({request}) => {
		// 前のテストの連携を解除してから、Miro の代わりの記録を消す(逆にすると解除の取り消しが数に残る)
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
	});
	test.afterAll(async ({request}) => {
		await request.delete("api/miro/connection", {headers: admin});
		await control(request, {reset: true});
	});

	test("使える環境であることが、ログイン時の応答で分かる", async ({request}) => {
		const res = await request.get("api/check_access_token", {headers: admin});
		expect((await res.json()).miroEnabled).toBe(true);
	});

	test("連携する前の状態と、Miro のアプリに登録する戻り先が分かる", async ({request}) => {
		const status = await (await request.get("api/miro/status", {headers: admin})).json();
		expect(status).toMatchObject({configured: true, connected: false, credentials: {source: "settings"}});
		expect(status.redirectUri).toBe(`${BASE_URL.replace(/\/+$/, "")}/api/miro/callback`);
	});

	test("許可の画面を通ると連携でき、チームと Miro の利用者名が分かる。トークンは応答に出さない", async ({request}) => {
		const {authorize, callbackLocation} = await connect(request);
		// 許可の画面へは、アプリのID・戻り先・署名つきの state を渡す(シークレットは渡さない)
		const url = new URL(authorize);
		expect(url.pathname).toBe("/oauth/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("state")).toBeTruthy();
		expect(authorize).not.toContain("stub-client-secret");
		expect(callbackLocation).toContain("miro=connected");

		const res = await request.get("api/miro/status", {headers: admin});
		const text = await res.text();
		const status = JSON.parse(text);
		expect(status).toMatchObject({connected: true, usable: true, team: {name: "Dev team"}, miroUser: {name: "Stub User"}, board: null});
		expect(status.scopes).toEqual(["boards:read", "boards:write"]);
		expect(status.connectedBy).toBeTruthy();
		expect(text, "トークンが応答に出ている").not.toContain("stub-access-");
		expect(text).not.toContain("stub-refresh-");
	});

	// データベースのファイルや退避(バックアップ)が漏れても、トークンがそのまま読めないこと
	test("トークンはデータベースに暗号化して持つ", async ({request}) => {
		await connect(request);
		const path = require("node:path");
		const Database = require("../../app/node_modules/better-sqlite3");
		const {TEST_DATA_DIR} = require("./config.js");
		const db = new Database(path.join(TEST_DATA_DIR, "db", "document_manager_v21.sqlite"), {readonly: true});
		try {
			const row = db.prepare("SELECT access_token, refresh_token FROM miro_connection WHERE id = 1").get();
			expect(row.access_token).toMatch(/^v1:/);
			expect(row.refresh_token).toMatch(/^v1:/);
			expect(row.access_token).not.toContain("stub-access-");
			expect(row.refresh_token).not.toContain("stub-refresh-");
		} finally {
			db.close();
		}
	});

	// 戻り先の URL を、別の人(または攻撃者)が作って踏ませても連携されないこと
	test("送り出していない戻り(state の不一致・改ざん)では連携しない", async ({request}) => {
		const start = await request.get("api/miro/connect", {headers: admin, maxRedirects: 0});
		const back = await request.get(start.headers().location, {maxRedirects: 0});
		const location = new URL(back.headers().location);
		location.searchParams.set("state", "forged.state");
		const callback = await request.get(location.toString(), {headers: admin, maxRedirects: 0});
		expect(callback.headers().location).toContain("miro=error");
		expect(callback.headers().location).toContain("reason=state");
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).connected).toBe(false);
	});

	test("Miro で「許可しない」を選んだら、連携せずに画面へ戻る", async ({request}) => {
		await control(request, {deny: true});
		const {callbackLocation} = await connect(request);
		expect(callbackLocation).toContain("reason=denied");
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).connected).toBe(false);
	});

	test("貼り先の候補は、連携しているチームのボードだけ。名前で絞れる", async ({request}) => {
		await connect(request);
		const all = (await (await request.get("api/miro/boards", {headers: admin})).json()).boards;
		expect(all.map((b) => b.name)).toEqual(["Document Manager 連携テスト", "企画ブレスト"]);
		const filtered = (await (await request.get(`api/miro/boards?q=${encodeURIComponent("ブレスト")}`, {headers: admin})).json()).boards;
		expect(filtered.map((b) => b.name)).toEqual(["企画ブレスト"]);
	});

	test("貼り先のボードを決められる。別のチームのボードや、無いボードは選べない", async ({request}) => {
		await connect(request);
		const ok = await request.put("api/miro/settings", {headers: admin, data: {boardId: "uXjVStubBoard1="}});
		expect(ok.status()).toBe(200);
		expect((await ok.json()).board).toMatchObject({id: "uXjVStubBoard1=", name: "Document Manager 連携テスト"});

		const other = await request.put("api/miro/settings", {headers: admin, data: {boardId: "uXjVOtherTeam="}});
		expect(other.status()).toBe(400);
		const missing = await request.put("api/miro/settings", {headers: admin, data: {boardId: "uXjVNothing="}});
		expect(missing.status()).toBe(404);
		const invalid = await request.put("api/miro/settings", {headers: admin, data: {boardId: "../../etc"}});
		expect(invalid.status()).toBe(400);
		// 失敗しても、決めてあったボードはそのまま
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).board.id).toBe("uXjVStubBoard1=");
	});

	test("連携し直しても、同じチームなら決めてあったボードを引き継ぐ", async ({request}) => {
		await connect(request);
		await request.put("api/miro/settings", {headers: admin, data: {boardId: "uXjVStubBoard2="}});
		await connect(request);
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).board.id).toBe("uXjVStubBoard2=");
	});

	test("アクセストークンの期限が近ければ、使う前に更新する(更新用トークンも入れ替わる)", async ({request}) => {
		// 発行するトークンの寿命を、更新の目安(5分)より短くしておく
		await control(request, {accessTtlSeconds: 60});
		await connect(request);
		const before = await stubState(request);
		expect((await request.get("api/miro/boards", {headers: admin})).status()).toBe(200);
		const after = await stubState(request);
		expect(after.issued, "更新していない").toBe(before.issued + 1);
		// 古い更新用トークンは無効になり、新しいものだけが残る(入れ替えを保存できている)
		expect(after.validRefreshTokens).toBe(1);
		const refreshes = (await stubRequests(request)).filter((r) => r.path === "/v1/oauth/token" && r.query.grant_type === "refresh_token");
		expect(refreshes).toHaveLength(1);
		// もう一度使っても、寿命が短いのでまた更新する(保存した新しい更新用トークンで更新できる)
		expect((await request.get("api/miro/boards", {headers: admin})).status()).toBe(200);
	});

	test("期限の前に無効になっていた(401)ときは、1回だけ更新してやり直す", async ({request}) => {
		await connect(request);
		await control(request, {expireAccess: true});
		expect((await request.get("api/miro/boards", {headers: admin})).status()).toBe(200);
	});

	test("更新できない(取り消された・期限切れ)ときは、連携し直すよう知らせる", async ({request}) => {
		await connect(request);
		await control(request, {expireAccess: true, refreshFails: true});
		const res = await request.get("api/miro/boards", {headers: admin});
		expect(res.status()).toBe(409);
		expect(await res.json()).toMatchObject({needsReconnect: true});
		const status = await (await request.get("api/miro/status", {headers: admin})).json();
		expect(status.usable).toBe(false);
		expect(status.lastError).toContain("連携し直して");
		// 連携し直せば直る
		await control(request, {refreshFails: false});
		await connect(request);
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).usable).toBe(true);
	});

	test("連携を解除すると、Miro 側のトークンも取り消す", async ({request}) => {
		await connect(request);
		const res = await request.delete("api/miro/connection", {headers: admin});
		expect(res.status()).toBe(204);
		expect((await stubState(request)).revoked).toBe(1);
		expect((await (await request.get("api/miro/status", {headers: admin})).json()).connected).toBe(false);
	});

	test("管理者以外(APIキーを含む)は触れない", async ({request}) => {
		for (const [method, path] of [["get", "api/miro/status"], ["get", "api/miro/boards"], ["get", "api/miro/connect"], ["delete", "api/miro/connection"]]) {
			const res = await request[method](path, {headers: rw, maxRedirects: 0});
			expect(res.status(), `${method} ${path}`).toBe(403);
		}
		const put = await request.put("api/miro/settings", {headers: rw, data: {boardId: "uXjVStubBoard1="}});
		expect(put.status()).toBe(403);
	});

	test("ログインしていなければ触れない", async ({playwright}) => {
		const anonymous = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		try {
			expect((await anonymous.get("api/miro/status")).status()).toBe(401);
			expect((await anonymous.get("api/miro/callback?code=x&state=y", {maxRedirects: 0})).status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});
});
