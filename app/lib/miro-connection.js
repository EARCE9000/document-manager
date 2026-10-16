/*!
 * miro-connection.js : Miro との連携(アプリの値と、書き込みに使うアカウントのトークン)を預かる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- 何をするか ----
 * Document Manager は、管理者が1回「Miroと連携」した Miro のアカウントの権限で、ボードへ資料を
 * 出し入れする(利用者ひとりずつは連携しない。新しい版を上げた人が Miro と連携しているとは限らず、
 * 出しっぱなしの自動の反映が止まってしまうため)。連携は1つだけで、貼り先のボードも1枚に決める。
 *
 * ---- アプリの値(クライアントID・シークレット)の受け取り方 ----
 * 次の順で探し、最初に見つかったものを使う。
 *   1. 環境変数 MIRO_CLIENT_ID / MIRO_CLIENT_SECRET
 *      クラウド(AWS の Secrets Manager、GCP の Secret Manager、Azure の Key Vault など)の秘密情報の
 *      保管庫から、コンテナへ環境変数として渡す形。台数が増えても全台に同じ値が渡り、誰がいつ読んだかも
 *      保管庫の側に残る。こちらがあるときは、管理画面からは変えられない
 *   2. 管理画面で入力した値(app_settings に暗号化して保存)
 *      小さな環境で、サーバーの設定ファイルを書き換えずに済ませたいとき用。シークレットは保存後に表示しない
 * どちらも無い環境では、管理画面に入力欄が出るだけで、利用者向けの画面には何も出ない。
 *
 *   MIRO_REDIRECT_URI  許可のあとの戻り先。省略時は公開URL(PUBLIC_ORIGIN、無ければ受けたリクエスト)+
 *                      api/miro/callback。ロードバランサーやCDNの後ろでは、サーバーから見えるURLが公開URLと
 *                      違うことがあるので、PUBLIC_ORIGIN か MIRO_REDIRECT_URI を設定する
 *
 * ---- トークンの保管 ----
 * アクセストークンは1時間、更新用トークンは60日で切れ、更新のたびに入れ替わる。環境変数には
 * 置けないため、データベースに**暗号化して**持つ(AES-256-GCM。鍵は SESSION_SECRET から、この用途
 * だけの値を派生させる)。**全台で SESSION_SECRET を同じにすること**(違うと、ほかの台が保存した
 * トークンを読めない)。SESSION_SECRET を変えたときは連携し直す。トークンは画面にもAPIの応答にも出さない。
 *
 * ---- 複数台での更新 ----
 * 更新用トークンは1回使うと無効になる。2台が同時に更新すると、遅れた方は「無効なトークン」と言われ、
 * 連携が切れたと誤って判断してしまう。そこで、更新する前にデータベースの上で順番を取り(期限つき)、
 * 取れた1台だけが更新する。取れなかった台は、更新が書き込まれるのを待って、それを読んで使う。
 * 順番を取った台が途中で落ちても、期限が過ぎればほかの台が取り直せる。
 */

const crypto = require("crypto");
const os = require("os");
const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");
const Miro = require("./miro-client.js");

const ENV_CLIENT_ID = process.env.MIRO_CLIENT_ID || "";
const ENV_CLIENT_SECRET = process.env.MIRO_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.MIRO_REDIRECT_URI || "";

// 期限のこれだけ前になったら、使う前に更新しておく(呼び出しの途中で切れないように)
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// 更新用トークンの寿命(Miro の資料の値。応答に期限が無いので、こちらで数える)
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
// 許可の画面へ行って戻るまでの猶予
const STATE_TTL_MS = 10 * 60 * 1000;
// 更新の順番を持っていられる時間。Miro の応答待ちの上限(既定30秒)より長くする
const REFRESH_LOCK_MS = Number(process.env.MIRO_REFRESH_LOCK_SECONDS || 45) * 1000;
// 順番が取れなかった台が、更新の結果を待つ上限と間隔
const REFRESH_WAIT_MS = REFRESH_LOCK_MS + 5000;
const REFRESH_POLL_MS = 250;

// この台の名前(順番を誰が持っているかの記録用。ログで、どの台が更新したか追えるように)
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// 用途ごとに鍵を分ける(暗号化の鍵と、許可の画面とのやりとりの署名の鍵は混ぜない)
const TOKEN_KEY = crypto.createHash("sha256").update(`miro-token:${SECRET}`).digest();
const STATE_KEY = crypto.createHash("sha256").update(`miro-oauth-state:${SECRET}`).digest();

// Miro のクライアントIDは数字だけ。シークレットは英数字の並び(貼り損ねで空白や引用符が混ざるのを弾く)
const CLIENT_ID_PATTERN = /^\d{10,30}$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
module.exports.CLIENT_ID_PATTERN = CLIENT_ID_PATTERN;
module.exports.CLIENT_SECRET_PATTERN = CLIENT_SECRET_PATTERN;

