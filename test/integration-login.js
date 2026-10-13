/*!
 * integration-login.js : 実際にログインさせて確かめる(模擬の認証サーバを立てる)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm run test:login`(openssl が要る。無ければ理由を出して終わる)
 *
 * 他のテストは「ログイン済みのセッションをDBへ直接置く」ことで認証を済ませており、
 * **ログインの処理そのものは一度も通っていない**。ここが壊れると誰も入れなくなるのに、
 * 気づけるのは本番に出してから、という状態だった。
 *
 * ここでは OIDC の認証サーバを模したものを立て、本物の server.js を別プロセスで起動して、
 * ブラウザと同じ順序(/login → 認証サーバ → /login?code=...)でログインさせる。
 *
 * 確かめること:
 *   - ログインできる(できないと全員が締め出される)
 *   - ログインでセッションIDが変わる(変わらないと、先にIDを掴ませた第三者が入れる)
 *   - いつ・どこから・何でログインしたかが残る(管理者が切断を判断する材料)
 *   - 切断された後、ログインし直せば入れる(切断は締め出しではない)
 *   - アクセスログにセッションIDそのものが出ない
 *   - アクセスログに、APIキー経由の要求でも利用者が残る
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const {spawn, execFileSync} = require("node:child_process");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-login-"));
const CLIENT_ID = "login-test-client";
const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";

// ---- 証明書 ----
// openid-client は https の認証サーバしか相手にしない(本番と同じ)。
// 検証を緩める設定を製品側に足すのではなく、テスト用の証明書を作って信頼させる
const makeCertificate = () => {
	const keyFile = path.join(WORK_DIR, "idp-key.pem");
	const certFile = path.join(WORK_DIR, "idp-cert.pem");
	const candidates = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"];
	for (const openssl of candidates) {
		try {
			execFileSync(openssl, [
				"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
				"-keyout", keyFile, "-out", certFile,
				"-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
			], {stdio: "ignore"});
			return {keyFile, certFile};
		} catch (err) {
			// 次の候補へ
		}
	}
	return null;
};

// ---- 模擬の認証サーバ(OIDC) ----
const startIdentityProvider = async ({keyFile, certFile}) => {
	const {publicKey, privateKey} = crypto.generateKeyPairSync("rsa", {modulusLength: 2048});
	const jwk = {...publicKey.export({format: "jwk"}), kid: "test-key", use: "sig", alg: "RS256"};
	const state = {issuer: null, email: null, codes: new Map(), authorizeCalls: []};
	const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

	const server = https.createServer({key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile)}, (req, res) => {
		const url = new URL(req.url, state.issuer);
		const json = (body) => {
			res.writeHead(200, {"Content-Type": "application/json"});
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/.well-known/openid-configuration") {
			json({
				issuer: state.issuer,
				authorization_endpoint: `${state.issuer}/authorize`,
				token_endpoint: `${state.issuer}/token`,
				jwks_uri: `${state.issuer}/jwks`,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
				token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
			});
			return;
		}
		if (url.pathname === "/jwks") {
			json({keys: [jwk]});
			return;
		}
		if (url.pathname === "/authorize") {
			// 利用者がここで認証を済ませた、という体で認可コードを返す
			const code = crypto.randomBytes(12).toString("hex");
			state.codes.set(code, {nonce: url.searchParams.get("nonce"), email: state.email});
			state.authorizeCalls.push(Object.fromEntries(url.searchParams));
			const back = new URL(url.searchParams.get("redirect_uri"));
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state"));
			res.writeHead(302, {Location: back.href});
			res.end();
			return;
		}
		if (url.pathname === "/token") {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const issued = state.codes.get(new URLSearchParams(body).get("code"));
				if (issued == null) {
					res.writeHead(400, {"Content-Type": "application/json"});
					res.end(JSON.stringify({error: "invalid_grant"}));
					return;
				}
				const now = Math.floor(Date.now() / 1000);
				const signingInput = `${b64({alg: "RS256", typ: "JWT", kid: jwk.kid})}.${b64({
					iss: state.issuer, aud: CLIENT_ID, sub: `sub-${issued.email}`, email: issued.email,
					nonce: issued.nonce, iat: now, exp: now + 300
				})}`;
				const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
				json({access_token: "unused", token_type: "Bearer", expires_in: 300, id_token: `${signingInput}.${signature}`});
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	state.issuer = `https://127.0.0.1:${server.address().port}`;
	return {state, close: () => server.close()};
};

// ---- 呼び出し(転送は追わず、cookieも自分で持つ。誰として呼んだかを曖昧にしないため) ----
const call = (url, {headers = {}, method = "GET", body = null} = {}) => new Promise((resolve, reject) => {
	const target = new URL(url);
	const lib = target.protocol === "https:" ? https : http;
	const req = lib.request(target, {method, headers, rejectUnauthorized: false}, (res) => {
		let text = "";
		res.on("data", (chunk) => { text += chunk; });
		res.on("end", () => resolve({status: res.statusCode, headers: res.headers, text}));
	});
	req.on("error", reject);
	if (body != null) req.write(body);
	req.end();
});
const cookieOf = (res) => {
	const line = (res.headers["set-cookie"] || []).find((value) => value.startsWith("connect.sid="));
	return line == null ? null : line.split(";")[0];
};
// cookieの値は "s:<セッションID>.<署名>"
const sidOf = (cookie) => decodeURIComponent(cookie.split("=")[1]).slice(2).split(".")[0];

const main = async () => {
	const certificate = makeCertificate();
	if (certificate == null) {
		console.log("SKIP: openssl が見つからないため、ログインの結合テストを実行できません");
		return;
	}
	const idp = await startIdentityProvider(certificate);

	const appPort = await new Promise((resolve) => {
		const probe = http.createServer().listen(0, "127.0.0.1", () => {
			const {port} = probe.address();
			probe.close(() => resolve(port));
		});
	});
	const app = `http://127.0.0.1:${appPort}`;
	let stdout = "";
	const server = spawn(process.execPath, ["server.js"], {
		cwd: path.join(__dirname, "..", "app"),
		env: {
			...process.env,
			DATA_DIR: path.join(WORK_DIR, "data"),
			DATABASE_BACKEND: "sqlite",
			STORAGE_BACKEND: "local",
			LISTEN_PORT: String(appPort),
			BASE_PATH: "",
			SESSION_SECRET: "login-test-secret",
			ADMIN_EMAIL: ADMIN,
			OIDC_ISSUER: idp.state.issuer,
			OIDC_CLIENT_ID: CLIENT_ID,
			OIDC_CLIENT_SECRET: "login-test-client-secret",
			OIDC_REDIRECT_URI: `${app}/login`,
			// テスト用の証明書を信頼させる(検証そのものは切らない)
			NODE_EXTRA_CA_CERTS: certificate.certFile,
			RATE_LIMIT_DISABLED: "true",
			AUTH_DISABLED: ""
		}
	});
	server.stdout.on("data", (chunk) => { stdout += chunk; });
	server.stderr.on("data", (chunk) => { stdout += chunk; });

	try {
		// 起動を待つ
		for (let i = 0; ; i += 1) {
			try {
				if ((await call(`${app}/api/check_access_token`)).status === 401) break;
			} catch (err) {
				// まだ受け付けていない
			}
			if (i > 100) throw new Error(`サーバーが起動しない:\n${stdout.slice(-2000)}`);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		/** ブラウザと同じ順序でログインし、ログイン前後のcookieを返す */
		const login = async (email, {userAgent, presetCookie = null}) => {
			idp.state.email = email;
			const start = await call(`${app}/login`, {headers: presetCookie ? {Cookie: presetCookie} : {}});
			assert.equal(start.status, 302, "ログインを始められない");
			const before = cookieOf(start) || presetCookie;
			assert.ok(before, "ログイン前のcookieが発行されていない");

			const authorized = await call(start.headers.location);
			assert.equal(authorized.status, 302);
			const callback = await call(authorized.headers.location, {headers: {Cookie: before, "User-Agent": userAgent}});
			assert.equal(callback.status, 302, `ログインが通らない(${callback.status}): ${callback.text.slice(0, 300)}`);
			return {before, after: cookieOf(callback)};
		};
		const whoAmI = async (cookie) => {
			const res = await call(`${app}/api/check_access_token`, {headers: {Cookie: cookie}});
			return res.status === 200 ? JSON.parse(res.text) : null;
		};
		const asJson = async (url, cookie, options = {}) => {
			const res = await call(`${app}/${url}`, {...options, headers: {Cookie: cookie, "Content-Type": "application/json", ...(options.headers || {})}});
			return {status: res.status, body: res.text === "" ? null : JSON.parse(res.text)};
		};

		// ---- 1. ログインできる ----
		const adminLogin = await login(ADMIN, {userAgent: "LoginTest-Admin/1.0"});
		assert.ok(adminLogin.after, "ログイン後にcookieが出ていない");
		const me = await whoAmI(adminLogin.after);
		assert.equal(me?.user_identifier, ADMIN, "ログインしたのに認証されていない");
		assert.equal(me.isAdmin, true, "管理者が誰もいないとき、ADMIN_EMAIL の利用者が管理者にならない");
		console.log("ok 1 ログインできる");

		// ---- 2. ログインでセッションIDが変わる(セッション固定を防ぐ) ----
		assert.notEqual(sidOf(adminLogin.after), sidOf(adminLogin.before), "ログインの前後でセッションIDが同じ");
		assert.equal(await whoAmI(adminLogin.before), null, "ログイン前のIDのままで入れる(先にIDを掴ませた第三者が入れる)");
		console.log("ok 2 ログインでセッションIDが変わり、前のIDでは入れない");

		// ---- 3. いつ・どこから・何でログインしたかが残る ----
		const listed = await asJson("api/sessions", adminLogin.after);
		assert.equal(listed.status, 200);
		const mine = listed.body.users.find((entry) => entry.user === ADMIN).sessions.find((session) => session.current);
		assert.ok(Date.now() - Date.parse(mine.loginAt) < 60 * 1000, `ログイン時刻がおかしい: ${mine.loginAt}`);
		assert.equal(mine.lastSeenAt, mine.loginAt, "最終アクセスがログインの時点で入っていない");
		assert.match(mine.ip, /127\.0\.0\.1|::1/, `IPがおかしい: ${mine.ip}`);
		assert.equal(mine.userAgent, "LoginTest-Admin/1.0");
		console.log("ok 3 ログイン時刻・IP・User-Agent が残る");

		// ---- 4. 切断された後、ログインし直せば入れる ----
		const added = await asJson("api/allowed_users", adminLogin.after, {method: "POST", body: JSON.stringify({email: MEMBER, role: "readwrite"})});
		assert.ok(added.status < 300, `利用者を追加できない: ${added.status}`);
		const first = await login(MEMBER, {userAgent: "LoginTest-Member/1.0"});
		assert.equal((await whoAmI(first.after))?.user_identifier, MEMBER);

		const revoked = await asJson("api/sessions/revoke", adminLogin.after, {method: "POST", body: JSON.stringify({user: MEMBER})});
		assert.equal(revoked.status, 200);
		assert.equal(revoked.body.sessions, 1);
		assert.equal(await whoAmI(first.after), null, "切断したのに、まだ入れる");

		// 切られたcookieを持ったままログインし直す(ブラウザはcookieを捨てない)
		const second = await login(MEMBER, {userAgent: "LoginTest-Member/2.0", presetCookie: first.after});
		assert.equal((await whoAmI(second.after))?.user_identifier, MEMBER, "切断が締め出しになっている(ログインし直しても入れない)");
		assert.equal(await whoAmI(first.after), null, "ログインし直したら、切られた古いセッションまで生き返った");
		console.log("ok 4 切断後、ログインし直せば入れる(古いセッションは戻らない)");

		// ---- 5. 切断の履歴に、切ったセッションの手がかりが残る ----
		const history = await asJson("api/sessions/history", adminLogin.after);
		const entry = history.body.find((row) => row.targetUser === MEMBER);
		assert.equal(entry.by, ADMIN);
		assert.equal(entry.sessionDetails[0].userAgent, "LoginTest-Member/1.0");
		console.log("ok 5 切断の履歴に、切ったセッションの手がかりが残る");

		// ---- 6. アクセスログにセッションIDそのものが出ない ----
		await new Promise((resolve) => setTimeout(resolve, 300));
		for (const cookie of [adminLogin.after, first.after, second.after]) {
			assert.equal(stdout.includes(sidOf(cookie)), false, "ログにセッションIDが出ている(ログを読める人がなりすませる)");
		}
		assert.ok(stdout.includes('"msg":"access"'), "アクセスログ自体が取れていない(検査が空振りしている)");
		console.log("ok 6 アクセスログにセッションIDが出ない");

		// ---- 7. APIキー経由の要求でも、誰のものかがアクセスログに残る ----
		// 以前は利用者をブラウザのログインからしか取っておらず、キーでの参照は user:null だった。
		// 不正アクセスを疑ったときに「そのキーで何を見られたか」を追えない
		const issued = await asJson("api/apikeys", second.after, {method: "POST", body: JSON.stringify({label: "log-check-key", role: "readonly", expiryOption: "30d"})});
		assert.ok(issued.status < 300, `APIキーを発行できない: ${issued.status}`);
		const viaKey = await call(`${app}/api/documents?marker=via-api-key`, {headers: {Authorization: `Bearer ${issued.body.apiKey}`}});
		assert.equal(viaKey.status, 200);
		await call(`${app}/api/documents?marker=no-credentials`);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const accessLine = (marker) => JSON.parse(stdout.split("\n").find((line) => line.includes('"msg":"access"') && line.includes(marker)));
		const keyLine = accessLine("marker=via-api-key");
		assert.equal(keyLine.user, MEMBER, "APIキー経由の要求に利用者が残っていない");
		assert.equal(keyLine.apiKey, "log-check-key", "どのキーかが残っていない");
		assert.equal(stdout.includes(issued.body.apiKey), false, "ログにAPIキーの本体が出ている");
		// 画面からの操作は、キーの欄が空になる(キー経由と見分けられる)
		const sessionLine = accessLine("api/sessions/history");
		assert.equal(sessionLine.user, ADMIN);
		assert.equal(sessionLine.apiKey, null);
		// 認証していない要求に、誰かの名前を付けない
		assert.equal(accessLine("marker=no-credentials").user, null);
		console.log("ok 7 APIキー経由の要求でも、利用者とキーの用途がアクセスログに残る");

		// ---- 8. プロジェクトのリンクで来た人は、ログインのあと同じリンクへ戻る ----
		// 画面は未ログインのとき `login?next=<開こうとしたURL>` へ回す(index.html)。戻り先が落ちると、
		// せっかくのリンクがログインで消えて、ただのトップ画面に着く
		const loginVia = async (nextPath) => {
			idp.state.email = ADMIN;
			const start = await call(`${app}/login?next=${encodeURIComponent(nextPath)}`);
			assert.equal(start.status, 302);
			const authorized = await call(start.headers.location);
			const callback = await call(authorized.headers.location, {headers: {Cookie: cookieOf(start)}});
			assert.equal(callback.status, 302);
			return callback.headers.location;
		};
		// このテストの構成では、アプリは外から /document_management/ として見えている(BASE_PATH の既定)。
		// 画面が渡してくる戻り先も、その見えているパスになる
		const PUBLIC_ROOT = "/document_management/";
		assert.equal(await loginVia(`${PUBLIC_ROOT}?project=202610_abc`), `${PUBLIC_ROOT}?project=202610_abc`,
			"ログインのあと、プロジェクトのリンクへ戻っていない");
		// 戻り先に他所のURLや、このアプリの外のパスを渡されても、そこへは飛ばさない(トップへ戻す)
		for (const hostile of ["https://evil.example.com/?project=x", "//evil.example.com/?project=x", "/other-app/?project=x"]) {
			assert.equal(await loginVia(hostile), PUBLIC_ROOT, `他所へ飛ばしている: ${hostile}`);
		}
		console.log("ok 8 プロジェクトのリンクで来た人は、ログイン後に同じリンクへ戻る(他所へは飛ばない)");

		// 再認証の強制(prompt=login / max_age)は入れていない。入れたらここで気づけるようにしておく
		assert.equal(idp.state.authorizeCalls.some((query) => "prompt" in query || "max_age" in query), false);

		console.log("\nすべて成功");
	} finally {
		server.kill();
		idp.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		try {
			fs.rmSync(WORK_DIR, {recursive: true, force: true});
		} catch (err) {
			// Windowsではプロセスの終了直後に消せないことがある。一時ディレクトリなので残っても害は無い
		}
	}
};

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
