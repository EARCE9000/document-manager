/*!
 * miro-client.js : Miro の REST API を呼ぶ(OAuth のやりとりと、ボードの読み書き)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Document Manager が Miro の「アプリ」(開発者ハブで登録したもの)として Miro を呼ぶための、
 * いちばん下の層。トークンの保管や更新の判断はしない(lib/miro-connection.js が行う)。
 *
 * 接続先は環境変数で差し替えられる(テストでは仮のサーバーへ向ける):
 *   MIRO_API_URL   既定 https://api.miro.com
 *   MIRO_AUTH_URL  既定 https://miro.com      (利用者が許可する画面)
 *
 * OAuth の手順は Miro の資料に合わせている(https://developers.miro.com/reference/authorization-and-authentication、
 * https://developers.miro.com/reference/get-new-access-token-using-refresh-token)。
 *   - アクセストークンは1時間、更新用トークンは60日で切れる(アプリを「期限あり」で作った場合)
 *   - 更新するたびに、新しい更新用トークンが返る(古いものは使えなくなる)
 *   - トークンの取得・更新の値は、本体ではなくURLに載せる(資料の指定どおり)
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const API_URL = (process.env.MIRO_API_URL || "https://api.miro.com").replace(/\/+$/, "");
const AUTH_URL = (process.env.MIRO_AUTH_URL || "https://miro.com").replace(/\/+$/, "");
// 1回の呼び出しを待つ上限。Miro が詰まっていても、画面や同期の処理を止め続けない
const TIMEOUT_MS = Number(process.env.MIRO_TIMEOUT_SECONDS || 30) * 1000;

/** Miro が返した失敗。status は Miro の HTTP ステータス(通信できなかったときは 0) */
class MiroError extends Error {
	constructor(message, {status = 0, code = null} = {}) {
		super(message);
		this.name = "MiroError";
		this.status = status;
		this.code = code;
	}
}

/**
 * Miro を呼ぶ。応答が JSON ならその中身を、本体が無ければ null を返す。
 * @param {string} method
 * @param {string} url 完全なURL
 * @param {{token?: string, body?: object, form?: FormData}} [options]
 */
const call = async (method, url, {token, body, form} = {}) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: {
				Accept: "application/json",
				...(token ? {Authorization: `Bearer ${token}`} : {}),
				...(body !== undefined ? {"Content-Type": "application/json"} : {})
			},
			body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
			signal: controller.signal
		});
	} catch (err) {
		throw new MiroError(err.name === "AbortError"
			? `Miro が${TIMEOUT_MS / 1000}秒以内に応答しませんでした`
			: `Miro に接続できません: ${err.message}`);
	} finally {
		clearTimeout(timer);
	}
	const text = await res.text().catch(() => "");
	let json = null;
	try {
		json = text === "" ? null : JSON.parse(text);
	} catch {
		json = null;
	}
	if (!res.ok) {
		// Miro の失敗の形は API によって違う({message} / {error, error_description} / {code, message})
		const detail = json?.message || json?.error_description || json?.error || text.slice(0, 200) || res.statusText;
		throw new MiroError(`Miro がエラーを返しました(HTTP ${res.status}): ${detail}`, {status: res.status, code: json?.code ?? json?.error ?? null});
	}
	return json;
};

const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();

/** 利用者が許可する画面のURL */
module.exports.authorizeUrl = ({clientId, redirectUri, state, teamId}) =>
	`${AUTH_URL}/oauth/authorize?${query({response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, team_id: teamId})}`;

/**
 * 許可の画面から戻ってきたコードを、トークンに引き換える。
 * @returns {Promise<{access_token: string, refresh_token?: string, expires_in?: number, team_id: string, user_id: string, scope: string}>}
 */
module.exports.exchangeCode = ({clientId, clientSecret, code, redirectUri}) =>
	call("POST", `${API_URL}/v1/oauth/token?${query({grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri})}`);

/** 更新用トークンで、新しいアクセストークン(と新しい更新用トークン)を受け取る */
module.exports.refresh = ({clientId, clientSecret, refreshToken}) =>
	call("POST", `${API_URL}/v1/oauth/token?${query({grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken})}`);

/**
 * トークンが誰の・どのチームのものか。
 * @returns {Promise<{team: {id: string, name: string}, user: {id: string, name: string}, scopes: string[]}>}
 */
module.exports.tokenContext = (accessToken) => call("GET", `${API_URL}/v1/oauth-token`, {token: accessToken});

/** トークンを取り消す(連携の解除)。失敗しても解除そのものは進めたいので、呼ぶ側で受け止める */
module.exports.revoke = (accessToken) => call("POST", `${API_URL}/v1/oauth/revoke?${query({access_token: accessToken})}`);

/**
 * チームのボードの一覧(名前で絞れる)。
 * @returns {Promise<{data: Array<{id: string, name: string, viewLink?: string}>, total?: number}>}
 */
module.exports.listBoards = (accessToken, {teamId, search, limit = 50, offset = 0} = {}) =>
	call("GET", `${API_URL}/v2/boards?${query({team_id: teamId, query: search, limit, offset})}`, {token: accessToken});

/** ボード1枚の情報 */
module.exports.getBoard = (accessToken, boardId) =>
	call("GET", `${API_URL}/v2/boards/${encodeURIComponent(boardId)}`, {token: accessToken});

module.exports.call = call;
module.exports.MiroError = MiroError;
module.exports.API_URL = API_URL;

logger.debug({API_URL, AUTH_URL}, "miro client ready");
