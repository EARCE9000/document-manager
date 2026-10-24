/*!
 * admin-api.spec.js : 管理の WebAPI(共通アーキテクチャ 構成 6.2・6.3・6.4)の形
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 管理の画面は、どのサービスでも同じ形の WebAPI から、デザインテンプレートの admin.js が描く。
 * 名前や形がずれると、画面のその節だけが黙って空になる。ここで、共通の形のとおりに返すことを確かめる。
 *
 *   サーバー  GET api/server-status(rateLimit・features・security・extra)/ components(latencyMs・lastSuccessAt)
 *             PUT api/server-status/rate-limit / PUT api/server-status/features/{key}
 *   利用者    GET/POST api/admin/users、PUT/DELETE api/admin/users/{email}
 *   セッション GET api/admin/sessions、GET api/admin/sessions/history(切断は session-revoke.spec.js)
 *   監査ログ  GET api/admin/audit
 *
 * 管理者が 1 人だけの台帳(最後の管理者を守る決まり)と、100 件を超えたときの続きは、test/admin-api.test.js で確かめる。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const admin = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(keys.sessionCookie)}`};
const rw = {Authorization: `Bearer ${keys.readwrite}`};

// 呼ぶ人ごとに入れ物を分ける(Set-Cookie を覚えて、別の人の呼び出しに乗せないように)
const contexts = new Map();
let playwrightRequest = null;
const as = async (headers) => {
	const key = JSON.stringify(headers);
	if (!contexts.has(key)) contexts.set(key, await playwrightRequest.newContext({baseURL: `${BASE_URL}/`, extraHTTPHeaders: headers}));
	return contexts.get(key);
};
test.beforeAll(({playwright}) => {
	playwrightRequest = playwright.request;
});
test.afterAll(async () => {
	for (const context of contexts.values()) await context.dispose();
});

const audit = async (query) => {
	const res = await (await as(admin)).get(`api/admin/audit?${new URLSearchParams(query)}`);
	expect(res.status()).toBe(200);
	return res.json();
};

test.describe("サーバー(共通の形)", () => {
	test("check_access_token: 開発モードかを返す(画面はこれを見て「開発モード」を出す)", async () => {
		const body = await (await (await as(admin)).get("api/check_access_token")).json();
		expect(body.authDisabled).toBe(false);
	});

	test("server-status: 回数の上限・機能の On/Off・セキュリティ設定・足した項目を返す", async () => {
		const res = await (await as(admin)).get("api/server-status");
		expect(res.status()).toBe(200);
		const body = await res.json();

		expect(body.rateLimit.windowMinutes).toBe(5);
		expect(body.rateLimit.disabled).toBe(true); // 試験の間は切っている(serve.js)
		for (const kind of ["authenticated", "anonymous"]) {
			const item = body.rateLimit[kind];
			expect(Object.keys(item).sort()).toEqual(["env", "limit", "max", "min", "source", "updatedAt", "updatedBy"]);
			expect(["setting", "env", "default"]).toContain(item.source);
			expect(item.env).toMatch(/^RATE_LIMIT_/);
		}

		const features = Object.fromEntries(body.features.map((feature) => [feature.key, feature]));
		expect(features.mockups).toMatchObject({name: "モックアップ", editable: true});
		expect(features.vector_search.editable).toBe(false);
		for (const feature of body.features) expect(typeof feature.enabled).toBe("boolean");

		const security = Object.fromEntries(body.security.map((row) => [row.label, row]));
		expect(security["認証の方式"].state).toBe("ok");
		expect(security["API の回数の上限"].state).toBe("bad"); // 切っているので、赤く出る
		expect(security["APIキーの最長の期限"].value).toBe("365 日");
		expect(security["無期限の APIキー"]).toMatchObject({value: "0 件", state: "ok"});
		for (const row of body.security) {
			expect(typeof row.label).toBe("string");
			expect(typeof row.value).toBe("string");
		}

		expect(body.extra.map((item) => item.label)).toContain("同梱クライアントの版");
		// 出さない物: パスや接続文字列
		expect(JSON.stringify(body)).not.toMatch(/dm-api-test|postgres:\/\//);
	});

	test("server-status: 取り扱っている文書(アーカイブを含む)・大きさ・プロジェクトの数を「このサーバー」に出す", async () => {
		const counts = async () => {
			const extra = (await (await (await as(admin)).get("api/server-status")).json()).extra;
			const value = (label) => extra.find((item) => item.label === label)?.value;
			const match = /^現役 (\d+) 件・アーカイブ (\d+) 件\(合計 (\d+) 件\)$/.exec(value("文書"));
			expect(match, `文書の数の形: ${value("文書")}`).not.toBeNull();
			const [active, archived, total] = match.slice(1).map(Number);
			expect(active + archived).toBe(total);
			expect(value("文書の大きさの合計(登録したファイル)")).toMatch(/^[\d.]+ (B|KB|MB|GB|TB)$/);
			expect(value("プロジェクト")).toMatch(/^現役 \d+ 件・アーカイブ \d+ 件\(合計 \d+ 件\)$/);
			return {active, archived, total};
		};
		const before = await counts();
		const upload = await (await as(rw)).post("api/documents", {
			multipart: {uploadfile: {name: "admin-count.md", mimeType: "text/markdown", buffer: Buffer.from("# 数える試験\n")}}
		});
		expect(upload.status()).toBe(200);
		const after = await counts();
		expect(after).toEqual({active: before.active + 1, archived: before.archived, total: before.total + 1});
		// アーカイブしても合計は変わらず、アーカイブの数に移る
		expect((await (await as(rw)).delete(`api/documents/${(await upload.json()).id}`)).status()).toBeLessThan(300);
		expect(await counts()).toEqual({active: before.active, archived: before.archived + 1, total: before.total + 1});
	});

	test("components: 相手ごとに、届くか・掛かった時間・最後に成功した時刻。使っていない相手は未設定", async () => {
		const res = await (await as(admin)).get("api/server-status/components");
		expect(res.status()).toBe(200);
		const {components} = await res.json();
		const byKey = Object.fromEntries(components.map((c) => [c.key, c]));
		expect(Object.keys(byKey)).toEqual(expect.arrayContaining(["app", "database", "storage", "idp", "office", "pdf", "weaviate"]));
		for (const key of ["database", "storage", "office", "pdf"]) {
			expect(byKey[key]).toMatchObject({configured: true, reachable: true});
			expect(typeof byKey[key].latencyMs).toBe("number");
			expect(Date.parse(byKey[key].lastSuccessAt)).not.toBeNaN();
		}
		// 試験は local でも S3(MinIO)でも流せる(STORAGE_BACKEND)
		const storageProducts = {local: "ローカルのディスク", s3: "Amazon S3(互換)", gcs: "Google Cloud Storage"};
		expect(byKey.storage.product).toBe(storageProducts[process.env.STORAGE_BACKEND || "local"]);
		// 試験では IdP(OIDC_ISSUER)と Weaviate を使っていない
		expect(byKey.idp.configured).toBe(false);
		expect(byKey.weaviate.configured).toBe(false);
	});

	test("PUT rate-limit: 範囲の中なら保存して新しい rateLimit を返し、外なら 400。監査ログに残る", async () => {
		const api = await as(admin);
		const before = (await (await api.get("api/server-status")).json()).rateLimit.anonymous;

		const saved = await api.put("api/server-status/rate-limit", {data: {anonymous: 1234}});
		expect(saved.status()).toBe(200);
		const rateLimit = await saved.json();
		expect(rateLimit.anonymous).toMatchObject({limit: 1234, source: "setting", updatedBy: keys.owner});
		expect(rateLimit.authenticated.limit).toBeGreaterThan(0);

		expect((await api.put("api/server-status/rate-limit", {data: {anonymous: 5}})).status()).toBe(400);
		expect((await api.put("api/server-status/rate-limit", {data: {}})).status()).toBe(400);

		const logged = await audit({action: "rate_limit", range: "1d"});
		expect(logged.entries[0]).toMatchObject({user: keys.owner, result: "success", via: "screen"});

		// 既定に戻す(共通の形の DELETE)。画面で変えた値を消して、新しい rateLimit を返す
		const reset = await api.delete("api/server-status/rate-limit/anonymous");
		expect(reset.status()).toBe(200);
		const afterReset = await reset.json();
		expect(afterReset.anonymous.source).toBe(before.source);
		expect(afterReset.anonymous).toMatchObject({limit: before.limit, updatedBy: null, updatedAt: null});
		expect(afterReset.windowMinutes).toBe(5);
		expect((await api.delete("api/server-status/rate-limit/everyone")).status()).toBe(404);
		const resetLogged = await audit({action: "rate_limit", range: "1d"});
		expect(resetLogged.entries[0].target).toContain("既定に戻す");
		expect((await (await as(rw)).delete("api/server-status/rate-limit/anonymous")).status()).toBe(403);
	});

	test("PUT features/{key}: 切り替えられる機能は切り替え、構成で決まる機能は 400、知らない機能は 404", async () => {
		const api = await as(admin);
		const original = (await (await api.get("api/server-status")).json()).features.find((f) => f.key === "mockups").enabled;

		const res = await api.put("api/server-status/features/mockups", {data: {enabled: !original}});
		expect(res.status()).toBe(200);
		expect((await res.json())).toMatchObject({key: "mockups", enabled: !original});
		expect((await api.put("api/server-status/features/mockups", {data: {enabled: "yes"}})).status()).toBe(400);
		expect((await api.put("api/server-status/features/vector_search", {data: {enabled: true}})).status()).toBe(400);
		expect((await api.put("api/server-status/features/nothing", {data: {enabled: true}})).status()).toBe(404);

		const logged = await audit({action: "feature_toggle", range: "1d"});
		expect(logged.entries[0]).toMatchObject({target: "モックアップ", result: "success"});

		await api.put("api/server-status/features/mockups", {data: {enabled: original}});
	});
});

test.describe("利用者(共通の形)", () => {
	const email = "admin-api-new@example.com";

	test("一覧は {users, roles, self}。追加・権限の変更・削除は、それぞれの決まりで断り、監査ログに残る", async () => {
		const api = await as(admin);
		const listed = await (await api.get("api/admin/users")).json();
		expect(listed.self).toBe(keys.owner);
		expect(listed.roles.map((role) => role.value)).toEqual(["admin", "readwrite", "readonly"]);
		const owner = listed.users.find((user) => user.email === keys.owner);
		expect(Object.keys(owner).sort()).toEqual(["addedAt", "addedBy", "email", "lastLoginAt", "role"]);

		// 追加: 形の違うメールアドレス・知らない権限は 400、もう居れば 409
		expect((await api.post("api/admin/users", {data: {email: "not-an-email", role: "readonly"}})).status()).toBe(400);
		expect((await api.post("api/admin/users", {data: {email, role: "owner"}})).status()).toBe(400);
		const added = await api.post("api/admin/users", {data: {email: email.toUpperCase(), role: "readonly"}});
		expect(added.status()).toBe(201);
		expect(await added.json()).toEqual({email, role: "readonly"});
		expect((await api.post("api/admin/users", {data: {email, role: "admin"}})).status()).toBe(409);

		// 権限の変更
		expect((await api.put(`api/admin/users/${encodeURIComponent(email)}`, {data: {role: "admin"}})).status()).toBe(200);
		expect((await api.put(`api/admin/users/${encodeURIComponent(email)}`, {data: {role: "boss"}})).status()).toBe(400);
		expect((await api.put("api/admin/users/nobody%40example.com", {data: {role: "readonly"}})).status()).toBe(404);
		const changed = (await (await api.get("api/admin/users")).json()).users.find((user) => user.email === email);
		expect(changed).toMatchObject({role: "admin", addedBy: keys.owner, lastLoginAt: null});

		// 削除(管理者がほかにも居るので外せる)
		const removed = await api.delete(`api/admin/users/${encodeURIComponent(email)}`);
		expect(removed.status()).toBe(200);
		expect(await removed.json()).toEqual({email, sessions: 0, apiKeys: 0});
		expect((await api.delete(`api/admin/users/${encodeURIComponent(email)}`)).status()).toBe(404);
		expect((await (await api.get("api/admin/users")).json()).users.some((user) => user.email === email)).toBe(false);

		const logged = await audit({target: email, range: "1d"});
		expect(logged.entries.map((entry) => entry.action)).toEqual(["user_remove", "user_role", "user_add"]);
		for (const entry of logged.entries) expect(entry).toMatchObject({user: keys.owner, target: email, result: "success", via: "screen"});
	});

	test("台帳から外すと、その人のセッションと APIキーも止まる", async () => {
		const api = await as(admin);
		// 外してよい利用者は serve.js が別に用意している(セッション 1 つ + APIキー)
		const target = keys.revokeTargets.removeTarget;
		const key = {Authorization: `Bearer ${target.apiKey}`};
		const session = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(target.cookies[0])}`};
		expect((await (await as(key)).get("api/documents")).status()).toBe(200);
		expect((await (await as(session)).get("api/check_access_token")).status()).toBe(200);

		const removed = await api.delete(`api/admin/users/${encodeURIComponent(target.user)}`);
		expect(removed.status()).toBe(200);
		expect(await removed.json()).toEqual({email: target.user, sessions: 1, apiKeys: 1});
		expect((await (await as(key)).get("api/documents")).status()).toBe(401);
		expect((await (await as(session)).get("api/check_access_token")).status()).toBe(401);
		// 台帳に入れ直しても、止めたキーとセッションは戻らない
		expect((await api.post("api/admin/users", {data: {email: target.user, role: "readonly"}})).status()).toBe(201);
		expect((await (await as(key)).get("api/documents")).status()).toBe(401);
		expect((await (await as(session)).get("api/check_access_token")).status()).toBe(401);
		// 切断の履歴にも出る
		const history = await (await api.get("api/admin/sessions/history")).json();
		expect(history[0]).toMatchObject({targetUser: target.user, by: keys.owner, sessions: 1, apiKeys: 1});
	});

	test("管理者でない人・APIキーでは呼べない(403)。断ったことは監査ログに残る", async () => {
		const res = await (await as(rw)).get("api/admin/users");
		expect(res.status()).toBe(403);
		expect((await (await as(rw)).get("api/admin/audit")).status()).toBe(403);
		expect((await (await as(rw)).get("api/admin/sessions")).status()).toBe(403);
		expect((await (await as(rw)).put("api/server-status/rate-limit", {data: {anonymous: 100}})).status()).toBe(403);
		expect((await (await as({})).get("api/admin/users")).status()).toBe(401);

		const logged = await audit({action: "access_denied", target: "api/admin/users", range: "1d"});
		expect(logged.entries[0]).toMatchObject({user: keys.owner, result: "denied", via: "apikey", keyRole: "readwrite", target: "GET api/admin/users"});
	});
});

test.describe("セッション・監査ログ(共通の形)", () => {
	test("セッション: 新しい道でも、旧い道と同じ物を返す", async () => {
		const api = await as(admin);
		const current = await (await api.get("api/admin/sessions")).json();
		const legacy = await (await api.get("api/sessions")).json();
		expect(current.users.map((user) => user.user)).toEqual(legacy.users.map((user) => user.user));
		const me = current.users.find((user) => user.user === keys.owner);
		expect(me.isSelf).toBe(true);
		expect(Array.isArray(me.sessions) && Array.isArray(me.apiKeys)).toBe(true);
		const history = await api.get("api/admin/sessions/history");
		expect(history.status()).toBe(200);
		expect(Array.isArray(await history.json())).toBe(true);
	});

	test("監査ログ: {entries, actions, limit, nextBefore}。正しくない期間は 400", async () => {
		const body = await audit({range: "30d"});
		expect(body.limit).toBe(100);
		expect(body.actions.find((action) => action.value === "user_add").label).toBe("利用者の追加");
		expect(body.entries.length).toBeGreaterThan(0);
		for (const entry of body.entries) {
			expect(Object.keys(entry).sort()).toEqual(["action", "at", "id", "ip", "keyRole", "result", "target", "user", "via"]);
			expect(["success", "denied", "failed"]).toContain(entry.result);
		}
		expect((await (await as(admin)).get("api/admin/audit?range=2d")).status()).toBe(400);
		expect((await (await as(admin)).get("api/admin/audit?user=a&user=b")).status()).toBe(400);
	});

	test("監査ログ: APIキーでの書き込みは、経路と権限と接続元つきで残る", async () => {
		const upload = await (await as(rw)).post("api/documents", {
			multipart: {uploadfile: {name: "admin-audit.md", mimeType: "text/markdown", buffer: Buffer.from("# 監査ログの試験\n")}}
		});
		expect(upload.status()).toBe(200);
		const logged = await audit({action: "upload", target: "admin-audit.md", range: "1d"});
		expect(logged.entries[0]).toMatchObject({user: keys.owner, via: "apikey", keyRole: "readwrite", result: "success"});
		expect(logged.entries[0].ip).toBeTruthy();
	});
});
