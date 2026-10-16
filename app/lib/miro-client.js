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
// 一時的な失敗(混雑・Miro 側の内部エラー)のやり直し。実物の Miro で、枠の作成が数分のあいだ 500 を返し、
// そのあと何もせずに通るようになったことがある(コミュニティにも同じ報告がある)。待ち時間は少しずつ延ばす
const RETRY_DELAYS_MS = (process.env.MIRO_RETRY_DELAYS_MS || "2000,8000,30000").split(",").map(Number).filter((n) => n >= 0);
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

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
 * @param {{token?: string, body?: object, raw?: Buffer, rawType?: string}} [options]
 */
const call = async (method, url, options = {}) => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await callOnce(method, url, options);
		} catch (err) {
			const retryable = err.status === 0 || RETRYABLE.has(err.status);
			if (!retryable || attempt >= RETRY_DELAYS_MS.length || options.retry === false) throw err;
			// 混雑(429)は、Miro が待つ時間を言ってくればそれに従う
			const wait = err.retryAfterMs ?? RETRY_DELAYS_MS[attempt];
			logger.warn({status: err.status, attempt: attempt + 1, waitMs: wait, method, path: new URL(url).pathname}, "Miro の一時的な失敗。待ってやり直します");
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
};

const callOnce = async (method, url, {token, body, raw, rawType} = {}) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url, {
			method,
			headers: {
				Accept: "application/json",
				...(token ? {Authorization: `Bearer ${token}`} : {}),
				...(body !== undefined ? {"Content-Type": "application/json"} : {}),
				...(raw !== undefined ? {"Content-Type": rawType} : {})
			},
			body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
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
		const error = new MiroError(`Miro がエラーを返しました(HTTP ${res.status}): ${detail}`, {status: res.status, code: json?.code ?? json?.error ?? null});
		const retryAfter = Number(res.headers.get("retry-after"));
		if (retryAfter > 0) error.retryAfterMs = Math.min(retryAfter, 120) * 1000;
		throw error;
	}
	return json;
};

/**
 * ファイルを付けて送る(資料・画像の作成と差し替え)。
 * 付帯情報(data)は、ファイルではない JSON の部品として送る必要がある(FormData で Blob にすると
 * ファイル扱いになり、Miro が「data を読めない」と 500 を返した)。そのため multipart を自前で組む
 * @param {"POST"|"PATCH"} method
 * @param {string} url
 * @param {string} token
 * @param {{data: object, file: Buffer, fileName: string, contentType: string}} part
 */
