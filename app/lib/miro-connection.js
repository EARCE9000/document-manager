/*!
 * miro-connection.js : Miro との連携(書き込みに使うアカウントのトークン)を預かる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- 何をするか ----
 * Document Manager は、管理者が1回「Miroと連携」した Miro のアカウントの権限で、ボードへ資料を
 * 出し入れする(利用者ひとりずつは連携しない。新しい版を上げた人が Miro と連携しているとは限らず、
 * 出しっぱなしの自動の反映が止まってしまうため)。連携は1つだけで、貼り先のボードも1枚に決める。
 *
 * ---- 設定 ----
 *   MIRO_CLIENT_ID / MIRO_CLIENT_SECRET  Miro の開発者ハブで作ったアプリの値。**両方そろったときだけ**
 *                                        この機能が現れる(未設定の環境には何も出ない)
 *   MIRO_REDIRECT_URI                    許可のあとの戻り先。省略時は公開URL + api/miro/callback。
 *                                        Miro のアプリに登録したものと一字一句同じであること
 *
 * ---- トークンの保管 ----
 * アクセストークンは1時間、更新用トークンは60日で切れ、更新のたびに入れ替わる。環境変数には
 * 置けないため、データベースに**暗号化して**持つ(AES-256-GCM。鍵は SESSION_SECRET から、この用途
 * だけの値を派生させる)。SESSION_SECRET を変えると読めなくなるので、そのときは連携し直す。
 * トークンは画面にも API の応答にも出さない。
 *
 * 期限が近づいたら、使うときに自動で更新する。同時に2つ更新が走ると、片方が受け取った新しい
 * 更新用トークンがもう片方で無効にされるため、更新は1つのプロセスの中で1本にまとめる。
 * 更新に失敗した(取り消された・60日使われなかった)ときは連携を「切れた」状態にし、管理画面で知らせる。
 */

const crypto = require("crypto");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");
const Miro = require("./miro-client.js");

const CLIENT_ID = process.env.MIRO_CLIENT_ID || "";
const CLIENT_SECRET = process.env.MIRO_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.MIRO_REDIRECT_URI || "";

// 期限のこれだけ前になったら、使う前に更新しておく(呼び出しの途中で切れないように)
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// 更新用トークンの寿命(Miro の資料の値。応答に期限が無いので、こちらで数える)
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
// 許可の画面へ行って戻るまでの猶予
const STATE_TTL_MS = 10 * 60 * 1000;

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// 用途ごとに鍵を分ける(暗号化の鍵と、許可の画面とのやりとりの署名の鍵は混ぜない)
const TOKEN_KEY = crypto.createHash("sha256").update(`miro-token:${SECRET}`).digest();
const STATE_KEY = crypto.createHash("sha256").update(`miro-oauth-state:${SECRET}`).digest();

/** 連携の機能が使える構成か(アプリの値がそろっているか) */
const isConfigured = () => CLIENT_ID !== "" && CLIENT_SECRET !== "";
module.exports.isConfigured = isConfigured;

// ---- 暗号化 ----

const encrypt = (plain) => {
	if (plain == null) return null;
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", TOKEN_KEY, iv);
	const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
	return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
};

/** 読めない(鍵が変わった・壊れている)ときは null */
const decrypt = (stored) => {
	if (typeof stored !== "string") return null;
	const parts = stored.split(":");
	if (parts.length !== 4 || parts[0] !== "v1") return null;
	try {
		const decipher = crypto.createDecipheriv("aes-256-gcm", TOKEN_KEY, Buffer.from(parts[1], "base64url"));
		decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
	} catch {
		return null;
	}
};
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;

// ---- 許可の画面とのやりとり(state) ----
// 許可の画面から戻ってきたのが、こちらが送り出した本人であることを確かめる。署名つきの値に
// 送り出した利用者と期限を入れ、さらにセッションに覚えた乱数と照らし合わせる(server.js)

const sign = (payload) => crypto.createHmac("sha256", STATE_KEY).update(payload).digest("base64url");

/** @returns {{state: string, nonce: string}} nonce はセッションに覚えておく */
module.exports.issueState = (user) => {
	const nonce = crypto.randomBytes(16).toString("base64url");
	const payload = Buffer.from(JSON.stringify({u: user, n: nonce, e: Date.now() + STATE_TTL_MS})).toString("base64url");
	return {state: `${payload}.${sign(payload)}`, nonce};
};

/** 署名が正しく期限内なら {user, nonce}。それ以外は null */
module.exports.readState = (state) => {
	if (typeof state !== "string") return null;
	const [payload, signature] = state.split(".");
	if (!payload || !signature) return null;
	const expected = Buffer.from(sign(payload));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (typeof claims.e !== "number" || claims.e < Date.now()) return null;
		return {user: claims.u, nonce: claims.n};
	} catch {
		return null;
	}
};

/** 許可のあとの戻り先。設定が無ければ、この環境の公開URLから作る */
module.exports.redirectUri = (publicBaseUrl) => REDIRECT_URI || `${String(publicBaseUrl).replace(/\/+$/, "")}/api/miro/callback`;

