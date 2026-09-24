/*!
 * auth.spec.js : 認証・認可の強制(enforcement)のAPIテスト
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * resolveAuth(Bearer APIキー経路) + requireAuth/requireWrite/requireAdmin が
 * ルートごとに正しく効いているか(401/403/200)を、実サーバに対して検証する。
 */

const {test, expect} = require("@playwright/test");
const {loadKeys, PORT} = require("./config.js");

const keys = loadKeys();
const bearer = (key) => (key ? {Authorization: `Bearer ${key}`} : {});

test.describe("requireAuth: 未認証は401", () => {
	const protectedGet = ["api/documents", "api/tag_order", "api/projects", "api/history", "api/apikeys"];
	for (const url of protectedGet) {
		test(`GET /${url} は認証なしで401`, async ({request}) => {
			const res = await request.get(url);
			expect(res.status()).toBe(401);
		});
	}

	test("不正なAPIキーは401", async ({request}) => {
		const res = await request.get("api/documents", {headers: bearer(keys.invalid)});
		expect(res.status()).toBe(401);
	});

	test("期限切れのAPIキーは401(期限切れメッセージ)", async ({request}) => {
		const res = await request.get("api/documents", {headers: bearer(keys.expired)});
		expect(res.status()).toBe(401);
		const body = await res.json();
		expect(body.error).toContain("有効期限");
	});
});

test.describe("requireAuth: 有効なキーは200(読み取り)", () => {
	for (const role of ["readonly", "readwrite"]) {
		test(`${role}キーで GET /api/documents は200・配列`, async ({request}) => {
			const res = await request.get("api/documents", {headers: bearer(keys[role])});
			expect(res.status()).toBe(200);
			expect(Array.isArray(await res.json())).toBe(true);
		});

		test(`${role}キーで GET /api/tag_order は200`, async ({request}) => {
			const res = await request.get("api/tag_order", {headers: bearer(keys[role])});
			expect(res.status()).toBe(200);
		});
	}
});

