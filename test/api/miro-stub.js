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
 *   GET  /__items                               ボードの項目(種類・位置・枠・題名・中身の大きさ)
 *   POST /__control {"failUploads": n}          次の n 回のファイルの作成・差し替えを 500 で断る
 *   POST /__control {"deleteItem": "<id>"}      Miro で人が消したのと同じ(項目を消す)
 *   POST /__control {"moveItem": {"id": "...", "x": 1, "y": 2}}  Miro で人が動かしたのと同じ
 *
 * ボードの項目は、本物と同じく位置を中心で持ち、枠に入れたものは枠の左上からの位置になる。
 * ファイルの差し替えで幅を渡さないと、元のファイルの大きさに戻る(本物で確かめた振る舞い)。
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
	// ボードの項目: id → {id, type, boardId, data, position, geometry, parent, size, contentType}
	let items = new Map();
	let nextItemId = 3458764600000100000n;
	let failUploads = 0;

	const reset = () => {
		control = {};
		codes = new Map();
		accessTokens = new Map();
		refreshTokens = new Set();
		boards = initialBoards();
		issued = 0;
		revoked = 0;
		items = new Map();
		failUploads = 0;
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
		const chunks = [];
		req.on("data", (chunk) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			const buffer = Buffer.concat(chunks);
			const raw = buffer.toString("utf8");
			if (!url.pathname.startsWith("/__")) requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams)});

			if (url.pathname === "/__control" && req.method === "POST") {
				const body = raw ? JSON.parse(raw) : {};
				if (body.reset) reset();
				if (body.expireAccess) for (const key of accessTokens.keys()) accessTokens.set(key, 0);
				if (body.failUploads != null) failUploads = Number(body.failUploads);
				if (body.deleteItem != null) items.delete(String(body.deleteItem));
				if (body.moveItem != null && items.has(String(body.moveItem.id))) {
					const item = items.get(String(body.moveItem.id));
					item.position = {...item.position, x: body.moveItem.x, y: body.moveItem.y};
				}
				delete body.failUploads;
				delete body.deleteItem;
				delete body.moveItem;
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
			if (url.pathname === "/__items") {
				send(res, 200, [...items.values()]);
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
			// ---- ボードの項目 ----
			const itemPath = /^\/v2\/boards\/([^/]+)\/(frames|documents|images|texts|shapes|groups|items)(?:\/([^/]+))?$/.exec(url.pathname);
			if (itemPath) {
				const boardId = decodeURIComponent(itemPath[1]);
				const kind = itemPath[2];
				const id = itemPath[3] != null ? decodeURIComponent(itemPath[3]) : null;
				if (!boards.some((b) => b.id === boardId)) {
					send(res, 404, {code: "boardNotFound", message: "Board not found", status: 404});
					return;
				}
				const typeOf = {frames: "frame", documents: "document", images: "image", texts: "text", shapes: "shape", groups: "group"};
				// multipart の data(JSON)と resource(ファイル)を取り出す
				const multipart = () => {
					const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"] || ""))?.[1];
					if (!boundary) return null;
					const parts = buffer.toString("latin1").split("--" + boundary).slice(1, -1);
					const result = {};
					for (const part of parts) {
						const [head, ...rest] = part.split("\r\n\r\n");
						const body = rest.join("\r\n\r\n").replace(/\r\n$/, "");
						const name = /name="([^"]+)"/.exec(head)?.[1];
						if (name === "data") result.data = JSON.parse(Buffer.from(body, "latin1").toString("utf8"));
						if (name === "resource") result.resource = {size: Buffer.byteLength(body, "latin1"), contentType: /Content-Type: (.+)/i.exec(head)?.[1]?.trim()};
					}
					return result;
				};
				const json = () => (raw ? JSON.parse(raw) : {});
				const toResponse = (item) => ({
					...item,
					position: item.position && {...item.position, origin: "center", relativeTo: item.parent ? "parent_top_left" : "canvas_center"},
					links: {self: url.toString()}
				});
				// ファイルの大きさから決まる高さ(本物は中身の縦横比で決まる。ここでは A4 縦とみなす)
				const naturalWidth = 960;
				const heightFor = (width) => width * 297 / 210;

				if (req.method === "POST" && kind !== "items") {
					if ((kind === "documents" || kind === "images") && failUploads > 0) {
						failUploads--;
						send(res, 500, {type: "error", code: "3.0000", message: "Internal error occurred", status: 500});
						return;
					}
					const newId = String(nextItemId++);
					const body = kind === "documents" || kind === "images" ? multipart() : json();
					const input = body?.data && (kind === "documents" || kind === "images") ? body.data : body;
					if (kind === "groups") {
						const members = input?.data?.items ?? [];
						if (members.some((m) => !items.has(String(m)))) {
							send(res, 400, {message: "Item not found"});
							return;
						}
						items.set(newId, {id: newId, type: "group", boardId, data: {items: members}});
						send(res, 201, {id: newId, type: "group", data: {items: members}});
						return;
					}
					const parentId = input?.parent?.id ?? null;
					if (parentId != null && (!items.has(parentId) || items.get(parentId).type !== "frame")) {
						send(res, 400, {message: "Parent frame not found"});
						return;
					}
					const width = input?.geometry?.width ?? (kind === "frames" ? 800 : naturalWidth);
					const height = kind === "frames" || kind === "shapes" ? (input?.geometry?.height ?? 600) : kind === "texts" ? 50 : heightFor(width);
					// 本物と同じく、図形は幅・高さとも 8 以上、枠線の太さは 1 以上(0 は断られる)
					if (kind === "shapes" && (width < 8 || height < 8)) {
						send(res, 400, {message: "Unable to complete operation because of the validation errors."});
						return;
					}
					if (kind === "shapes" && input?.style?.borderWidth != null && Number(input.style.borderWidth) < 1) {
						send(res, 400, {message: "Invalid parameters"});
						return;
					}
					const item = {
						id: newId, type: typeOf[kind], boardId,
						data: kind === "documents" || kind === "images" ? {title: input?.title ?? null} : (input?.data ?? {}),
						position: {x: input?.position?.x ?? 0, y: input?.position?.y ?? 0},
						geometry: {width, height},
						parent: parentId ? {id: parentId} : null,
						...(input?.style ? {style: input.style} : {}),
						...(body?.resource ? {size: body.resource.size, contentType: body.resource.contentType} : {})
					};
					items.set(newId, item);
					send(res, 201, toResponse(item));
					return;
				}
				if (id == null) {
					if (req.method === "GET" && kind === "items") {
						const parent = url.searchParams.get("parent_item_id");
						const type = url.searchParams.get("type");
						const data = [...items.values()].filter((i) => i.boardId === boardId && i.type !== "group")
							.filter((i) => parent == null || i.parent?.id === parent)
							.filter((i) => type == null || i.type === type)
							.map(toResponse);
						send(res, 200, {data, total: data.length, size: data.length, limit: 50});
						return;
					}
					send(res, 405, {message: "method not allowed"});
					return;
				}
				const item = items.get(id);
				if (item == null || item.boardId !== boardId || (kind !== "items" && typeOf[kind] !== item.type)) {
					send(res, 404, {type: "error", code: "2.0703", message: "Item not found", status: 404});
					return;
				}
				if (req.method === "GET") {
					send(res, 200, toResponse(item));
					return;
				}
				if (req.method === "DELETE") {
					items.delete(id);
					if (item.type === "group" && url.searchParams.get("delete_items") === "true") for (const member of item.data.items) items.delete(String(member));
					send(res, 204, null);
					return;
				}
				if (req.method === "PATCH") {
					if ((kind === "documents" || kind === "images") && String(req.headers["content-type"] || "").startsWith("multipart/")) {
						if (failUploads > 0) {
							failUploads--;
							send(res, 500, {type: "error", code: "3.0000", message: "Internal error occurred", status: 500});
							return;
						}
						const body = multipart();
						// 幅を渡さないと、元のファイルの大きさに戻る(本物と同じ)
						const width = body.data?.geometry?.width ?? naturalWidth;
						item.geometry = {width, height: heightFor(width)};
						if (body.data?.title != null) item.data = {...item.data, title: body.data.title};
						if (body.resource) Object.assign(item, {size: body.resource.size, contentType: body.resource.contentType, replacedAt: Date.now()});
						send(res, 200, toResponse(item));
						return;
					}
					const body = json();
					// 本物と同じく、中の項目がはみ出す大きさには枠を縮められない(中の位置は枠の左上から)
					if (item.type === "frame" && body.geometry) {
						const width = body.geometry.width ?? item.geometry.width;
						const height = body.geometry.height ?? item.geometry.height;
						const outside = [...items.values()].some((child) => child.parent?.id === item.id
							&& (child.position.x < 0 || child.position.y < 0 || child.position.x > width || child.position.y > height));
						if (outside) {
							send(res, 400, {message: "Child item cannot be placed outside the bounds of its parent"});
							return;
						}
					}
					if (body.position) item.position = {x: body.position.x ?? item.position.x, y: body.position.y ?? item.position.y};
					if (body.parent !== undefined) item.parent = body.parent?.id ? {id: body.parent.id} : null;
					if (body.geometry) item.geometry = {...item.geometry, ...Object.fromEntries(Object.entries(body.geometry).filter(([, v]) => v != null))};
					if (body.data) item.data = {...item.data, ...body.data};
					if (body.style) item.style = {...(item.style ?? {}), ...body.style};
					send(res, 200, toResponse(item));
					return;
				}
			}
			send(res, 404, {code: "notFound", message: `stub: ${req.method} ${url.pathname}`, status: 404});
		});
	});
	server.listen(port, "127.0.0.1", () => resolve({server, port: server.address().port}));
});