module.exports.authorizeUrl = ({redirectUri, state}) => Miro.authorizeUrl({clientId: CLIENT_ID, redirectUri, state});

// ---- 保管 ----

const SQL_SELECT = `SELECT * FROM miro_connection WHERE id = 1`;
const SQL_UPSERT = `
	INSERT INTO miro_connection (id, team_id, team_name, miro_user_id, miro_user_name, access_token, refresh_token,
		access_expires_at, refresh_expires_at, scopes, board_id, board_name, board_url, connected_by, connected_at, updated_at, last_error, last_error_at)
	VALUES (1, @team_id, @team_name, @miro_user_id, @miro_user_name, @access_token, @refresh_token,
		@access_expires_at, @refresh_expires_at, @scopes, @board_id, @board_name, @board_url, @connected_by, @connected_at, @updated_at, NULL, NULL)
	ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name, miro_user_id = excluded.miro_user_id,
		miro_user_name = excluded.miro_user_name, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
		access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes,
		board_id = excluded.board_id, board_name = excluded.board_name, board_url = excluded.board_url,
		connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.updated_at,
		last_error = NULL, last_error_at = NULL
`;
const SQL_UPDATE_TOKENS = `
	UPDATE miro_connection SET access_token = @access_token, refresh_token = @refresh_token, access_expires_at = @access_expires_at,
		refresh_expires_at = @refresh_expires_at, updated_at = @updated_at, last_error = NULL, last_error_at = NULL
	WHERE id = 1
`;
const SQL_UPDATE_BOARD = `UPDATE miro_connection SET board_id = @board_id, board_name = @board_name, board_url = @board_url, updated_at = @updated_at WHERE id = 1`;
const SQL_UPDATE_ERROR = `UPDATE miro_connection SET last_error = @last_error, last_error_at = @last_error_at WHERE id = 1`;
const SQL_DELETE = `DELETE FROM miro_connection WHERE id = 1`;

const expiresAt = (seconds) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);

/**
 * 連携の状態(トークンは含めない。画面・APIの応答に出してよいものだけ)。
 */
module.exports.status = async () => {
	const base = {configured: isConfigured()};
	if (!isConfigured()) return {...base, connected: false};
	const row = await ds.get(SQL_SELECT);
	if (row == null) return {...base, connected: false};
	return {
		...base,
		connected: true,
		// トークンが読めない(SESSION_SECRET が変わった)ときは、連携し直してもらう
		usable: decrypt(row.refresh_token ?? row.access_token) != null && row.last_error == null,
		team: {id: row.team_id, name: row.team_name},
		miroUser: {id: row.miro_user_id, name: row.miro_user_name},
		scopes: row.scopes ? String(row.scopes).split(/[\s,]+/).filter(Boolean) : [],
		board: row.board_id ? {id: row.board_id, name: row.board_name, url: row.board_url} : null,
		accessExpiresAt: row.access_expires_at,
		refreshExpiresAt: row.refresh_expires_at,
		connectedBy: row.connected_by,
		connectedAt: row.connected_at,
		lastError: row.last_error,
		lastErrorAt: row.last_error_at
	};
};

/**
 * 許可の画面から戻ってきたコードでトークンを受け取り、連携として保存する。
 * 連携し直した場合も、選んであったボードは同じチームなら引き継ぐ。
 */
module.exports.connect = async ({code, redirectUri, user}) => {
	const token = await Miro.exchangeCode({clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri});
	if (!token?.access_token) throw new Miro.MiroError("Miro からトークンを受け取れませんでした");
	const context = await Miro.tokenContext(token.access_token);
	const previous = await ds.get(SQL_SELECT);
	const sameTeam = previous != null && String(previous.team_id) === String(context?.team?.id ?? token.team_id);
	const now = new Date().toISOString();
	await ds.run(SQL_UPSERT, {
		team_id: String(context?.team?.id ?? token.team_id ?? ""),
		team_name: context?.team?.name ?? null,
		miro_user_id: String(context?.user?.id ?? token.user_id ?? ""),
		miro_user_name: context?.user?.name ?? null,
		access_token: encrypt(token.access_token),
		refresh_token: encrypt(token.refresh_token ?? null),
		access_expires_at: expiresAt(token.expires_in),
		refresh_expires_at: token.refresh_token ? new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString() : null,
		scopes: Array.isArray(context?.scopes) ? context.scopes.join(" ") : (token.scope ?? null),
		board_id: sameTeam ? previous.board_id : null,
		board_name: sameTeam ? previous.board_name : null,
		board_url: sameTeam ? previous.board_url : null,
		connected_by: user,
		connected_at: now,
		updated_at: now
	});
	logger.info({audit: "miro_connected", user, team: context?.team?.id, miroUser: context?.user?.id}, "audit");
	return module.exports.status();
};

const markError = async (message) => {
	await ds.run(SQL_UPDATE_ERROR, {last_error: message, last_error_at: new Date().toISOString()}).catch(() => {});
};

// 更新は1本にまとめる(上の説明)
let refreshing = null;