const miroError = (message, status, extra = {}) => Object.assign(new Miro.MiroError(message, {status}), extra);

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

// ---- アプリの値 ----

const SETTING_CLIENT_ID = "miro.client_id";
const SETTING_CLIENT_SECRET = "miro.client_secret";
const SQL_GET_SETTING = `SELECT value, updated_by, updated_at FROM app_settings WHERE key = ?`;
const SQL_UPSERT_SETTING = `
	INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (@key, @value, @updated_by, @updated_at)
	ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`;
const SQL_DELETE_SETTING = `DELETE FROM app_settings WHERE key = ?`;

/**
 * いま使うアプリの値。環境変数が優先。どちらにも無ければ null。
 * @returns {Promise<{clientId: string, clientSecret: string, source: "env"|"settings", updatedBy?: string, updatedAt?: string}|null>}
 */
const credentials = async () => {
	if (ENV_CLIENT_ID !== "" && ENV_CLIENT_SECRET !== "") return {clientId: ENV_CLIENT_ID, clientSecret: ENV_CLIENT_SECRET, source: "env"};
	let id = null;
	let secret = null;
	try {
		id = await ds.get(SQL_GET_SETTING, [SETTING_CLIENT_ID]);
		secret = await ds.get(SQL_GET_SETTING, [SETTING_CLIENT_SECRET]);
	} catch (err) {
		// 設定が読めないだけで画面全体を落とさない(移行直後など)
		logger.warn({err: err.message}, "Miro のアプリの値を読めませんでした");
		return null;
	}
	const clientSecret = decrypt(secret?.value);
	if (id?.value == null || clientSecret == null) return null;
	return {clientId: id.value, clientSecret, source: "settings", updatedBy: secret.updated_by ?? null, updatedAt: secret.updated_at ?? null};
};

/** 連携の機能が使える構成か(アプリの値がそろっているか) */
const isConfigured = async () => (await credentials()) != null;
module.exports.isConfigured = isConfigured;

/** アプリの値が環境変数で決まっているか(管理画面からは変えられない) */
module.exports.credentialsFromEnv = () => ENV_CLIENT_ID !== "" && ENV_CLIENT_SECRET !== "";

/**
 * 管理画面からアプリの値を保存する。クライアントIDが変わったら、それまでの連携は別のアプリのものなので消す
 * (シークレットだけの入れ替え=ローテーションなら、連携はそのまま使える)。
 */
module.exports.saveCredentials = async ({clientId, clientSecret}, user) => {
	if (module.exports.credentialsFromEnv()) throw miroError("アプリの値は環境変数で設定されているため、画面からは変えられません", 409);
	if (!CLIENT_ID_PATTERN.test(clientId)) throw miroError("クライアントIDの形が違います(数字だけの値です)", 400);
	if (!CLIENT_SECRET_PATTERN.test(clientSecret)) throw miroError("クライアントシークレットの形が違います(英数字の並びです。空白や引用符が混ざっていないか確かめてください)", 400);
	const previous = await credentials();
	const now = new Date().toISOString();
	await ds.run(SQL_UPSERT_SETTING, {key: SETTING_CLIENT_ID, value: clientId, updated_by: user, updated_at: now});
	await ds.run(SQL_UPSERT_SETTING, {key: SETTING_CLIENT_SECRET, value: encrypt(clientSecret), updated_by: user, updated_at: now});
	if (previous != null && previous.clientId !== clientId) await ds.run(SQL_DELETE);
	logger.info({audit: "miro_credentials_saved", user, clientIdChanged: previous?.clientId !== clientId}, "audit");
};

/** 管理画面で保存したアプリの値を消す(連携も使えなくなるので消す) */
module.exports.clearCredentials = async (user) => {
	if (module.exports.credentialsFromEnv()) throw miroError("アプリの値は環境変数で設定されているため、画面からは消せません", 409);
	await module.exports.disconnect(user).catch(() => {});
	await ds.run(SQL_DELETE_SETTING, [SETTING_CLIENT_ID]);
	await ds.run(SQL_DELETE_SETTING, [SETTING_CLIENT_SECRET]);
	logger.info({audit: "miro_credentials_cleared", user}, "audit");
};

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

module.exports.authorizeUrl = async ({redirectUri, state}) => {
	const creds = await credentials();
	if (creds == null) throw miroError("Miro のアプリの値が設定されていません", 404);
	return Miro.authorizeUrl({clientId: creds.clientId, redirectUri, state});
};

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
		last_error = NULL, last_error_at = NULL, refresh_lock_owner = NULL, refresh_lock_until = NULL
