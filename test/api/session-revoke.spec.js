/*!
 * session-revoke.spec.js : 管理者による利用者の切断(セッション・APIキー・引換券・SSE)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 不正アクセスが疑われるときに、対象の利用者を**まとめて切る**機能。
 * ここが甘いと「切ったはずの相手がまだ入れる」。しかも画面には切断済みと出るので、
 * 誰も気づけない。入口は4つあり、**1つでも残ると意味がない**。
 *
 *   ログイン中のセッション / 発行済みのAPIキー / モックアップの引換券 / 開いたままのSSE
 *
 * 切断は取り消せないので、切ってよい利用者は serve.js が別に用意している
 * (keys.revokeTargets)。他のテストが使う owner は切らない。
 */

const {test, expect} = require("@playwright/test");
const http = require("node:http");
const zlib = require("node:zlib");
const {loadKeys, BASE_URL} = require("./config.js");

const keys = loadKeys();
const rw = {Authorization: `Bearer ${keys.readwrite}`};
const ro = {Authorization: `Bearer ${keys.readonly}`};
const {victim, admin2, keyOnly, bystander} = keys.revokeTargets;

const cookieHeader = (cookie) => ({Cookie: `${keys.sessionCookieName}=${encodeURIComponent(cookie)}`});
const bearer = (apiKey) => ({Authorization: `Bearer ${apiKey}`});
const admin = cookieHeader(keys.sessionCookie);
// cookieの値は "s:<セッションID>.<署名>"。応答に紛れ込んでいないかを見るために取り出す
const sidOf = (cookie) => cookie.slice(2).split(".")[0];

// **利用者ごとに、別の入れ物(APIRequestContext)で呼ぶ。**
// Playwright の request は応答の Set-Cookie を覚えて次の呼び出しに付ける。1つを使い回すと、
// 「未認証で呼んだつもり」の要求に直前の利用者の cookie が乗り、誰として呼んだのか分からなくなる
// (実際に、未認証のはずの呼び出しが403になった)
const contexts = new Map();
let playwrightRequest = null;
const as = async (headers) => {
	const key = JSON.stringify(headers);
	if (!contexts.has(key)) {
		contexts.set(key, await playwrightRequest.newContext({baseURL: `${BASE_URL}/`, extraHTTPHeaders: headers}));
	}
	return contexts.get(key);
};
const anonymous = {};

/** そのログインがまだ通るか */
const isLoggedIn = async (headers) => (await (await as(headers)).get("api/check_access_token")).status() === 200;
const canCallApi = async (headers) => (await (await as(headers)).get("api/documents")).status();

const listSessions = async (headers = admin) => {
	const res = await (await as(headers)).get("api/sessions");
	expect(res.status()).toBe(200);
	return res.json();
};
const revoke = async (headers, data) => (await as(headers)).post("api/sessions/revoke", {data});
const entryOf = (listed, user) => listed.users.find((entry) => entry.user === user);

/** SSEを開き、最初の1行(:connected)が届いたところで返す */
const openSse = (headers) => new Promise((resolve, reject) => {
	const req = http.get(`${BASE_URL}/api/documents/events`, {headers}, (res) => {
		if (res.statusCode !== 200) {
			reject(new Error(`SSEを開けない: ${res.statusCode}`));
			return;
		}
		const closed = new Promise((done) => res.on("close", done));
		res.once("data", () => resolve({
			isOpen: () => !res.destroyed && !res.complete,
			waitClosed: (ms) => Promise.race([closed.then(() => true), new Promise((done) => setTimeout(() => done(false), ms))]),
			close: () => req.destroy()
		}));
	});
	req.on("error", reject);
});