test.describe("requireWrite: readonlyは書き込み403、readwriteは許可", () => {
	test("readonlyキーで PUT タグ更新は403", async ({request}) => {
		const res = await request.put("api/documents/nonexistent-id/tags", {
			headers: bearer(keys.readonly),
			data: {tags: ["x"]}
		});
		expect(res.status()).toBe(403);
	});

	test("readonlyキーで DELETE 文書は403", async ({request}) => {
		const res = await request.delete("api/documents/nonexistent-id", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(403);
	});

	test("readwriteキーで PUT タグ更新は書き込み権限を通過する(存在しないIDなので404)", async ({request}) => {
		// 403にならず404になること = requireWriteを通過したことの確認
		const res = await request.put("api/documents/nonexistent-id/tags", {
			headers: bearer(keys.readwrite),
			data: {tags: ["x"]}
		});
		expect(res.status()).toBe(404);
	});
});

test.describe("requireAdmin: APIキー(最大readwrite)では管理APIに到達できない", () => {
	// APIキーのロールはreadonly/readwriteのみ。requireAdminが効いていれば403になる
	test("readwriteキーで GET /api/allowed_users は403", async ({request}) => {
		const res = await request.get("api/allowed_users", {headers: bearer(keys.readwrite)});
		expect(res.status()).toBe(403);
	});

	test("readonlyキーで GET /api/allowed_users は403", async ({request}) => {
		const res = await request.get("api/allowed_users", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(403);
	});

	test("未認証で GET /api/allowed_users は401", async ({request}) => {
		const res = await request.get("api/allowed_users");
		expect(res.status()).toBe(401);
	});
});

// APIキー管理(発行・一覧・失効)はブラウザのログインセッションからのみ行える。
// APIキーでAPIキーを発行できると、期限が切れる前にキー自身が新しいキーを作り直せてしまい、
// 有効期限の上限(最長1年)が意味を持たなくなるため
test.describe("APIキー管理はセッション限定", () => {
	const apiKeyRoutes = [
		{name: "一覧", call: (request, headers) => request.get("api/apikeys", {headers})},
		{name: "発行", call: (request, headers) => request.post("api/apikeys", {headers, data: {role: "readonly", expiryOption: "30d"}})},
		{name: "失効", call: (request, headers) => request.delete("api/apikeys/00000000-0000-0000-0000-000000000000", {headers})}
	];
	for (const route of apiKeyRoutes) {
		for (const role of ["readonly", "readwrite"]) {
			test(`${role}キーでの${route.name}は403`, async ({request}) => {
				const res = await route.call(request, bearer(keys[role]));
				expect(res.status()).toBe(403);
				expect((await res.json()).error).toContain("画面");
			});
		}
	}
});

test.describe("APIキーの有効期限(最長1年)", () => {
	// 発行はセッション(ブラウザでログイン済みの管理者)からのみ行える
	const rw = {Cookie: `${keys.sessionCookieName}=${encodeURIComponent(keys.sessionCookie)}`};
	test("1年のキーを発行でき、使え、失効させると401になる", async ({request}) => {
		const created = await request.post("api/apikeys", {headers: rw, data: {label: "one-year-test", role: "readonly", expiryOption: "365d"}});
		expect(created.status()).toBe(200);
		const body = await created.json();
		// 1年後(前後1分の誤差を許容)
		const expected = Date.now() + 365 * 24 * 60 * 60 * 1000;
		expect(Math.abs(new Date(body.expiresAt).getTime() - expected)).toBeLessThan(60 * 1000);

		const key = {Authorization: `Bearer ${body.apiKey}`};
		expect((await request.get("api/documents", {headers: key})).status()).toBe(200);

		const list = await (await request.get("api/apikeys", {headers: rw})).json();
		expect(list.find((k) => k.id === body.id).expiresAt).toBe(body.expiresAt);

		expect((await request.delete(`api/apikeys/${body.id}`, {headers: rw})).status()).toBe(204);
		expect((await request.get("api/documents", {headers: key})).status()).toBe(401);
	});

	test("無期限(unlimited)や不正な expiryOption は400", async ({request}) => {
		for (const expiryOption of ["unlimited", "forever", "3650d"]) {
			const res = await request.post("api/apikeys", {headers: rw, data: {role: "readonly", expiryOption}});
			expect(res.status(), `expiryOption=${expiryOption}`).toBe(400);
		}
	});
});

// 手元のクライアント(Skill同梱のdm_client)が古いとき、サーバーは応答ヘッダーで新しい版を知らせる。
// クライアントはこれを見て、利用者とAIへ更新を促す
test.describe("クライアントの更新のお知らせ", () => {
	const skillAgent = (version) => ({"User-Agent": `document-manager-skill/${version} (python 3.13)`});

	test("古いクライアントには新しい版を知らせる", async ({request}) => {
		const res = await request.get("api/documents", {headers: {...bearer(keys.readonly), ...skillAgent("1.0.0")}});
		expect(res.status()).toBe(200);
		expect(res.headers()["x-skill-latest-version"]).toBe("9.9.9");
	});

	test("同じ版・新しい版のクライアントには知らせない", async ({request}) => {
		for (const version of ["9.9.9", "10.0.0"]) {
			const res = await request.get("api/documents", {headers: {...bearer(keys.readonly), ...skillAgent(version)}});
			expect(res.headers()["x-skill-latest-version"], version).toBeUndefined();
		}
	});

	test("クライアント以外(ブラウザ等)には何も付けない", async ({request}) => {
		const res = await request.get("api/documents", {
			headers: {...bearer(keys.readonly), "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
		});
		expect(res.headers()["x-skill-latest-version"]).toBeUndefined();
	});

	test("認証に失敗した応答にも付く(期限切れでも更新に気づける)", async ({request}) => {
		const res = await request.get("api/documents", {headers: {...bearer(keys.expired), ...skillAgent("1.0.0")}});
		expect(res.status()).toBe(401);
		expect(res.headers()["x-skill-latest-version"]).toBe("9.9.9");
	});
});

// 手探りでAPIを叩いている相手(自作クライアント、キーだけ渡されたAI)に、次に読むものを示す。
// 公開サーバ前提のため、案内を返すのは「キーを提示した相手」に限る
test.describe("利用ガイドの場所の案内", () => {
	test("存在しないAPIパスはJSONの404を返す(HTMLのエラーページではない)", async ({request}) => {
		const res = await request.get("api/nonexistent", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(404);
		expect(res.headers()["content-type"]).toContain("application/json");
		const body = await res.json();
		expect(body.error).toBe("not found");
		expect(body.guide).toContain("/api/usage.md");
	});

	test("期限切れのキーには案内を添える(キーを出した相手なので)", async ({request}) => {
		const body = await (await request.get("api/documents", {headers: bearer(keys.expired)})).json();
		expect(body.guide).toContain("/api/usage.md");
	});

	test("キーを出していない相手には案内しない(鍵を持たない者への道案内をしない)", async ({request}) => {
		for (const url of ["api/documents", "api/nonexistent"]) {
			const body = await (await request.get(url)).json();
			expect(body.guide, url).toBeUndefined();
		}
	});

	test("案内するURLに ?baseUrl= の値を使わない(任意のURLをAIに読ませられないこと)", async ({request}) => {
		const res = await request.get("api/nonexistent?baseUrl=https%3A%2F%2Fevil.example%2F", {headers: bearer(keys.readonly)});
		const body = await res.json();
		expect(body.guide).not.toContain("evil.example");
		expect(body.guide).toContain("127.0.0.1");
	});

	test("案内先のガイド自体は認証が必要なまま(場所を知られても中身は読めない)", async ({request}) => {
		expect((await request.get("api/usage.md")).status()).toBe(401);
	});
});

test.describe("Claude Code用SkillのZIPダウンロード", () => {
	test("未認証は401", async ({request}) => {
		expect((await request.get("api/claude-skill.zip")).status()).toBe(401);
	});

	test("readonlyキーでもダウンロードでき、document-manager/SKILL.md を含むZIPが返る", async ({request}) => {
		const res = await request.get("api/claude-skill.zip", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/zip");
		expect(res.headers()["content-disposition"]).toContain("document-manager-skill.zip");
		const body = await res.body();
		expect(body.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
		expect(body.includes(Buffer.from("document-manager/SKILL.md"))).toBe(true);
		expect(body.includes(Buffer.from("document-manager/scripts/dm_client.py"))).toBe(true);
	});
});

test.describe("API仕様の取得", () => {
	const rw = bearer(keys.readwrite);

	test("未認証は401", async ({request}) => {
		expect((await request.get("api/openapi.json")).status()).toBe(401);
		expect((await request.get("api/usage.md")).status()).toBe(401);
	});

	test("readonlyキーでOpenAPIを取得でき、主要なAPIと権限情報が含まれる", async ({request}) => {
		const res = await request.get("api/openapi.json", {headers: bearer(keys.readonly)});
		expect(res.status()).toBe(200);
		const spec = await res.json();
		expect(spec.openapi).toBe("3.1.0");
		expect(spec.paths["/api/documents"].get.operationId).toBe("listDocuments");
		expect(spec.paths["/api/documents/{id}/versions"].get).toBeTruthy();
		expect(spec.paths["/api/documents/archived"].get).toBeTruthy();
		// adminロールの操作はAPIキーからは実行できないことが分かる
		expect(spec.paths["/api/allowed_users"].get["x-api-key-usable"]).toBe(false);
		// AIへの指示も仕様に含まれる
		expect(spec.info.description).toContain("アップして");
		expect(Array.isArray(spec["x-ai-instructions"])).toBe(true);
	});

	test("利用ガイド(Markdown)を取得できる", async ({request}) => {
		const res = await request.get("api/usage.md", {headers: rw});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toContain("text/markdown");
		const markdown = await res.text();
		expect(markdown.startsWith("# Document Manager API 利用ガイド (AI向け)")).toBe(true);
		expect(markdown).toContain("## AIへの指示");
	});

	test("baseUrlで自分のオリジン配下のパスを指定できる(リバースプロキシのサブパス用)", async ({request}) => {
		const own = `http://127.0.0.1:${PORT}/sub/`;
		const specified = await (await request.get(`api/usage.md?baseUrl=${encodeURIComponent(own)}`, {headers: rw})).text();
		expect(specified).toContain(`- ベースURL: \`http://127.0.0.1:${PORT}/sub\``);
		expect(specified).toContain(`\`GET http://127.0.0.1:${PORT}/sub/api/documents?q=<検索語>\``);
	});

	// 正規のドメインのURLを渡すだけで、ベースURLだけ別サイトに差し替えたガイドを作れてしまうと、
	// AIはそれを信じて以降の呼び出しをAPIキーごと別サイトへ送ってしまう
	test("自分以外のオリジンをbaseUrlに指定しても使われない", async ({request}) => {
		for (const hostile of ["https://evil.example/", "http://127.0.0.1:1/", "https://127.0.0.1.evil.example/"]) {
			const md = await (await request.get(`api/usage.md?baseUrl=${encodeURIComponent(hostile)}`, {headers: rw})).text();
			expect(md, hostile).not.toContain("evil.example");
			expect(md, hostile).toContain(`- ベースURL: \`http://127.0.0.1:${PORT}\``);
		}
	});

	test("http/https以外・壊れた値は既定値にフォールバックする", async ({request}) => {
		for (const bad of ["javascript:alert(1)", "not-a-url"]) {
			const fallback = await (await request.get(`api/usage.md?baseUrl=${encodeURIComponent(bad)}`, {headers: rw})).text();
			expect(fallback).not.toContain(bad);
			expect(fallback).toContain("- ベースURL: `http://127.0.0.1:");
		}
	});
});