`;
// 更新の結果を書く。順番を持っている台だけが書ける(順番を失った台の古い結果で上書きしない)
const SQL_UPDATE_TOKENS = `
	UPDATE miro_connection SET access_token = @access_token, refresh_token = @refresh_token, access_expires_at = @access_expires_at,
		refresh_expires_at = @refresh_expires_at, updated_at = @updated_at, last_error = NULL, last_error_at = NULL,
		refresh_lock_owner = NULL, refresh_lock_until = NULL
	WHERE id = 1 AND refresh_lock_owner = @owner
`;
// 順番を取る。誰も持っていないか、持っていた台の期限が過ぎていれば取れる
const SQL_TAKE_LOCK = `
	UPDATE miro_connection SET refresh_lock_owner = @owner, refresh_lock_until = @until
	WHERE id = 1 AND (refresh_lock_owner IS NULL OR refresh_lock_until IS NULL OR refresh_lock_until < @now)
`;
const SQL_RELEASE_LOCK = `UPDATE miro_connection SET refresh_lock_owner = NULL, refresh_lock_until = NULL WHERE id = 1 AND refresh_lock_owner = @owner`;
// アクセストークンを期限切れ扱いにする(期限の前に取り消されていた=401のとき、次は更新させる)
const SQL_EXPIRE_ACCESS = `UPDATE miro_connection SET access_expires_at = @past WHERE id = 1 AND access_token = @access_token`;
const SQL_UPDATE_BOARD = `UPDATE miro_connection SET board_id = @board_id, board_name = @board_name, board_url = @board_url, updated_at = @updated_at WHERE id = 1`;
const SQL_UPDATE_ERROR = `UPDATE miro_connection SET last_error = @last_error, last_error_at = @last_error_at WHERE id = 1`;
const SQL_DELETE = `DELETE FROM miro_connection WHERE id = 1`;

const expiresAt = (seconds) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);

/**
 * 連携の状態(トークン・シークレットは含めない。画面・APIの応答に出してよいものだけ)。
 */
module.exports.status = async () => {
	const creds = await credentials();
	const base = {
		configured: creds != null,
		// アプリの値をどこから受け取っているか(env: 環境変数 / settings: 管理画面 / null: 未設定)。
		// クライアントIDは秘密ではないので出す(Miro の開発者ハブの値と見比べられるように)
		credentials: creds == null
			? {source: null, editable: !module.exports.credentialsFromEnv()}
			: {source: creds.source, clientId: creds.clientId, editable: creds.source !== "env", updatedBy: creds.updatedBy ?? null, updatedAt: creds.updatedAt ?? null}
	};
	if (creds == null) return {...base, connected: false};
	const row = await ds.get(SQL_SELECT);
	if (row == null) return {...base, connected: false};
	return {
		...base,
		connected: true,
		// トークンが読めない(SESSION_SECRET が変わった・台ごとに違う)ときは、連携し直してもらう
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
	const creds = await credentials();
	if (creds == null) throw miroError("Miro のアプリの値が設定されていません", 404);
	const token = await Miro.exchangeCode({clientId: creds.clientId, clientSecret: creds.clientSecret, code, redirectUri});
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

const RECONNECT_MESSAGE = "Miro との連携が切れました(許可が取り消されたか、長く使われず期限が切れました)。管理画面から連携し直してください";

/** この台が順番を取ったうえで、トークンを更新する。成功したら新しいアクセストークンを返す */
const refreshAsOwner = async (row) => {
	const creds = await credentials();
	if (creds == null) throw miroError("Miro のアプリの値が設定されていません", 404, {needsReconnect: true});
	const refreshToken = decrypt(row.refresh_token);
	if (refreshToken == null) {
		await ds.run(SQL_RELEASE_LOCK, {owner: INSTANCE_ID});
		const message = "Miro との連携を読み取れません(SESSION_SECRET が変わったか、台ごとに違います)。管理画面から連携し直してください";
		await markError(message);
		throw miroError(message, 401, {needsReconnect: true});
	}
	let token;
	try {
		token = await Miro.refresh({clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken});
	} catch (err) {
		await ds.run(SQL_RELEASE_LOCK, {owner: INSTANCE_ID});
		// 取り消された・期限切れ(400/401)は、連携し直すしかない。通信の失敗なら次の機会にまた試す
		if (err.status === 400 || err.status === 401) {
			await markError(RECONNECT_MESSAGE);
			throw miroError(RECONNECT_MESSAGE, 401, {needsReconnect: true});
		}
		throw err;
	}
	const written = await ds.run(SQL_UPDATE_TOKENS, {
		owner: INSTANCE_ID,
		access_token: encrypt(token.access_token),
		// 新しい更新用トークンが返らなかったときは、手元のものを使い続ける
		refresh_token: encrypt(token.refresh_token ?? refreshToken),
		access_expires_at: expiresAt(token.expires_in),
		refresh_expires_at: token.refresh_token ? new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString() : row.refresh_expires_at,
		updated_at: new Date().toISOString()
	});
	if (Number(written?.changes ?? written?.rowCount ?? 1) === 0) {
		// 順番の期限が過ぎて、ほかの台に取られていた(Miro の応答が極端に遅かった)。この結果は書けないが、
		// 受け取ったアクセストークン自体は有効なので、今回の呼び出しには使う
		logger.warn({instance: INSTANCE_ID}, "Miro のトークンを更新しましたが、順番の期限が過ぎていたため保存しませんでした");
	} else {
		logger.info({instance: INSTANCE_ID}, "Miro のアクセストークンを更新しました");
	}
	return token.access_token;
};

/** ほかの台が更新し終えるのを待ち、書き込まれた新しいアクセストークンを返す */
const waitForOtherRefresh = async (previousAccess) => {
	const deadline = Date.now() + REFRESH_WAIT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
		const row = await ds.get(SQL_SELECT);
		if (row == null) throw miroError("Miro と連携していません。管理画面から連携してください", 409, {needsReconnect: true});
		if (row.last_error != null) throw miroError(row.last_error, 401, {needsReconnect: true});
		// ほかの台が更新したばかりのトークンは、期限が切れていなければそのまま使う
		// (期限が近いからといってここで更新し直すと、更新が台の数だけ重なる)
		const access = decrypt(row.access_token);
		const expires = row.access_expires_at ? Date.parse(row.access_expires_at) : Infinity;
		if (access != null && row.access_token !== previousAccess && expires > Date.now()) return access;
		// 順番を持っていた台が落ちて、期限が過ぎた。こちらで取り直す
		if (row.refresh_lock_owner == null || Date.parse(row.refresh_lock_until ?? 0) < Date.now()) return null;
	}
	throw miroError("Miro のトークンの更新を待ちきれませんでした(しばらくしてからやり直してください)", 503);
};

// 1つの台の中では、更新を1本にまとめる(順番取りの前に、同じ台の中で重ならないように)
let refreshing = null;

const refreshTokens = async () => {
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await ds.get(SQL_SELECT);
		if (row == null) throw miroError("Miro と連携していません。管理画面から連携してください", 409, {needsReconnect: true});
		const now = new Date();
		const taken = await ds.run(SQL_TAKE_LOCK, {owner: INSTANCE_ID, until: new Date(now.getTime() + REFRESH_LOCK_MS).toISOString(), now: now.toISOString()});
		if (Number(taken?.changes ?? taken?.rowCount ?? 0) > 0) {
			// 順番を取れた。取るまでの間にほかの台が更新し終えていたら、それを使う
			const fresh = await ds.get(SQL_SELECT);
			const expires = fresh.access_expires_at ? Date.parse(fresh.access_expires_at) : Infinity;
			if (fresh.access_token !== row.access_token && decrypt(fresh.access_token) != null && expires > Date.now()) {
				await ds.run(SQL_RELEASE_LOCK, {owner: INSTANCE_ID});
				return decrypt(fresh.access_token);
			}
			return refreshAsOwner(fresh);
		}
		const access = await waitForOtherRefresh(row.access_token);
		if (access != null) return access;
	}
	throw miroError("Miro のトークンを更新できませんでした(しばらくしてからやり直してください)", 503);
};

/**
 * Miro を呼ぶためのアクセストークン。期限が近ければ更新してから返す。
 * 連携していない・切れているときは例外(needsReconnect が真)。
 */
const getAccessToken = async () => {
	if (!(await isConfigured())) throw miroError("Miro のアプリの値が設定されていません", 404, {needsReconnect: true});
	const row = await ds.get(SQL_SELECT);
	if (row == null) throw miroError("Miro と連携していません。管理画面から連携してください", 409, {needsReconnect: true});
	if (row.last_error != null) throw miroError(row.last_error, 401, {needsReconnect: true});
	const access = decrypt(row.access_token);
	const expires = row.access_expires_at ? Date.parse(row.access_expires_at) : Infinity;
	if (access != null && expires - Date.now() > REFRESH_MARGIN_MS) return access;
	if (refreshing == null) {
		refreshing = refreshTokens().finally(() => {
			refreshing = null;
		});
	}
	return refreshing;
};
module.exports.getAccessToken = getAccessToken;

/**
 * Miro を呼ぶ。アクセストークンが期限の前に無効になっていた(401)ときは、1回だけ更新してやり直す。
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
		// 使ったトークンが今も保存されているものなら、期限切れ扱いにして次で更新させる
		// (ほかの台がすでに入れ替えていれば何もしない。次の getAccessToken がそれを使う)
		if (decrypt(row.access_token) === token) {
			await ds.run(SQL_EXPIRE_ACCESS, {past: new Date(0).toISOString(), access_token: row.access_token});
		}
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

module.exports.INSTANCE_ID = INSTANCE_ID;
