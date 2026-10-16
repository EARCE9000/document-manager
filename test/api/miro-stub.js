/*!
 * miro-stub.js : Miro の REST API の代わり(テスト用)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 本物の Miro に毎回つなぐと、アカウント・ネットワーク・回数の上限に左右される。アプリ側の振る舞い
 * (許可の画面とのやりとり・トークンの保管と更新・ボードの読み書き)を確かめるには、Miro と同じ形で
 * 応える相手があれば足りるので、ここで最小限のものを用意する。本物との整合は、実物のボードで確かめる。
 *
 * テストから振る舞いを変えられる:
 *   POST /__control {"deny": true}              次の許可の画面で「許可しない」を選んだことにする
 *   POST /__control {"refreshFails": true}      トークンの更新を断る(取り消された・期限切れ)
 *   POST /__control {"expireAccess": true}      いまのアクセストークンを無効にする(401 を返す)
 *   POST /__control {"accessTtlSeconds": 3599}  次に発行するアクセストークンの寿命
 *   POST /__control {"reset": true}             状態を初めに戻す
 *   GET  /__requests                            受け取ったリクエストの記録(パスとメソッド)
 *   GET  /__state                               発行したトークンの数など(検証用)
 */

const http = require("node:http");
const crypto = require("node:crypto");

const TEAM = {id: "3074457350000000001", name: "Dev team"};
const OTHER_TEAM = {id: "3074457350000000999", name: "Other team"};
const USER = {id: "3074457360000000001", name: "Stub User"};
const CLIENT_ID = "3458764600000000001";
const CLIENT_SECRET = "stub-client-secret";

const initialBoards = () => [
	{id: "uXjVStubBoard1=", name: "Document Manager 連携テスト", team: TEAM},
	{id: "uXjVStubBoard2=", name: "企画ブレスト", team: TEAM},
	{id: "uXjVOtherTeam=", name: "別チームのボード", team: OTHER_TEAM}
];

module.exports.CLIENT_ID = CLIENT_ID;
module.exports.CLIENT_SECRET = CLIENT_SECRET;
module.exports.TEAM = TEAM;