// 最小のZIP(index.html 1枚)。モックアップの引換券を発行させるために登録する
const buildZip = (entries) => {
	const locals = [], centrals = [];
	let offset = 0;
	for (const {name, data} of entries) {
		const n = Buffer.from(name, "utf-8"), p = zlib.deflateRawSync(data, {level: 9});
		const l = Buffer.alloc(30);
		l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8);
		l.writeUInt32LE(p.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
		locals.push(l, n, p);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
		c.writeUInt32LE(p.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
		centrals.push(c, n);
		offset += l.length + n.length + p.length;
	}
	const lp = Buffer.concat(locals), cp = Buffer.concat(centrals), e = Buffer.alloc(22);
	e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
	e.writeUInt32LE(cp.length, 12); e.writeUInt32LE(lp.length, 16);
	return Buffer.concat([lp, cp, e]);
};

/** その利用者として引換券つきのURLを受け取る(ログインの代わりに効くURL) */
const issueTicketUrl = async (mockupId, headers) => {
	const res = await (await as(headers)).get(`api/mockups/${mockupId}/view`, {maxRedirects: 0});
	expect(res.status()).toBe(302);
	return new URL(res.headers()["location"], BASE_URL).href;
};

test.describe.serial("利用者の切断", () => {
	test.beforeAll(({playwright}) => { playwrightRequest = playwright.request; });
	test.afterAll(async () => {
		for (const context of contexts.values()) await context.dispose();
	});

	test("管理者の、画面からのログインでしか使えない", async () => {
		const routes = [
			["get", "api/sessions"],
			["get", "api/sessions/history"],
			["post", "api/sessions/revoke"]
		];
		for (const [method, url] of routes) {
			const call = async (headers) => (await as(headers))[method](url, {data: method === "post" ? {user: bystander.user} : undefined});
			expect((await call(anonymous)).status(), `${url}: 未認証で通っている`).toBe(401);
			// 管理者ではないログイン
			expect((await call(cookieHeader(victim.cookies[0]))).status(), `${url}: 一般の利用者で通っている`).toBe(403);
			// APIキー(他人を切れる鍵を、配って回るものに持たせない)
			expect((await call(rw)).status(), `${url}: APIキーで通っている`).toBe(403);
			expect((await call(ro)).status()).toBe(403);
			// 管理者が発行したAPIキーでも通さない
			expect((await call(bearer(admin2.apiKey))).status(), `${url}: 管理者のAPIキーで通っている`).toBe(403);
		}
		// 断られた呼び出しで、誰も切られていないこと
		expect(await isLoggedIn(cookieHeader(bystander.cookies[0]))).toBe(true);
	});

	test("切るかどうかを判断できる情報が、セッションごとに出る", async () => {
		const listed = await listSessions();
		const target = entryOf(listed, victim.user);
		expect(target.sessions).toHaveLength(2);
		expect(target.role).toBe("readwrite");
		for (const session of target.sessions) {
			expect(session.loginAt, "ログイン時刻が無い").toBeTruthy();
			expect(session.lastSeenAt, "最終アクセスが無い").toBeTruthy();
			expect(session.ip).toMatch(/^203\.0\.113\./);
			expect(session.userAgent).toMatch(/^TestBrowser\//);
			expect(session.expiresAt).toBeTruthy();
			expect(session.current).toBe(false);
		}
		expect(target.apiKeys).toHaveLength(1);
		expect(target.apiKeys[0].label).toBe("key-of-victim");

		// 自分自身のセッションには目印が付く(自分を切るかどうかの判断に要る)
		const mine = entryOf(listed, keys.owner);
		expect(mine.isSelf).toBe(true);
		expect(mine.sessions.filter((session) => session.current)).toHaveLength(1);
	});

	// この機能を入れる前からログインしていた人は、手がかりを持っていない
	test("記録の無い古いセッションは「不明」として出し、最終アクセスだけ次の操作から入る", async () => {
		// 1回目の呼び出しそのものが「アクセス」になり、応答の後に記録される
		await listSessions();
		const mine = entryOf(await listSessions(), keys.owner).sessions.find((session) => session.current);
		expect(mine.loginAt, "記録していないものを捏造している").toBeNull();
		expect(mine.ip).toBeNull();
		expect(mine.lastSeenAt, "最終アクセスが入っていない").toBeTruthy();
	});

	// セッションIDはそれ自体がログインの鍵。一覧に出すと、管理画面を見た人が他人になりすませる
	test("セッションIDそのものは、どこにも出さない", async () => {
		const body = JSON.stringify(await listSessions());
		for (const cookie of [keys.sessionCookie, ...victim.cookies, ...admin2.cookies, ...bystander.cookies]) {
			expect(body.includes(sidOf(cookie)), "一覧にセッションIDが出ている").toBe(false);
		}
		// APIキーの本体も出さない
		expect(body.includes(victim.apiKey)).toBe(false);
	});

	test("知らない相手・空の指定は断る", async () => {
		expect((await revoke(admin, {})).status()).toBe(400);
		expect((await revoke(admin, {user: "   "})).status()).toBe(400);
		// 打ち間違いで「切断した」という記録だけが残らないこと
		const res = await revoke(admin, {user: "nobody@example.com"});
		expect(res.status()).toBe(404);
		const history = await (await (await as(admin)).get("api/sessions/history")).json();
		expect(history.some((row) => row.targetUser === "nobody@example.com")).toBe(false);
	});

	// この機能の目的そのもの。入口が1つでも残ると、切ったことにならない
	test("切断すると、セッション・APIキー・引換券・SSEがすべて止まる", async () => {
		const sessionA = cookieHeader(victim.cookies[0]);
		const sessionB = cookieHeader(victim.cookies[1]);
		const apiKey = bearer(victim.apiKey);

		// 切る前は全部通っている(通っていないものを「止まった」と数えないため)
		expect(await isLoggedIn(sessionA)).toBe(true);
		expect(await isLoggedIn(sessionB)).toBe(true);
		expect(await canCallApi(apiKey)).toBe(200);

		const uploaded = await (await as(rw)).post("api/mockups", {
			multipart: {
				mockupfile: {name: "m.zip", mimeType: "application/zip", buffer: buildZip([{name: "index.html", data: Buffer.from("<html><body>機密の画面案</body></html>")}])},
				name: `切断テスト${Date.now()}`
			}
		});
		expect(uploaded.status()).toBe(200);
		const mockupId = (await uploaded.json()).id;
		const victimTicket = await issueTicketUrl(mockupId, apiKey);
		const bystanderTicket = await issueTicketUrl(mockupId, bearer(bystander.apiKey));
		// 引換券のURLは、ログインしていない相手が開いても通る(だから切断で止める必要がある)
		const openTicket = async (url) => (await (await as(anonymous)).get(url)).status();
		expect(await openTicket(victimTicket)).toBe(200);

		const victimSse = await openSse(sessionA);
		const victimKeySse = await openSse(apiKey);
		const bystanderSse = await openSse(cookieHeader(bystander.cookies[0]));

		const res = await revoke(admin, {user: victim.user});
		expect(res.status()).toBe(200);
		const result = await res.json();
		expect(result.sessions).toBe(2);
		expect(result.apiKeys).toBe(1);
		expect(result.keptCurrentSession).toBe(false);

		// 1. セッション(2つとも)
		expect(await isLoggedIn(sessionA), "セッションが残っている").toBe(false);
		expect(await isLoggedIn(sessionB), "もう1つのセッションが残っている").toBe(false);
		expect(await canCallApi(sessionA)).toBe(401);
		// 2. APIキー
		expect(await canCallApi(apiKey), "APIキーが生きている").toBe(401);
		// 3. 引換券(ログインとは別に効くので、切断を覚えていないと見え続ける)
		expect(await openTicket(victimTicket), "切断前の引換券でまだ見られる").toBe(401);
		// 4. 開いたままのSSE(繋いだ時にしか認証しないので、閉じないと通知が流れ続ける)
		expect(await victimSse.waitClosed(5000), "セッションのSSEが開いたまま").toBe(true);
		expect(await victimKeySse.waitClosed(5000), "APIキーのSSEが開いたまま").toBe(true);

		// 一覧からも消えている
		expect(entryOf(await listSessions(), victim.user)).toBeUndefined();

		// 関係ない人は巻き込まない
		expect(await isLoggedIn(cookieHeader(bystander.cookies[0])), "別の人のセッションまで切っている").toBe(true);
		expect(await canCallApi(bearer(bystander.apiKey)), "別の人のAPIキーまで止めている").toBe(200);
		expect(await openTicket(bystanderTicket), "別の人の引換券まで止めている").toBe(200);
		expect(bystanderSse.isOpen(), "別の人のSSEまで閉じている").toBe(true);
		bystanderSse.close();
		// 操作した管理者自身も、そのまま使えている
		expect(await isLoggedIn(admin)).toBe(true);
	});

	// 切断された本人に「切られた」と伝えない(侵入者にも同じものが見えるため)。
	// ふつうの未ログインと同じ応答であること
	test("切られた側には、ふつうの未ログインと同じ応答を返す", async () => {
		const cut = await (await as(cookieHeader(victim.cookies[0]))).get("api/documents");
		const notLoggedIn = await (await as(anonymous)).get("api/documents");
		expect(cut.status()).toBe(notLoggedIn.status());
		expect(await cut.json()).toEqual(await notLoggedIn.json());
		// 共有リンクを開いたときも、ふつうにログインへ迂回するだけ
		const viewer = await (await as(cookieHeader(victim.cookies[0]))).get("api/documents/alias/000000000000/viewer", {maxRedirects: 0});
		expect(viewer.headers()["location"]).toContain("/login?next=");
	});

	// ログインはしておらず、配ったAPIキーだけで入られている場合
	test("APIキーしか持っていない利用者も、一覧に出て切れる", async () => {
		const target = entryOf(await listSessions(), keyOnly.user);
		expect(target, "キーだけの人が一覧に出ていない(切る入口が無い)").toBeTruthy();
		expect(target.sessions).toHaveLength(0);
		expect(target.apiKeys).toHaveLength(1);

		const res = await revoke(admin, {user: keyOnly.user});
		expect(await res.json()).toMatchObject({sessions: 0, apiKeys: 1});
		expect(await canCallApi(bearer(keyOnly.apiKey))).toBe(401);
	});

	// 押した直後に自分の画面が落ちると、結果を確かめられない
	test("自分自身を切ると、操作中のセッションだけが残る", async () => {
		const operating = cookieHeader(admin2.cookies[0]);
		const elsewhere = cookieHeader(admin2.cookies[1]);
		expect(await isLoggedIn(elsewhere)).toBe(true);

		const res = await revoke(operating, {user: admin2.user});
		expect(res.status()).toBe(200);
		const result = await res.json();
		expect(result.sessions, "操作中のものまで数えている").toBe(1);
		expect(result.keptCurrentSession).toBe(true);

		expect(await isLoggedIn(operating), "操作中のセッションまで切れている").toBe(true);
		expect(await isLoggedIn(elsewhere), "別の場所のセッションが残っている").toBe(false);
		// APIキーは一式として止まる(操作中のセッションとは別物)
		expect(await canCallApi(bearer(admin2.apiKey))).toBe(401);

		// 残したセッションは、その後も使い続けられる(次の要求で弾かれない)
		const listed = await listSessions(operating);
		expect(entryOf(listed, admin2.user).sessions).toHaveLength(1);
		expect(entryOf(listed, admin2.user).sessions[0].current).toBe(true);
	});

	test("誰が・いつ・誰を・何件切ったかが履歴に残る", async () => {
		const res = await (await as(admin)).get("api/sessions/history");
		expect(res.status()).toBe(200);
		const history = await res.json();

		const entry = history.find((row) => row.targetUser === victim.user);
		expect(entry, "切断が履歴に無い").toBeTruthy();
		expect(entry.by).toBe(keys.owner);
		expect(entry.sessions).toBe(2);
		expect(entry.apiKeys).toBe(1);
		expect(Date.parse(entry.at)).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
		// 切ったセッションの手がかり。セッションと一緒に消えると、どこから入られていたかを追えなくなる
		expect(entry.sessionDetails.map((detail) => detail.ip).sort()).toEqual(["203.0.113.10", "203.0.113.11"]);
		expect(entry.sessionDetails[0].userAgent).toMatch(/^TestBrowser\//);

		// 自分を切った分は、実行者と対象が同じ人になる
		const self = history.find((row) => row.targetUser === admin2.user);
		expect(self.by).toBe(admin2.user);
		expect(self.sessions).toBe(1);

		// 履歴にもセッションIDは出さない
		const body = JSON.stringify(history);
		for (const cookie of [...victim.cookies, ...admin2.cookies]) {
			expect(body.includes(sidOf(cookie)), "履歴にセッションIDが出ている").toBe(false);
		}
	});

	// 本人向けの履歴は文書・プロジェクトの操作を並べる画面。切断はそこに混ぜない
	test("本人向けの操作履歴には混ざらない", async () => {
		const mine = await (await (await as(admin)).get("api/history")).json();
		expect(mine.some((row) => row.action === "session_revoke")).toBe(false);
	});
});