const refreshTokens = async (row) => {
	const refreshToken = decrypt(row.refresh_token);
	if (refreshToken == null) {
		const message = "Miro との連携を読み取れません。管理画面から連携し直してください";
		await markError(message);
		throw Object.assign(new Miro.MiroError(message, {status: 401}), {needsReconnect: true});
	}
	let token;
	try {
		token = await Miro.refresh({clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken});
	} catch (err) {
		// 取り消された・期限切れ(400/401)は、連携し直すしかない。通信の失敗なら次の機会にまた試す
		if (err.status === 400 || err.status === 401) {
			const message = "Miro との連携が切れました(許可が取り消されたか、長く使われず期限が切れました)。管理画面から連携し直してください";
			await markError(message);
			throw Object.assign(new Miro.MiroError(message, {status: 401}), {needsReconnect: true});
		}
		throw err;
	}
	await ds.run(SQL_UPDATE_TOKENS, {
		access_token: encrypt(token.access_token),
		// 新しい更新用トークンが返らなかったときは、手元のものを使い続ける
		refresh_token: encrypt(token.refresh_token ?? refreshToken),
		access_expires_at: expiresAt(token.expires_in),
		refresh_expires_at: token.refresh_token ? new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString() : row.refresh_expires_at,
		updated_at: new Date().toISOString()
	});
	logger.info("Miro のアクセストークンを更新しました");
	return token.access_token;
};

/**
 * Miro を呼ぶためのアクセストークン。期限が近ければ更新してから返す。
 * 連携していない・切れているときは例外(needsReconnect が真)。
 */
const getAccessToken = async () => {
	if (!isConfigured()) throw Object.assign(new Miro.MiroError("Miro 連携はこの環境では使えません(MIRO_CLIENT_ID / MIRO_CLIENT_SECRET が未設定)", {status: 404}), {needsReconnect: true});
	const row = await ds.get(SQL_SELECT);
	if (row == null) throw Object.assign(new Miro.MiroError("Miro と連携していません。管理画面から連携してください", {status: 409}), {needsReconnect: true});
	const access = decrypt(row.access_token);
	const expires = row.access_expires_at ? Date.parse(row.access_expires_at) : Infinity;
	if (access != null && expires - Date.now() > REFRESH_MARGIN_MS) return access;
	if (refreshing == null) {
		refreshing = refreshTokens(row).finally(() => {
			refreshing = null;
		});
	}
	return refreshing;
};
module.exports.getAccessToken = getAccessToken;

/**
 * Miro を呼ぶ。アクセストークンが途中で無効になっていた(401)ときは、1回だけ更新してやり直す。
 * @param {(token: string) => Promise<any>} fn
 */
module.exports.withToken = async (fn) => {
	const token = await getAccessToken();
	try {
		return await fn(token);
	} catch (err) {
		if (err.status !== 401) throw err;
		const row = await ds.get(SQL_SELECT);
		if (row == null) throw err;
		// 期限の前でも取り消されていることがある。更新して1回だけやり直す
		await ds.run(SQL_UPDATE_TOKENS, {
			access_token: row.access_token, refresh_token: row.refresh_token, access_expires_at: new Date(0).toISOString(),
			refresh_expires_at: row.refresh_expires_at, updated_at: new Date().toISOString()
		});
		return fn(await getAccessToken());
	}
};

/** 貼り先のボードを決める(連携しているチームのボードであることを Miro に問い合わせて確かめる) */
module.exports.setBoard = async (boardId, user) => {
	const board = await module.exports.withToken((token) => Miro.getBoard(token, boardId));
	const status = await module.exports.status();
	if (board?.team?.id != null && status.team?.id != null && String(board.team.id) !== String(status.team.id)) {
		throw new Miro.MiroError("連携しているチームのボードではありません", {status: 400});
	}
	await ds.run(SQL_UPDATE_BOARD, {board_id: String(board.id), board_name: board.name ?? null, board_url: board.viewLink ?? null, updated_at: new Date().toISOString()});
	logger.info({audit: "miro_board_selected", user, board: board.id}, "audit");
	return module.exports.status();
};

/** 連携しているチームのボードの一覧 */
module.exports.listBoards = async ({search} = {}) => {
	const status = await module.exports.status();
	const result = await module.exports.withToken((token) => Miro.listBoards(token, {teamId: status.team?.id, search}));
	return (result?.data ?? []).map((board) => ({id: String(board.id), name: board.name ?? "", url: board.viewLink ?? null, modifiedAt: board.modifiedAt ?? null}));
};

/** 連携を解除する(Miro 側のトークンも取り消す。取り消しに失敗しても、こちらの記録は消す) */
module.exports.disconnect = async (user) => {
	const row = await ds.get(SQL_SELECT);
	if (row == null) return;
	const access = decrypt(row.access_token);
	if (access != null) {
		await Miro.revoke(access).catch((err) => logger.warn({err: err.message}, "Miro のトークンを取り消せませんでした(連携の記録は消します)"));
	}
	await ds.run(SQL_DELETE);
	logger.info({audit: "miro_disconnected", user}, "audit");
};