const upload = (method, url, token, {data, file, fileName, contentType}) => {
	const boundary = `----dm-miro-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	// ファイル名は Miro に見える。日本語などは避け、拡張子だけ合わせる(中身の判定は Content-Type で行われる)
	const safeName = String(fileName || "file").replace(/[^A-Za-z0-9._-]/g, "_");
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n`
		+ `--${boundary}\r\nContent-Disposition: form-data; name="resource"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
		"utf8"
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
	return call(method, url, {token, raw: Buffer.concat([head, file, tail]), rawType: `multipart/form-data; boundary=${boundary}`});
};
module.exports.upload = upload;

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

// ---- ボードの項目 ----
// 位置(x, y)は項目の中心。parent に枠を指定すると、位置は枠の左上からになる

const boardPath = (boardId) => `${API_URL}/v2/boards/${encodeURIComponent(boardId)}`;

/** 枠(フレーム)を作る */
module.exports.createFrame = (token, boardId, {title, x, y, width, height}) =>
	call("POST", `${boardPath(boardId)}/frames`, {token, body: {data: {title, format: "custom", type: "freeform"}, position: {x, y}, geometry: {width, height}}});

/** 枠の題名・大きさ・位置を変える(位置は枠の中心) */
module.exports.updateFrame = (token, boardId, frameId, {title, width, height, x, y}) =>
	call("PATCH", `${boardPath(boardId)}/frames/${encodeURIComponent(frameId)}`, {token, body: {
		...(title != null ? {data: {title}} : {}),
		...(width != null || height != null ? {geometry: {width, height}} : {}),
		...(x != null || y != null ? {position: {x, y}} : {})
	}});

/** 項目を1つ読む(種類を問わない)。無ければ MiroError(status 404) */
module.exports.getItem = (token, boardId, itemId) => call("GET", `${boardPath(boardId)}/items/${encodeURIComponent(itemId)}`, {token});

/** ボードの項目の一覧(枠の中だけ・種類で絞れる)。続きは cursor で取る */
module.exports.listItems = (token, boardId, {type, parentId, cursor, limit = 50} = {}) =>
	call("GET", `${boardPath(boardId)}/items?${query({type, parent_item_id: parentId, cursor, limit})}`, {token});

/** 項目を動かす(位置・入れる枠)。種類を問わない */
module.exports.moveItem = (token, boardId, itemId, {x, y, parentId}) =>
	call("PATCH", `${boardPath(boardId)}/items/${encodeURIComponent(itemId)}`, {token, body: {
		position: {x, y},
		...(parentId !== undefined ? {parent: {id: parentId}} : {})
	}});

/** 項目を消す(種類を問わない) */
module.exports.deleteItem = (token, boardId, itemId) => call("DELETE", `${boardPath(boardId)}/items/${encodeURIComponent(itemId)}`, {token});

/**
 * 資料(PDF)または画像を置く。kind は "documents" か "images"
 * @param {{title: string, x: number, y: number, width: number, parentId?: string, file: Buffer, fileName: string, contentType: string}} item
 */
module.exports.createFile = (token, boardId, kind, {title, x, y, width, parentId, file, fileName, contentType}) =>
	upload("POST", `${boardPath(boardId)}/${kind}`, token, {
		data: {title, position: {x, y}, geometry: {width}, ...(parentId ? {parent: {id: parentId}} : {})},
		file, fileName, contentType
	});

/**
 * 置いてある資料・画像の中身を差し替える。位置と ID はそのまま。幅を渡さないと、元のファイルの大きさに戻る
 * (実物の Miro で確かめた)ので、いまの幅を渡す
 */
module.exports.replaceFile = (token, boardId, kind, itemId, {title, width, file, fileName, contentType}) =>
	upload("PATCH", `${boardPath(boardId)}/${kind}/${encodeURIComponent(itemId)}`, token, {
		data: {title, ...(width ? {geometry: {width}} : {})},
		file, fileName, contentType
	});

/**
 * 文字を置く。content は Miro が受け付ける HTML(<p>・<a href> など)。
 * style は Miro の文字の見た目(color・fillColor・fillOpacity・fontSize・textAlign)。省略できる
 */
module.exports.createText = (token, boardId, {content, x, y, width, parentId, style}) =>
	call("POST", `${boardPath(boardId)}/texts`, {token, body: {
		data: {content}, position: {x, y}, geometry: {width}, ...(style ? {style} : {}), ...(parentId ? {parent: {id: parentId}} : {})
	}});

/** 文字の中身・見た目を変える */
module.exports.updateText = (token, boardId, textId, {content, style}) =>
	call("PATCH", `${boardPath(boardId)}/texts/${encodeURIComponent(textId)}`, {token, body: {
		...(content != null ? {data: {content}} : {}), ...(style ? {style} : {})
	}});

/**
 * 図形を置く(区切りの線・区画の背景など)。shape は rectangle・round_rectangle・circle など。
 * style は Miro の図形の見た目(fillColor・fillOpacity・borderColor・borderWidth・borderOpacity・borderStyle・color・fontSize)。
 * Miro の REST API では重なりの順(前面・背面)を指定できず、あとから置いたものが上になるので、
 * 資料の上に重ねる背景は fillOpacity を小さくする
 */
module.exports.createShape = (token, boardId, {shape = "rectangle", content = "", x, y, width, height, style, parentId}) =>
	call("POST", `${boardPath(boardId)}/shapes`, {token, body: {
		data: {shape, content}, position: {x, y}, geometry: {width, height}, ...(style ? {style} : {}), ...(parentId ? {parent: {id: parentId}} : {})
	}});

/** 項目をまとめる(人が画面で動かすと一緒に動く。APIで動かすときは1つずつ動かす必要がある) */
module.exports.createGroup = (token, boardId, itemIds) =>
	call("POST", `${boardPath(boardId)}/groups`, {token, body: {data: {items: itemIds}}});

module.exports.call = call;
module.exports.MiroError = MiroError;
module.exports.API_URL = API_URL;

logger.debug({API_URL, AUTH_URL}, "miro client ready");