module.exports.start = (port) => new Promise((resolve) => {
	const requests = [];
	let control = {};
	let codes = new Map();
	let accessTokens = new Map();
	let refreshTokens = new Set();
	let boards = initialBoards();
	let issued = 0;
	let revoked = 0;

	const reset = () => {
		control = {};
		codes = new Map();
		accessTokens = new Map();
		refreshTokens = new Set();
		boards = initialBoards();
		issued = 0;
		revoked = 0;
		requests.length = 0;
	};

	const send = (res, status, body, headers = {}) => {
		res.writeHead(status, {"Content-Type": "application/json", ...headers});
		res.end(body == null ? "" : JSON.stringify(body));
	};

	const issueTokens = () => {
		issued++;
		const access = `stub-access-${crypto.randomBytes(8).toString("hex")}`;
		const refresh = `stub-refresh-${crypto.randomBytes(8).toString("hex")}`;
		const ttl = Number(control.accessTtlSeconds ?? 3599);
		accessTokens.set(access, Date.now() + ttl * 1000);
		refreshTokens.add(refresh);
		return {access_token: access, refresh_token: refresh, expires_in: ttl, token_type: "bearer", scope: "boards:read boards:write", team_id: TEAM.id, user_id: USER.id};
	};

	const authorized = (req) => {
		const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
		const expires = accessTokens.get(token);
		return expires != null && expires > Date.now();
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			if (!url.pathname.startsWith("/__")) requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});

			if (url.pathname === "/__control" && req.method === "POST") {
				const body = raw ? JSON.parse(raw) : {};
				if (body.reset) reset();
				if (body.expireAccess) for (const key of accessTokens.keys()) accessTokens.set(key, 0);
				control = {...control, ...body};
				delete control.reset;
				delete control.expireAccess;
				send(res, 200, {ok: true});
				return;
			}
			if (url.pathname === "/__requests") {
				send(res, 200, requests);
				return;
			}
			if (url.pathname === "/__state") {
				send(res, 200, {issued, revoked, validRefreshTokens: refreshTokens.size});
				return;
			}

			// ---- 許可の画面(本物はログインして許可する。ここではすぐ戻す) ----
			if (url.pathname === "/oauth/authorize" && req.method === "GET") {
				const redirect = new URL(url.searchParams.get("redirect_uri"));
				if (url.searchParams.get("client_id") !== CLIENT_ID) {
					send(res, 400, {error: "invalid_client"});
					return;
				}
				if (control.deny) {
					redirect.searchParams.set("error", "access_denied");
				} else {
					const code = `stub-code-${crypto.randomBytes(6).toString("hex")}`;
					codes.set(code, url.searchParams.get("redirect_uri"));
					redirect.searchParams.set("code", code);
				}
				if (url.searchParams.get("state") != null) redirect.searchParams.set("state", url.searchParams.get("state"));
				res.writeHead(302, {Location: redirect.toString()});
				res.end();
				return;
			}

			// ---- トークンの取得・更新(値はURLに載る) ----
			if (url.pathname === "/v1/oauth/token" && req.method === "POST") {
				const q = url.searchParams;
				if (q.get("client_id") !== CLIENT_ID || q.get("client_secret") !== CLIENT_SECRET) {
					send(res, 401, {error: "invalid_client"});
					return;
				}
				if (q.get("grant_type") === "authorization_code") {
					const redirectUri = codes.get(q.get("code"));
					codes.delete(q.get("code"));
					if (redirectUri == null || redirectUri !== q.get("redirect_uri")) {
						send(res, 400, {error: "invalid_grant", error_description: "invalid authorization code"});
						return;
					}
					send(res, 200, issueTokens());
					return;
				}
				if (q.get("grant_type") === "refresh_token") {
					const refresh = q.get("refresh_token");
					if (control.refreshFails || !refreshTokens.has(refresh)) {
						send(res, 400, {error: "invalid_grant", error_description: "invalid refresh token"});
						return;
					}
					// 更新するたびに、古い更新用トークンは使えなくなる(本物と同じ)
					refreshTokens.delete(refresh);
					send(res, 200, issueTokens());
					return;
				}
				send(res, 400, {error: "unsupported_grant_type"});
				return;
			}
			if (url.pathname === "/v1/oauth/revoke" && req.method === "POST") {
				accessTokens.delete(url.searchParams.get("access_token"));
				revoked++;
				send(res, 204, null);
				return;
			}

			// ---- ここから先はアクセストークンが要る ----
			if (!authorized(req)) {
				send(res, 401, {code: "tokenNotProvided", message: "Authorization failed", status: 401});
				return;
			}
			if (url.pathname === "/v1/oauth-token" && req.method === "GET") {
				send(res, 200, {type: "token", team: {type: "team", ...TEAM}, user: {type: "user", ...USER}, createdBy: {type: "user", ...USER}, scopes: ["boards:read", "boards:write"]});
				return;
			}
			if (url.pathname === "/v2/boards" && req.method === "GET") {
				const teamId = url.searchParams.get("team_id");
				const search = url.searchParams.get("query");
				const data = boards
					.filter((board) => teamId == null || board.team.id === teamId)
					.filter((board) => !search || board.name.includes(search))
					.map((board) => ({...board, type: "board", viewLink: `https://miro.com/app/board/${board.id}/`}));
				send(res, 200, {data, total: data.length, size: data.length, offset: 0, limit: 50});
				return;
			}
			const board = /^\/v2\/boards\/([^/]+)$/.exec(url.pathname);
			if (board && req.method === "GET") {
				const found = boards.find((b) => b.id === decodeURIComponent(board[1]));
				if (found == null) {
					send(res, 404, {code: "boardNotFound", message: "Board not found", status: 404});
					return;
				}
				send(res, 200, {...found, type: "board", viewLink: `https://miro.com/app/board/${found.id}/`});
				return;
			}
			send(res, 404, {code: "notFound", message: `stub: ${req.method} ${url.pathname}`, status: 404});
		});
	});
	server.listen(port, "127.0.0.1", () => resolve({server, port: server.address().port}));
});
