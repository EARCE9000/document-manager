/*!
 * server.js : Document Manager
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 */

const path = require("path");
const fs = require("fs");
const _modulename = path.basename(require.main.filename);

const logger = require("./lib/logger.js")(_modulename);

// VERSION INFO
let versionInfo = null;
try { versionInfo = JSON.parse(fs.readFileSync('./VERSION.json', 'utf8')); } catch (err) {}
logger.info(versionInfo, "Version Information");

// API BASE_URL_PATH
const BASE_URL_PATH = process.env.BASE_URL_PATH || "/";
logger.info({BASE_URL_PATH}, "environment information");

// Listen Port
const LISTEN_PORT = process.env.LISTEN_PORT || 8080;
logger.info({LISTEN_PORT}, "environment information");

// Data directory (documents storage, mounted volume)
// res.sendFile()は絶対パスを要求するため、DATA_DIRが相対パス(ローカル開発時のDATA_DIR=../data等)
// で指定された場合に備えて絶対パスへ解決しておく
const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const DOCUMENTS_DIR = path.join(DATA_DIR, "documents");
logger.info({DOCUMENTS_DIR}, "environment information");

// 文書ファイルの保存先(ローカルディスク/S3)。STORAGE_BACKEND環境変数で切り替える(既定はローカルディスク)
const Storage = require("./lib/storage.js");
if (Storage.STORAGE_BACKEND !== "s3") {
	fs.mkdirSync(DOCUMENTS_DIR, {recursive: true});
}
const storage = Storage.createStorage(DOCUMENTS_DIR);


const express = require('express');
const app = new express();
const server = require('http').createServer(app);

// ReverseProxy(Apache等)配下で動くことを前提に X-Forwarded-* を信頼する。
// これが無いと req.protocol がプロキシ経由のHTTPホップを見て「非HTTPS」と
// 誤認し、OIDCコールバックURLの組み立てやSecure Cookieの挙動に影響する。
app.set('trust proxy', 1);

// Apache等のProxyPass設定でX-Forwarded-Protoが転送されていない環境では、上記のtrust proxy
// があっても req.protocol/req.secure が常に「非HTTPS」と誤判定される(本番環境で実際に発生:
// redirect_uri_mismatchの原因になったほか、express-sessionはcookie.secure:trueの場合
// req.secureがfalseだとSet-Cookie自体を送らないため、ログインセッションが一切機能しなく
// なっていた)。OIDC_REDIRECT_URIがhttpsで始まっていれば、このアプリは常にHTTPS配下で
// 動く前提として、プロキシから届くヘッダーに関係なくX-Forwarded-Protoをhttpsとして扱う。
const OIDC_REDIRECT_URI_FOR_PROXY = process.env.OIDC_REDIRECT_URI || "";
if (OIDC_REDIRECT_URI_FOR_PROXY.startsWith("https://")) {
	logger.info("OIDC_REDIRECT_URI is https: forcing X-Forwarded-Proto=https for req.secure detection");
	app.use((req, res, next) => {
		req.headers["x-forwarded-proto"] = "https";
		next();
	});
}

// multipartのパース(express-fileupload)はアップロード先のルートにだけ限定して適用する。
// 認証チェック(requireAuth/requireWrite)より後ろに置くことで、未認証のリクエストは
// ファイル本体の読み取り自体が始まる前に401/403で弾かれるようにする(サイズ上限チェックは
// api/documents ルート側でfileUpload()自体に持たせている。UPLOAD_MAX_BYTES参照)
const fileUpload = require('express-fileupload');
const UPLOAD_MAX_BYTES = 256 * 1024 * 1024; // 256MB

// セッション管理(express-session)。Cookieの寿命(maxAge)をOIDCプロバイダが発行する
// access_token自体のTTLから切り離すことで、短命なaccess_token(プロバイダ依存)でも
// ブラウザ側のログイン状態を安定して維持できるようにする。
const session = require('express-session');
const oidc = require('openid-client');

const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (SESSION_SECRET === "") {
	logger.warn("SESSION_SECRET is not set. generating a random value (sessions will be invalidated on every restart)");
}
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_HOURS || 8) * 60 * 60 * 1000;

app.use(session({
	secret: SESSION_SECRET || oidc.randomState(),
	resave: false,
	saveUninitialized: false,
	cookie: {
		path: '/',
		httpOnly: true,
		// trust proxy(+上記のX-Forwarded-Proto強制)と組み合わせ、HTTPS配下ではSecure Cookieに
		// なる('auto')。secure:true固定だと、req.secureがfalseの場合にexpress-sessionが
		// Set-Cookie自体を送らなくなるため使わないこと。
		secure: 'auto',
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_MS
	}
}));

// アクセスログ(標準出力)。1リクエスト1行で method/url/status/所要時間/接続元IP/
// ログイン済みユーザー識別子 を記録する。疎通確認と監査の両方を兼ねる。
// (session ミドルウェアの後に置くことで req.session.user を参照できる)
app.use((req, res, next) => {
	const startNs = process.hrtime.bigint();
	res.on("finish", () => {
		const durationMs = Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
		logger.info({
			method: req.method,
			url: req.originalUrl,
			status: res.statusCode,
			durationMs,
			ip: req.ip,
			user: (req.session && req.session.user) ? req.session.user.identifier : null,
			// Cookie到達性の診断用(セッションが引き継がれない不具合の切り分けに使う)
			hasCookieHeader: req.headers.cookie != null,
			sessionId: req.sessionID,
			secure: req.secure
		}, "access");
	});
	next();
});

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({extended: false}));

// static contents (frontend shell; actual data access is gated by requireAuth on api/*)
app.use(express.static(path.join(__dirname, 'static')));

// レート制限。api/*全体には緩やかな上限、/loginにはやや厳しめの上限をかけ、
// 未認証・認証済み問わず総当たり/スクレイピング/連打によるDoSを緩和する
// (trust proxyの設定と組み合わせ、Apache経由の実クライアントIP単位でカウントする)
const rateLimit = require('express-rate-limit');
const RATE_LIMIT_MESSAGE = {error: "リクエストが多すぎます。しばらく待ってから再度お試しください。"};
const apiRateLimiter = rateLimit({
	windowMs: 5 * 60 * 1000,
	limit: 300,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: RATE_LIMIT_MESSAGE
});
const loginRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: RATE_LIMIT_MESSAGE
});
app.use(BASE_URL_PATH + 'api/', apiRateLimiter);
app.use(BASE_URL_PATH + 'login', loginRateLimiter);

// 外部公開時のパスプレフィックス。ApacheのReverseProxyはこのプレフィックスを
// 剥がしてこのアプリへ転送するため、Express内部のルーティング(BASE_URL_PATH)は
// ルート基準のままでよい。一方でブラウザへ返すリダイレクト先(ログイン/ログアウト/
// ホームの遷移先)は外部から見えるこのプレフィックス基準で組み立てる。
// 環境変数名は他の社内サービス(docker_management等)とそろえてある。
const PUBLIC_BASE_PATH = (process.env.BASE_PATH || "/document_management").replace(/\/+$/, "");
const APP_ROOT_URI = `${PUBLIC_BASE_PATH}/`;
const LOGIN_URI = `${PUBLIC_BASE_PATH}/login`;

// ログイン後の戻り先(next)として受け入れてよいURLか判定する。
// このアプリ自身のパス配下の相対パスに限定し、外部ドメインへのオープンリダイレクトを防ぐ
const isSafeNextPath = (value) =>
	typeof value === "string" &&
	value.startsWith(`${PUBLIC_BASE_PATH}/`) &&
	!value.startsWith("//") &&
	!value.includes("://");


const setHTTPHeaders = (res) => {
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
};

// ログイン失敗時等に表示する簡易メッセージページ(フロントのカードUIと見た目を揃える)
const MESSAGE_PAGE_ICONS = {
	denied: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
	error: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
};

const renderMessagePage = (res, {statusCode, icon, iconColor, title, message, retryHref, retryLabel}) => {
	res.status(statusCode);
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${title} - Document Manager</title>
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; background: #f4f5f7; color: #24292f; }
	body { display: flex; align-items: center; justify-content: center; }
	.messageCard { background: #fff; border-radius: 10px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1); padding: 40px 36px; max-width: 380px; width: 90%; text-align: center; }
	.messageIcon { width: 40px; height: 40px; margin: 0 auto 16px; color: ${iconColor}; display: block; }
	h1 { font-size: 1.05em; margin: 0 0 10px; }
	p { font-size: 0.9em; color: #555; line-height: 1.6; margin: 0; }
	a.button { display: inline-block; background: #1a56db; color: #fff; text-decoration: none; padding: 8px 22px; border-radius: 6px; font-size: 0.9em; margin-top: 20px; }
	a.button:hover { background: #1544ad; }
</style>
</head>
<body>
	<div class="messageCard">
		<svg class="messageIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MESSAGE_PAGE_ICONS[icon]}</svg>
		<h1>${title}</h1>
		<p>${message}</p>
		${retryHref ? `<a class="button" href="${retryHref}">${retryLabel}</a>` : ""}
	</div>
</body>
</html>`);
};


/**
 * options method 共通処理
 */
app.options('*', function (req, res) {
	setHTTPHeaders(res);
	res.status(204);
	res.end();
});


// ping
app.all(BASE_URL_PATH + '_ping', async (req, res) => {
	setHTTPHeaders(res);
	res.json({
		sysdate: new Date().toISOString(),
		message: "pong"
	});
});

// バージョン情報(ヘッダーに小さく表示する用)。VERSION.jsonは10.buildDocker.shがビルド時に
// 生成するもので、ローカル開発環境には無いためversionInfoがnullのままのことがある
app.get(BASE_URL_PATH + 'api/version', async (req, res) => {
	setHTTPHeaders(res);
	const match = versionInfo != null ? String(versionInfo.VERSION || "").match(/(\d{8})/) : null;
	res.json({version: match ? match[1] : null});
});


// home uri
app.all(BASE_URL_PATH + 'home', async (req, res) => {
	setHTTPHeaders(res);
	res.redirect(APP_ROOT_URI);
});


/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	認証(OIDC)関連処理

	OIDCクライアントの初期化はWell-known URLへのdiscoveryフェッチを伴うため非同期
	(./lib/oidc-client.js)。main() で起動時に一度だけ解決してからapp.listen()する
	(下部参照)。ログイン状態自体はexpress-sessionのセッション(req.session.user)で
	管理し、プロバイダ側のaccess_tokenのTTLには依存しない。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

const initOidcClient = require("./lib/oidc-client.js");
const ApiKeys = require("./lib/api-keys.js");
const AllowedUsers = require("./lib/allowed-users.js");
const TagOrder = require("./lib/tag-order.js");
const Projects = require("./lib/projects.js");
const AuditLog = require("./lib/audit-log.js");

const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";
const OIDC_SCOPE = process.env.OIDC_SCOPE || "openid profile email";
// プロバイダ側でクライアント登録時に選択した「username claim」に合わせる (既定: email)
const OIDC_USERNAME_CLAIM = process.env.OIDC_USERNAME_CLAIM || "email";

// AUTH_DISABLED=true の間は認証を全てバイパスする(開発用。本番では未設定のこと)
const AUTH_DISABLED = /^(1|true)$/i.test(process.env.AUTH_DISABLED || "");
if (AUTH_DISABLED) {
	logger.warn("AUTH_DISABLED=true: 認証を無効化して起動しています(開発用途のみ)");
}
const DEV_AUTH_DATA = {user_identifier: "dev-user", role: AllowedUsers.ROLES.ADMIN};

let oidcConfig = null;

/**
 * login
 */
app.all(BASE_URL_PATH + 'login', async (req, res) => {
	try {
		setHTTPHeaders(res);

		if (AUTH_DISABLED) {
			res.redirect(APP_ROOT_URI);
			return;
		}

		if ("code" in req.query || "error" in req.query) {
			try {
				const transaction = req.session.oidcTransaction;
				delete req.session.oidcTransaction;
				// openid-clientはこのURLからクエリを除いた部分をtoken交換時のredirect_uriとして
				// 送信する。req.protocol/req.get("host")から組み立てると、リバースプロキシが
				// X-Forwarded-Protoを正しく渡していない場合にhttp://になってしまい、Googleに
				// 登録したredirect_uriと不一致でredirect_uri_mismatchエラーになる。認可リクエスト
				// 時に使った値そのものであるOIDC_REDIRECT_URIを基点にすれば、プロキシ構成に
				// 依存せず必ず一致する。
				const queryIndex = req.originalUrl.indexOf("?");
				const queryString = queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex + 1);
				const currentUrl = new URL(queryString === "" ? OIDC_REDIRECT_URI : `${OIDC_REDIRECT_URI}?${queryString}`);
				const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
					pkceCodeVerifier: transaction?.code_verifier,
					expectedState: transaction?.state,
					expectedNonce: transaction?.nonce
				});
				const claims = tokens.claims();
				const user_identifier = claims[OIDC_USERNAME_CLAIM] || claims.email || claims.preferred_username || claims.sub;

				// ADMIN_EMAIL/ホワイトリストとの比較内容を毎回ログに残す(許可・拒否どちらの場合も)
				const accessInfo = AllowedUsers.describeAccess(user_identifier);
				logger.info({
					oidc_username_claim: OIDC_USERNAME_CLAIM,
					claims_email: claims.email,
					claims_preferred_username: claims.preferred_username,
					claims_sub: claims.sub,
					...accessInfo
				}, "::login:auth_check");

				if (accessInfo.role == null) {
					logger.warn({user_identifier}, "::login:not allowed");
					renderMessagePage(res, {
						statusCode: 403,
						icon: "denied",
						iconColor: "#e03131",
						title: "アクセス権限がありません",
						message: "サービスへのアクセス権限がありません。心当たりがない場合は管理者にお問い合わせください。",
						retryHref: "./login",
						retryLabel: "別のアカウントでログインし直す"
					});
					return;
				}

				req.session.user = {identifier: user_identifier};
				res.redirect(transaction?.next || APP_ROOT_URI);
			} catch (err) {
				logger.error(err, "::login:callback");
				renderMessagePage(res, {
					statusCode: 401,
					icon: "error",
					iconColor: "#f08c00",
					title: "ログインに失敗しました",
					message: "予期しないエラーが発生しました。お手数ですが、もう一度お試しください。",
					retryHref: "./",
					retryLabel: "もう一度ログイン"
				});
			}
			return;
		}

		const code_verifier = oidc.randomPKCECodeVerifier();
		const code_challenge = await oidc.calculatePKCECodeChallenge(code_verifier);
		const state = oidc.randomState();
		const nonce = oidc.randomNonce();
		// 文書の共有リンク(別ウィンドウプレビュー)等、未ログイン状態で直接開かれた
		// URLへログイン後に戻れるようにする。安全な自ドメイン相対パスの場合のみ受け付ける
		const next = isSafeNextPath(req.query.next) ? req.query.next : null;
		req.session.oidcTransaction = {code_verifier, state, nonce, next};

		const url = oidc.buildAuthorizationUrl(oidcConfig, {
			redirect_uri: OIDC_REDIRECT_URI,
			response_type: "code",
			scope: OIDC_SCOPE,
			code_challenge,
			code_challenge_method: "S256",
			state,
			nonce
		});
		res.redirect(url.href);
	} catch (err) {
		logger.error(err, "::login");
		renderMessagePage(res, {
			statusCode: 500,
			icon: "error",
			iconColor: "#f08c00",
			title: "ログインに失敗しました",
			message: "予期しないエラーが発生しました。お手数ですが、もう一度お試しください。",
			retryHref: "./",
			retryLabel: "もう一度ログイン"
		});
	}
});

/**
 * 現在のログインセッションの有効性を確認する
 */
app.all(BASE_URL_PATH + 'api/check_access_token', async (req, res) => {
	try {
		setHTTPHeaders(res);

		if (AUTH_DISABLED) {
			res.status(200).json({user_identifier: DEV_AUTH_DATA.user_identifier, isAdmin: true, role: DEV_AUTH_DATA.role, vectorSearchEnabled: VectorSearch.isEnabled()});
			return;
		}

		if (req.session?.user != null) {
			const role = AllowedUsers.getRole(req.session.user.identifier);
			if (role != null) {
				res.status(200).json({
					user_identifier: req.session.user.identifier,
					isAdmin: role === AllowedUsers.ROLES.ADMIN,
					role,
					vectorSearchEnabled: VectorSearch.isEnabled()
				});
				return;
			}
			// セッションは有効だが後からホワイトリストを外された場合はセッションごと破棄する
			req.session.destroy(() => {});
		}
		res.status(401).json({});
	} catch (err) {
		logger.error(err, "::api/check_access_token");
		res.status(500).end("Internal Error");
	}
});

/**
 * logout
 */
app.all(BASE_URL_PATH + 'logout', async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (AUTH_DISABLED || req.session == null) {
			res.redirect(APP_ROOT_URI);
			return;
		}
		req.session.destroy((err) => {
			if (err) {
				logger.error(err, "::logout");
			}
			res.redirect(APP_ROOT_URI);
		});
	} catch (err) {
		logger.error(err, "::logout");
		res.status(500).end("Internal Error");
	}
});

/**
 * 認証必須APIの前段ミドルウェア
 * ブラウザの対話的ログイン(セッション)に加え、Claude Desktop等のマシンクライアント向けに
 * Authorization: Bearer <APIキー> でも認証できるようにしている。
 */
const requireAuth = (req, res, next) => {
	if (AUTH_DISABLED) {
		req.authData = DEV_AUTH_DATA;
		next();
		return;
	}

	const authorizationHeader = req.headers.authorization || "";
	if (authorizationHeader.startsWith("Bearer ")) {
		const apiKey = authorizationHeader.slice("Bearer ".length).trim();
		const verifyResult = ApiKeys.verifyApiKey(apiKey);
		if (verifyResult.status === "expired") {
			res.status(401).json({error: "APIキーの有効期限が切れています。新しいキーを発行してください。"});
			return;
		}
		if (verifyResult.status !== "ok") {
			res.status(401).json({error: "unauthorized"});
			return;
		}
		const apiKeyRow = verifyResult.row;
		// 発行者が後からホワイトリストを外された場合、そのAPIキーも無効として扱う。
		// 権限レベル自体は発行者の"現在の"ロールではなく、キーに記録されたroleを使う
		// (発行者が後から昇格/降格しても、既存キーの権限はキー発行時のまま変わらない)。
		if (!AllowedUsers.isAllowed(apiKeyRow.created_by)) {
			res.status(401).json({error: "unauthorized"});
			return;
		}
		// APIキー経由でも、そのキーを発行した本人として動作させる(操作ログ等の記録は本人名義になる)
		req.authData = {user_identifier: apiKeyRow.created_by, viaApiKey: apiKeyRow.label, role: apiKeyRow.role};
		next();
		return;
	}

	if (req.session?.user != null) {
		const role = AllowedUsers.getRole(req.session.user.identifier);
		if (role != null) {
			req.authData = {user_identifier: req.session.user.identifier, role};
			next();
			return;
		}
	}
	res.status(401).json({error: "unauthorized"});
};

/**
 * 管理者(adminロール)限定APIの前段ミドルウェア。requireAuthの後段で使う。
 */
const requireAdmin = (req, res, next) => {
	if (AUTH_DISABLED || req.authData.role === AllowedUsers.ROLES.ADMIN) {
		next();
		return;
	}
	res.status(403).json({error: "forbidden"});
};

/**
 * 書き込み(文書の追加・削除・タグ編集)が可能なロール(admin/readwrite)限定の
 * 前段ミドルウェア。requireAuthの後段で使う。readonlyロールは閲覧のみ許可する。
 */
const requireWrite = (req, res, next) => {
	if (AUTH_DISABLED || req.authData.role === AllowedUsers.ROLES.ADMIN || req.authData.role === AllowedUsers.ROLES.READWRITE) {
		next();
		return;
	}
	res.status(403).json({error: "forbidden"});
};


/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	文書管理(Document Manager)処理

	documents/ 配下は「年月_ユニークID」(例: 202608_3fa85f64-...)を1文書として
	フォルダ単位で管理する。フォルダの中にはアップロードされた元ファイル(入口ファイル)
	を格納する。html/htm/pdf/svg/png/jpg/jpeg/txt/log/json はブラウザがネイティブに描画できる
	ためそのままプレビュー対象とするが、mhtml/mht はブラウザでのプレビュー可否が不安定、
	md/markdown・csv/tsv はソースのままだと読みづらいため、それぞれ変換した単一HTML
	(preview.html) を同フォルダに追加生成し、プレビューはそちらを参照する
	(ダウンロードは元ファイルを返す)。
	id・ファイル名・サイズ・アップロード者/日時・削除者/日時などのメタ情報は
	sqlite (documents テーブル) で管理する。削除は論理削除
	(deleted_at/deleted_by を設定するのみで実体ファイルは残す)。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

const {v4: uuidv4} = require("uuid");
const {marked} = require("marked");
const {convert: htmlToText} = require("html-to-text");
const {parse: parseCsvSync} = require("csv-parse/sync");
const {PDFParse} = require("pdf-parse");
const db = require("./lib/db.js");
const VectorSearch = require("./lib/vector-search.js");

const MHTML_EXTENSIONS = [".mhtml", ".mht"];
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
const IMAGE_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg"];
const CSV_EXTENSIONS = [".csv", ".tsv"];
const PLAIN_TEXT_EXTENSIONS = [".txt", ".log", ".json"];
const NATIVE_PREVIEW_EXTENSIONS = [".html", ".htm", ".pdf"];
const ENTRY_FILE_EXTENSIONS = [...NATIVE_PREVIEW_EXTENSIONS, ...MHTML_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...IMAGE_EXTENSIONS, ...CSV_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS];
const PREVIEW_FILENAME = "preview.html";

const CONTENT_TYPE_BY_EXTENSION = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".pdf": "application/pdf",
	".mhtml": "message/rfc822",
	".mht": "message/rfc822",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".csv": "text/csv; charset=utf-8",
	".tsv": "text/tab-separated-values; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8"
};

// 年月(YYYYMM)
const currentYearMonth = () => {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${now.getFullYear()}${month}`;
};

// express-fileupload(busboy)はmultipartのファイル名をlatin1として解釈するため、
// 日本語等のファイル名が文字化けする。UTF-8バイト列として再解釈して復元する。
const fixUploadedFilenameEncoding = (name) => {
	const fixed = Buffer.from(name, "latin1").toString("utf8");
	// 変換で U+FFFD (無効なバイト列) が出た場合は、元々UTF-8化けしていなかった
	// 可能性が高いため元の文字列を使う
	return fixed.includes("�") ? name : fixed;
};

const MARKDOWN_PREVIEW_TEMPLATE = (bodyHtml) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="content-security-policy" content="default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; script-src 'none';">
<style>
body { font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.7; color: #24292f; }
pre { background: #f6f8fa; padding: 1em; overflow-x: auto; border-radius: 4px; }
code { background: #f6f8fa; padding: 0.15em 0.35em; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1em; color: #666; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ddd; padding: 0.4em 0.8em; }
img { max-width: 100%; }
</style>
</head><body>${bodyHtml}</body></html>`;

const CSV_PREVIEW_TEMPLATE = (tableHtml) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">
<style>
body { font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; margin: 1em; }
.tableWrap { overflow-x: auto; }
table { border-collapse: collapse; font-size: 0.85em; white-space: nowrap; }
th, td { border: 1px solid #ddd; padding: 0.3em 0.7em; text-align: left; }
thead th { background: #f4f5f7; position: sticky; top: 0; }
tbody tr:nth-child(even) { background: #fafbfc; }
</style>
</head><body><div class="tableWrap"><table>${tableHtml}</table></div></body></html>`;

const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// CSV/TSVをHTMLテーブルに変換する(1行目をヘッダーとして扱う)
const buildCsvPreviewHtml = (csvText, extension) => {
	const delimiter = extension === ".tsv" ? "\t" : ",";
	const records = parseCsvSync(csvText, {delimiter, skip_empty_lines: true, relax_column_count: true});
	if (records.length === 0) {
		return CSV_PREVIEW_TEMPLATE("<tbody><tr><td>(空のファイルです)</td></tr></tbody>");
	}
	const [header, ...body] = records;
	const theadHtml = `<thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
	const tbodyHtml = `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
	return CSV_PREVIEW_TEMPLATE(theadHtml + tbodyHtml);
};

// mhtml/mht・md/markdown・csv/tsv を単一HTMLに変換する (対象外/失敗時は null を返し、プレビュー不可として扱う)
const buildPreviewFile = async (documentId, originalName, extension) => {
	try {
		if (MHTML_EXTENSIONS.includes(extension)) {
			const {convert} = await import("mhtml-to-html");
			const mhtmlContent = (await storage.readFile(documentId, originalName)).toString("utf-8");
			const {data} = await convert(mhtmlContent);
			await storage.writeFile(documentId, PREVIEW_FILENAME, Buffer.from(data, "utf-8"));
			return PREVIEW_FILENAME;
		}
		if (MARKDOWN_EXTENSIONS.includes(extension)) {
			const markdownContent = (await storage.readFile(documentId, originalName)).toString("utf-8");
			const html = MARKDOWN_PREVIEW_TEMPLATE(marked.parse(markdownContent));
			await storage.writeFile(documentId, PREVIEW_FILENAME, Buffer.from(html, "utf-8"));
			return PREVIEW_FILENAME;
		}
		if (CSV_EXTENSIONS.includes(extension)) {
			const csvText = (await storage.readFile(documentId, originalName)).toString("utf-8");
			const html = buildCsvPreviewHtml(csvText, extension);
			await storage.writeFile(documentId, PREVIEW_FILENAME, Buffer.from(html, "utf-8"));
			return PREVIEW_FILENAME;
		}
		return originalName;
	} catch (err) {
		logger.error(err, "::buildPreviewFile");
		return null;
	}
};

// 全文検索用に本文のプレーンテキストを抽出する (失敗時は null。検索対象から外れるだけで他の処理には影響しない)
const extractContentText = async (documentId, originalName, extension, previewFile) => {
	try {
		if (MARKDOWN_EXTENSIONS.includes(extension)) {
			return (await storage.readFile(documentId, originalName)).toString("utf-8");
		}
		// csv/tsv・txt/log/json はいずれも元々プレーンテキストなので、変換せずそのまま検索対象にする
		if (CSV_EXTENSIONS.includes(extension) || PLAIN_TEXT_EXTENSIONS.includes(extension)) {
			return (await storage.readFile(documentId, originalName)).toString("utf-8");
		}
		if (extension === ".pdf") {
			const buffer = await storage.readFile(documentId, originalName);
			const parser = new PDFParse({data: buffer});
			try {
				const result = await parser.getText();
				return result.text;
			} finally {
				await parser.destroy();
			}
		}
		// 画像(svg/png/jpg/jpeg)からはテキストを抽出しない(OCR等は対象外。
		// previewFile != null のためこのガードが無いと、次のhtml向け分岐が画像バイナリを
		// UTF-8文字列として読もうとして化ける)
		if (IMAGE_EXTENSIONS.includes(extension)) {
			return null;
		}
		// html/htm/mhtml/mht は入口ファイルではなく、変換済み(または元のまま)の
		// previewFile を対象にすることで、mhtmlのMIME構造等に影響されず統一的に扱う
		if (previewFile != null) {
			const htmlContent = (await storage.readFile(documentId, previewFile)).toString("utf-8");
			return htmlToText(htmlContent, {wordwrap: false});
		}
		return null;
	} catch (err) {
		logger.error(err, "::extractContentText");
		return null;
	}
};

const insertDocument = db.prepare(`
	INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at)
	VALUES (@id, @entry_file, @preview_file, @content_text, @size, @uploaded_by, @uploaded_at)
`);

const insertDocumentFts = db.prepare(`
	INSERT INTO documents_fts (id, entry_file, content_text)
	VALUES (@id, @entry_file, @content_text)
`);

const selectActiveDocuments = db.prepare(`
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo
	FROM documents
	WHERE deleted_at IS NULL
	ORDER BY uploaded_at DESC
`);

// 起動時のベクトル検索バックフィル(過去にアップロードされた文書)用。VectorSearch側で
// 既にWeaviateに登録済みの文書は除外されるため、ここではアクティブな文書を全件渡すだけでよい
const selectActiveDocumentsForIndexing = db.prepare(`SELECT id, content_text FROM documents WHERE deleted_at IS NULL`);

// ファイル名・本文はFTS5(trigramトークナイザ)で部分一致検索する。日本語等CJKでも
// 単語分割不要で高速だが、3文字未満のクエリはヒットしないためLIKEにフォールバックする
// (タグは元々短い文字列でLIKEで十分高速なため、こちらは常にLIKEのまま)。
const MIN_FTS_QUERY_LENGTH = 3;

const searchActiveDocumentsByLike = db.prepare(`
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.memo
	FROM documents d
	LEFT JOIN document_tags t ON t.document_id = d.id
	WHERE d.deleted_at IS NULL
	AND (
		d.entry_file LIKE '%' || @q || '%'
		OR d.content_text LIKE '%' || @q || '%'
		OR d.memo LIKE '%' || @q || '%'
		OR t.tag LIKE '%' || @q || '%'
	)
	ORDER BY d.uploaded_at DESC
`);

const searchActiveDocumentsByFts = db.prepare(`
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.memo
	FROM documents d
	WHERE d.deleted_at IS NULL
	AND (
		d.id IN (SELECT id FROM documents_fts WHERE documents_fts MATCH @ftsQuery)
		OR d.memo LIKE '%' || @q || '%'
		OR d.id IN (SELECT document_id FROM document_tags WHERE tag LIKE '%' || @q || '%')
	)
	ORDER BY d.uploaded_at DESC
`);

// ユーザー入力をFTS5のフレーズクエリとして安全に組み立てる(演算子等として解釈させない)
const toFtsPhraseQuery = (q) => `"${q.replace(/"/g, '""')}"`;

const searchActiveDocuments = (q) => {
	if (q.length < MIN_FTS_QUERY_LENGTH) {
		return searchActiveDocumentsByLike.all({q});
	}
	try {
		return searchActiveDocumentsByFts.all({ftsQuery: toFtsPhraseQuery(q), q});
	} catch (err) {
		logger.error(err, "::searchActiveDocuments:fts_fallback");
		return searchActiveDocumentsByLike.all({q});
	}
};

// アーカイブ(論理削除済み)一覧・検索。アクティブ一覧と同じ検索方式(FTS5/LIKE)を、
// 対象をdeleted_at IS NOT NULLに変えて流用する
const searchDeletedDocumentsByLike = db.prepare(`
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.deleted_by, d.deleted_at, d.memo
	FROM documents d
	LEFT JOIN document_tags t ON t.document_id = d.id
	WHERE d.deleted_at IS NOT NULL
	AND (
		d.entry_file LIKE '%' || @q || '%'
		OR d.content_text LIKE '%' || @q || '%'
		OR d.memo LIKE '%' || @q || '%'
		OR t.tag LIKE '%' || @q || '%'
	)
	ORDER BY d.deleted_at DESC
`);

const searchDeletedDocumentsByFts = db.prepare(`
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.deleted_by, d.deleted_at, d.memo
	FROM documents d
	WHERE d.deleted_at IS NOT NULL
	AND (
		d.id IN (SELECT id FROM documents_fts WHERE documents_fts MATCH @ftsQuery)
		OR d.memo LIKE '%' || @q || '%'
		OR d.id IN (SELECT document_id FROM document_tags WHERE tag LIKE '%' || @q || '%')
	)
	ORDER BY d.deleted_at DESC
`);

const searchDeletedDocuments = (q) => {
	if (q.length < MIN_FTS_QUERY_LENGTH) {
		return searchDeletedDocumentsByLike.all({q});
	}
	try {
		return searchDeletedDocumentsByFts.all({ftsQuery: toFtsPhraseQuery(q), q});
	} catch (err) {
		logger.error(err, "::searchDeletedDocuments:fts_fallback");
		return searchDeletedDocumentsByLike.all({q});
	}
};

const selectActiveDocumentById = db.prepare(`
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo
	FROM documents
	WHERE id = ? AND deleted_at IS NULL
`);

// アーカイブ済み文書もプレビュー/ダウンロードできるよう、状態を問わずidだけで引く
const selectDocumentById = db.prepare(`
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo
	FROM documents
	WHERE id = ?
`);

// 文書復元時、ベクトル検索インデックス(Weaviate)へ再登録するためだけに使う
const selectContentTextById = db.prepare(`SELECT content_text FROM documents WHERE id = ?`);

const softDeleteDocument = db.prepare(`
	UPDATE documents SET deleted_at = @deleted_at, deleted_by = @deleted_by
	WHERE id = @id AND deleted_at IS NULL
`);

const selectDeletedDocuments = db.prepare(`
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo
	FROM documents
	WHERE deleted_at IS NOT NULL
	ORDER BY deleted_at DESC
`);

const restoreDocument = db.prepare(`
	UPDATE documents SET deleted_at = NULL, deleted_by = NULL
	WHERE id = ? AND deleted_at IS NOT NULL
`);

const updateDocumentMemo = db.prepare(`UPDATE documents SET memo = ? WHERE id = ?`);

const selectTagsByDocumentId = db.prepare(`SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`);
const deleteTagsByDocumentId = db.prepare(`DELETE FROM document_tags WHERE document_id = ?`);
const insertTag = db.prepare(`INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)`);
const replaceDocumentTags = db.transaction((documentId, tags) => {
	deleteTagsByDocumentId.run(documentId);
	for (const tag of tags) insertTag.run(documentId, tag);
});

const toDocumentResponse = (row) => ({
	id: row.id,
	entryFile: row.entry_file,
	previewFile: row.preview_file,
	size: row.size,
	uploadedBy: row.uploaded_by,
	modified: row.uploaded_at,
	memo: row.memo,
	tags: selectTagsByDocumentId.all(row.id).map((tagRow) => tagRow.tag)
});

const toDeletedDocumentResponse = (row) => ({
	id: row.id,
	entryFile: row.entry_file,
	previewFile: row.preview_file,
	size: row.size,
	uploadedBy: row.uploaded_by,
	modified: row.uploaded_at,
	deletedBy: row.deleted_by,
	deletedAt: row.deleted_at,
	memo: row.memo,
	tags: selectTagsByDocumentId.all(row.id).map((tagRow) => tagRow.tag)
});

/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	文書一覧の変更(アップロード/削除)をSSEで全クライアントに通知する。
	接続はメモリ上のSetで保持するため、単一プロセス構成であることが前提。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

const sseClients = new Set();

const broadcastDocumentsChanged = () => {
	for (const client of sseClients) {
		client.write("event: documents-changed\ndata: {}\n\n");
	}
};

// ベクトル索引の状態(processing/ok/error)がバックグラウンドで変化するたびに、SSE経由で
// 「ベクトル索引」画面を開いている全クライアントへ反映する(indexDocumentはawaitせず
// fire-and-forgetで呼ぶため、完了をこの通知でしか知る術がない。詳細はvector-search.js参照)
VectorSearch.setStatusChangeListener(broadcastDocumentsChanged);

// プロジェクトの施錠/解錠・構成変更(フォルダ/文書の登録・並び替え等)を同じSSE接続で通知する。
// 全利用者で共有される状態のため、他クライアントが変更していても画面が古いままにならないようにする
const broadcastProjectsChanged = () => {
	for (const client of sseClients) {
		client.write("event: projects-changed\ndata: {}\n\n");
	}
};

/**
 * 文書一覧変更通知 (SSE)
 */
app.get(BASE_URL_PATH + 'api/documents/events', requireAuth, (req, res) => {
	setHTTPHeaders(res);
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();
	res.write(":connected\n\n");

	sseClients.add(res);
	const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 30000);

	req.on("close", () => {
		clearInterval(heartbeat);
		sseClients.delete(res);
	});
});

/**
 * 文書一覧
 */
app.get(BASE_URL_PATH + 'api/documents', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const q = String(req.query.q || "").trim();
		const rows = q === "" ? selectActiveDocuments.all() : searchActiveDocuments(q);
		const documents = rows.map(toDocumentResponse);
		res.status(200).json(documents);
	} catch (err) {
		logger.error(err, "::api/documents:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書のベクトル(意味)検索。キーワードの部分一致ではなく、言い換え・表記ゆれを含めて
 * 意味的に近い文書を探す。Weaviate(WEAVIATE_URL環境変数)が設定されていない場合は
 * 任意機能として503を返す(既存のキーワード検索・文書管理には影響しない)
 */
app.get(BASE_URL_PATH + 'api/documents/search/vector', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		const q = String(req.query.q || "").trim();
		if (q === "") {
			res.status(400).json({error: "q is required"});
			return;
		}
		const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
		const hits = await VectorSearch.search(q, limit);
		const documents = hits
			.map((hit) => {
				const row = selectActiveDocumentById.get(hit.documentId);
				if (row == null) {
					return null;
				}
				return {...toDocumentResponse(row), snippet: hit.snippet, distance: hit.distance};
			})
			.filter((doc) => doc != null);
		res.status(200).json(documents);
	} catch (err) {
		logger.error(err, "::api/documents/search/vector");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索のアクティブな全文書の索引状態(要 admin/readwrite ロール)。
 * 「ベクトル索引」画面(index.html)から呼ばれる。失敗した文書の再実行だけでなく、
 * チャンク分割方法や埋め込みモデルの変更後に成功済みの文書を再索引したい場合にも使う。
 * Weaviate未設定の場合もエラーにはせず enabled:false を返す(その場合 documents は常に空)
 */
app.get(BASE_URL_PATH + 'api/documents/vector-index/status', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json({
			enabled: VectorSearch.isEnabled(),
			documents: VectorSearch.isEnabled() ? VectorSearch.listIndexStatuses() : []
		});
	} catch (err) {
		logger.error(err, "::api/documents/vector-index/status");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索の索引付けを1文書だけ再実行する(要 admin/readwrite ロール)
 */
app.post(BASE_URL_PATH + 'api/documents/:id/vector-index/retry', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		const result = await VectorSearch.retryDocument(req.params.id);
		if (result == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(result);
	} catch (err) {
		logger.error(err, "::api/documents/:id/vector-index/retry");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索のチャンク分割設定を取得する(要 admin/readwrite ロール。画面表示用)。
 * GUIで上書きされていなければ環境変数(VECTOR_CHUNK_SIZE/VECTOR_CHUNK_OVERLAP)の既定値を返す
 */
app.get(BASE_URL_PATH + 'api/vector-index/settings', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(VectorSearch.getChunkSettings());
	} catch (err) {
		logger.error(err, "::api/vector-index/settings:get");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索のチャンク分割設定をGUIから変更する(要 admin ロール。システム全体に影響するため)。
 * 変更は新規に索引付けする文書からのみ反映され、既存の索引付け済み文書には遡って適用されない
 */
app.put(BASE_URL_PATH + 'api/vector-index/settings', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		const chunkSize = Number(req.body.chunkSize);
		const chunkOverlap = Number(req.body.chunkOverlap);
		const settings = VectorSearch.updateChunkSettings({chunkSize, chunkOverlap}, req.authData.user_identifier);
		res.status(200).json(settings);
	} catch (err) {
		if (err instanceof Error && /chunkSize|chunkOverlap/.test(err.message)) {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/vector-index/settings:put");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索のチャンク分割設定を環境変数の既定値に戻す(要 admin ロール)
 */
app.delete(BASE_URL_PATH + 'api/vector-index/settings', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		res.status(200).json(VectorSearch.resetChunkSettings());
	} catch (err) {
		logger.error(err, "::api/vector-index/settings:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書アップロード (html / mhtml / markdown / pdf 単一ファイル)
 * ファイルサイズの上限はUPLOAD_MAX_BYTES(既定100MB)。超過時はexpress-fileuploadが
 * 413で切断する(abortOnLimit)。認証チェックの方を先に行うため、未認証のリクエストは
 * このサイズ判定にすら到達しない
 */
app.post(BASE_URL_PATH + 'api/documents', requireAuth, requireWrite, fileUpload({
	limits: {fileSize: UPLOAD_MAX_BYTES},
	abortOnLimit: true,
	// limitHandlerで先にJSONレスポンスを送ることで、他のエンドポイントと同じ{"error":...}形式・
	// Content-Type: application/jsonを返す(abortOnLimitのデフォルト応答は素のテキストのため)。
	// abortOnLimitはそのまま残し、express-fileupload内部のクリーンアップ(cleanup())も
	// 動かす(closeConnectionはres.headersSentを見て二重送信を避けてくれる)
	limitHandler: (req, res) => {
		res.status(413).json({error: `ファイルサイズが大きすぎます(上限: ${UPLOAD_MAX_BYTES / 1024 / 1024}MB)`});
	}
}), async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (req.files == null || req.files.uploadfile == null) {
			res.status(400).json({error: "uploadfile is required"});
			return;
		}
		const uploadfile = req.files.uploadfile;
		const originalName = path.basename(fixUploadedFilenameEncoding(String(uploadfile.name || "")));
		const extension = path.extname(originalName).toLowerCase();
		if (originalName === "" || !ENTRY_FILE_EXTENSIONS.includes(extension)) {
			res.status(400).json({error: "html / mhtml / markdown / pdf / svg / png / jpeg / csv / tsv / txt / log / json ファイルのみアップロード可能です"});
			return;
		}

		const id = `${currentYearMonth()}_${uuidv4()}`;
		// uploadfile.mv()はローカルディスク専用のAPIのため使わず、メモリ上のBuffer(uploadfile.data)を
		// storage経由で書き込む(express-fileuploadはuseTempFiles未設定=false相当で常にdataを保持する)
		await storage.writeFile(id, originalName, uploadfile.data);

		const previewFile = await buildPreviewFile(id, originalName, extension);
		const contentText = await extractContentText(id, originalName, extension, previewFile);

		const row = {
			id,
			entry_file: originalName,
			preview_file: previewFile,
			content_text: contentText,
			size: uploadfile.size,
			uploaded_by: req.authData.user_identifier,
			uploaded_at: new Date().toISOString()
		};
		insertDocument.run(row);
		insertDocumentFts.run(row);
		// ベクトル検索(Weaviate)への索引登録はベストエフォート・非同期(埋め込み計算に数秒
		// かかるため、awaitせずバックグラウンドで実行しアップロードAPIの応答をブロックしない。
		// WEAVIATE_URL未設定/接続失敗でもアップロード自体は成功させる。詳細はlib/vector-search.js参照)
		VectorSearch.indexDocument(id, contentText).catch((err) => logger.error({err, documentId: id}, "::api/documents:upload:indexDocument"));
		logger.info({
			audit: "upload",
			user: req.authData.user_identifier,
			documentId: id,
			entryFile: originalName
		}, "audit");
		AuditLog.record({userIdentifier: req.authData.user_identifier, action: "upload", documentId: id, entryFile: originalName});
		broadcastDocumentsChanged();

		res.status(200).json(toDocumentResponse(row));
	} catch (err) {
		logger.error(err, "::api/documents:upload");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ファイル配信中に発生した例外の共通ハンドリング。
 * 転送を開始した後にクライアントが切断する(タブを閉じる・ダウンロード中断・
 * PDFビューアがRangeでの再取得のために接続を切る)のは異常ではないため、
 * 500を返そうとせずログをinfoに留める。ヘッダー送信後はステータスを上書き
 * できず、ここで res.status() を呼ぶと ERR_HTTP_HEADERS_SENT になる。
 */
const handleServeFileError = (err, req, res, label) => {
	if (err.code === "ERR_STREAM_PREMATURE_CLOSE" || req.destroyed || res.writableEnded) {
		logger.info({documentId: req.params.id}, `${label}: client disconnected`);
		return;
	}
	logger.error(err, label);
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.status(500).json({error: "Internal Error"});
};

/**
 * 文書プレビュー/ダウンロードの実体(api/documents/:id/file と api/documents/:id/viewer で共用)
 * ?download=1 を付けると添付ファイルとしてダウンロードさせる
 * アーカイブ(論理削除)済み文書も、復元前に内容を確認できるよう対象に含める
 * 呼び出し元でreq.authData.user_identifierを設定しておくこと(ダウンロード時の監査ログ用)
 */
const serveDocumentFile = async (req, res) => {
	setHTTPHeaders(res);
	const document = selectDocumentById.get(req.params.id);
	if (document == null) {
		res.status(404).json({error: "not found"});
		return;
	}
	const isDownload = "download" in req.query;
	const targetFile = isDownload ? document.entry_file : document.preview_file;
	if (targetFile == null) {
		res.status(404).json({error: "preview not available"});
		return;
	}
	if (!(await storage.exists(document.id, targetFile))) {
		res.status(404).json({error: "not found"});
		return;
	}
	const extension = path.extname(targetFile).toLowerCase();
	res.setHeader("Content-Type", CONTENT_TYPE_BY_EXTENSION[extension] || "application/octet-stream");
	if (isDownload) {
		logger.info({
			audit: "download",
			user: req.authData.user_identifier,
			documentId: document.id,
			entryFile: document.entry_file
		}, "audit");
		res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(document.entry_file)}"`);
	} else {
		res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(targetFile)}"`);
	}
	await storage.streamToResponse(document.id, targetFile, res);
};

app.get(BASE_URL_PATH + 'api/documents/:id/file', requireAuth, async (req, res) => {
	try {
		await serveDocumentFile(req, res);
	} catch (err) {
		handleServeFileError(err, req, res, "::api/documents/:id/file");
	}
});

/**
 * 別ウィンドウプレビュー(人間がブラウザで開く・URLを共有する用)
 * api/documents/:id/file はClaude Desktop等のAPIキー連携クライアントからの利用を
 * 前提としており、未認証時はJSONの401を返すのみで復帰できない。共有されたリンクを
 * 未ログイン状態で開いた場合にログイン画面へ迂回し、ログイン完了後にこのURLへ
 * 戻ってこられるよう、ブラウザでの直接アクセス用にセッション認証のみで別途用意する
 * (APIキーでの認証はここでは受け付けない)。
 */
app.get(BASE_URL_PATH + 'api/documents/:id/viewer', async (req, res) => {
	try {
		if (AUTH_DISABLED) {
			req.authData = DEV_AUTH_DATA;
		} else {
			const role = req.session?.user != null ? AllowedUsers.getRole(req.session.user.identifier) : null;
			if (role == null) {
				res.redirect(`${LOGIN_URI}?next=${encodeURIComponent(PUBLIC_BASE_PATH + req.originalUrl)}`);
				return;
			}
			req.authData = {user_identifier: req.session.user.identifier, role};
		}
		await serveDocumentFile(req, res);
	} catch (err) {
		handleServeFileError(err, req, res, "::api/documents/:id/viewer");
	}
});

/**
 * 文書削除 (論理削除: documents.deleted_at/deleted_by を設定する。実体ファイルは残す)
 */
app.delete(BASE_URL_PATH + 'api/documents/:id', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const result = softDeleteDocument.run({
			id: req.params.id,
			deleted_at: new Date().toISOString(),
			deleted_by: req.authData.user_identifier
		});
		if (result.changes === 0) {
			res.status(404).json({error: "not found"});
			return;
		}
		VectorSearch.removeDocument(req.params.id).catch((err) => logger.error({err, documentId: req.params.id}, "::api/documents/:id:delete:removeDocument"));
		logger.info({
			audit: "delete",
			user: req.authData.user_identifier,
			documentId: req.params.id
		}, "audit");
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "delete",
			documentId: req.params.id,
			entryFile: selectDocumentById.get(req.params.id)?.entry_file ?? null
		});
		broadcastDocumentsChanged();
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/documents/:id:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * アーカイブ(削除済み)文書一覧・検索。通常一覧と同じ検索方式(FTS5/LIKE)を使う (要 admin/readwrite ロール)
 */
app.get(BASE_URL_PATH + 'api/documents/trash', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const q = String(req.query.q || "").trim();
		const rows = q === "" ? selectDeletedDocuments.all() : searchDeletedDocuments(q);
		res.status(200).json(rows.map(toDeletedDocumentResponse));
	} catch (err) {
		logger.error(err, "::api/documents/trash:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書復元 (アーカイブ=論理削除の取り消し。要 admin/readwrite ロール)
 */
app.post(BASE_URL_PATH + 'api/documents/:id/restore', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const result = restoreDocument.run(req.params.id);
		if (result.changes === 0) {
			res.status(404).json({error: "not found"});
			return;
		}
		// 論理削除時にWeaviate側のチャンクは削除済みのため、content_textから再登録する
		VectorSearch.indexDocument(req.params.id, selectContentTextById.get(req.params.id)?.content_text ?? null)
			.catch((err) => logger.error({err, documentId: req.params.id}, "::api/documents/:id/restore:indexDocument"));
		logger.info({
			audit: "restore",
			user: req.authData.user_identifier,
			documentId: req.params.id
		}, "audit");
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "restore",
			documentId: req.params.id,
			entryFile: selectDocumentById.get(req.params.id)?.entry_file ?? null
		});
		broadcastDocumentsChanged();
		res.status(200).json({id: req.params.id});
	} catch (err) {
		logger.error(err, "::api/documents/:id/restore");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書タグ更新 (タグ一式を置き換える)
 */
app.put(BASE_URL_PATH + 'api/documents/:id/tags', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = selectActiveDocumentById.get(req.params.id);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const rawTags = Array.isArray(req.body.tags) ? req.body.tags : [];
		const tags = [...new Set(rawTags.map((tag) => String(tag).trim()).filter((tag) => tag !== ""))];

		replaceDocumentTags(document.id, tags);
		broadcastDocumentsChanged();
		res.status(200).json({tags});
	} catch (err) {
		logger.error(err, "::api/documents/:id/tags");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書メモ更新 (プレビュー画面で入力する備忘録的な自由記述メモ。全文置き換え)
 */
app.put(BASE_URL_PATH + 'api/documents/:id/memo', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = selectActiveDocumentById.get(req.params.id);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const memo = String(req.body.memo || "");
		updateDocumentMemo.run(memo === "" ? null : memo, document.id);
		res.status(200).json({memo});
	} catch (err) {
		logger.error(err, "::api/documents/:id/memo");
		res.status(500).json({error: "Internal Error"});
	}
});


/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	操作履歴
	ユーザー自身が「自分が何をしたか」を確認できるようにする(直近30日分)。
	他人の履歴は見えない(常に自分自身のuser_identifierだけで絞り込む)。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

/**
 * 自分自身の操作履歴一覧(直近30日、最大500件、新しい順)
 */
app.get(BASE_URL_PATH + 'api/history', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(AuditLog.listMine(req.authData.user_identifier));
	} catch (err) {
		logger.error(err, "::api/history");
		res.status(500).json({error: "Internal Error"});
	}
});

/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	APIキー管理(マシン間認証用)
	ブラウザでログイン済みのユーザーが、Claude Desktop等の自動化クライアント用に
	APIキーを発行・失効できるようにする。平文キーは発行時のレスポンスでのみ返す。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

/**
 * APIキー一覧 (自分が発行したものだけ。平文キーは含まない)
 */
app.get(BASE_URL_PATH + 'api/apikeys', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const keys = ApiKeys.listApiKeys(req.authData.user_identifier).map((row) => ({
			id: row.id,
			label: row.label,
			role: row.role,
			createdBy: row.created_by,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			lastUsedAt: row.last_used_at
		}));
		res.status(200).json(keys);
	} catch (err) {
		logger.error(err, "::api/apikeys:list");
		res.status(500).json({error: "Internal Error"});
	}
});

// キーに設定できるロールは「発行者の現在のロール以下」に限る(adminロールのユーザーも、
// キー自体はreadwriteまでしか発行できない。ROLESにadminが含まれないのはこのため)
const API_KEY_ROLE_RANK = {
	[AllowedUsers.ROLES.READONLY]: 1,
	[AllowedUsers.ROLES.READWRITE]: 2,
	[AllowedUsers.ROLES.ADMIN]: 3
};

/**
 * APIキー発行 (平文キーはこのレスポンスでのみ取得可能)
 */
app.post(BASE_URL_PATH + 'api/apikeys', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		// 用途(label)は備考的な位置づけの任意項目(未入力可)。一覧では発行日時を主に表示する
		const label = String(req.body.label || "").trim();
		const role = String(req.body.role || "").trim();
		const expiryOption = String(req.body.expiryOption || "").trim();
		if (!ApiKeys.isValidApiKeyRole(role)) {
			res.status(400).json({error: "role must be readonly or readwrite"});
			return;
		}
		if (API_KEY_ROLE_RANK[role] > API_KEY_ROLE_RANK[req.authData.role]) {
			res.status(403).json({error: "自分のロールより高い権限のAPIキーは発行できません"});
			return;
		}
		if (!ApiKeys.isValidExpiryOption(expiryOption)) {
			res.status(400).json({error: "expiryOption must be one of today/30d/90d"});
			return;
		}
		const created = ApiKeys.createApiKey(label, role, expiryOption, req.authData.user_identifier);
		res.status(200).json(created);
	} catch (err) {
		logger.error(err, "::api/apikeys:create");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * APIキー失効 (自分が発行したものだけ失効可能)
 */
app.delete(BASE_URL_PATH + 'api/apikeys/:id', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const revoked = ApiKeys.revokeApiKeyById(req.params.id, req.authData.user_identifier);
		if (!revoked) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/apikeys/:id:revoke");
		res.status(500).json({error: "Internal Error"});
	}
});


/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	ログイン許可ユーザー(ホワイトリスト)とロールの管理
	EntraID/Cognitoどちらの認証プロバイダでも共通で使えるよう、メールアドレスで
	アプリ側に許可リストを持つ。ホワイトリストに登録されたメールアドレスのみ
	ログイン可能で、0件の間も含めて常に閉じている。
	ロールは admin(ホワイトリスト管理が可能) / readwrite(文書の追加・削除・
	タグ編集が可能) / readonly(閲覧のみ) の3種類。ADMIN_EMAILはadminロールの
	ユーザーが1人もいない場合だけ働く自己修復型のブートストラップ用の踏み台
	(lib/allowed-users.js 参照)。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

/**
 * ホワイトリスト一覧 (管理者のみ)
 */
app.get(BASE_URL_PATH + 'api/allowed_users', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const users = AllowedUsers.listAllowedUsers().map((row) => ({
			email: row.email,
			role: row.role,
			addedBy: row.added_by,
			addedAt: row.added_at
		}));
		res.status(200).json(users);
	} catch (err) {
		logger.error(err, "::api/allowed_users:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ホワイトリストへの追加 (管理者のみ)
 */
app.post(BASE_URL_PATH + 'api/allowed_users', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const email = String(req.body.email || "").trim();
		const role = String(req.body.role || "").trim();
		if (email === "") {
			res.status(400).json({error: "email is required"});
			return;
		}
		if (!AllowedUsers.isValidRole(role)) {
			res.status(400).json({error: "role must be one of admin/readwrite/readonly"});
			return;
		}
		AllowedUsers.addAllowedUser(email, role, req.authData.user_identifier);
		res.status(200).json({email, role});
	} catch (err) {
		logger.error(err, "::api/allowed_users:add");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ホワイトリスト登録済みユーザーのロール変更 (管理者のみ)
 */
app.put(BASE_URL_PATH + 'api/allowed_users/:email', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const role = String(req.body.role || "").trim();
		if (!AllowedUsers.isValidRole(role)) {
			res.status(400).json({error: "role must be one of admin/readwrite/readonly"});
			return;
		}
		const updated = AllowedUsers.updateAllowedUserRole(req.params.email, role);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json({email: req.params.email, role});
	} catch (err) {
		logger.error(err, "::api/allowed_users/:email:update_role");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ホワイトリストからの削除 (管理者のみ)
 */
app.delete(BASE_URL_PATH + 'api/allowed_users/:email', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const removed = AllowedUsers.removeAllowedUser(req.params.email);
		if (!removed) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/allowed_users/:email:remove");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * タグ体系(タグツリー表示)の並び順取得。ツリー表示に使うためログイン済みなら誰でも取得可
 */
app.get(BASE_URL_PATH + 'api/tag_order', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(TagOrder.listTagOrder());
	} catch (err) {
		logger.error(err, "::api/tag_order:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * タグ体系の並び順を全件置き換える (管理者のみ)
 * body: {tags: ["要件定義", "設計", ...]} (この配列順そのものが並び順になる)
 */
app.put(BASE_URL_PATH + 'api/tag_order', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!Array.isArray(req.body.tags)) {
			res.status(400).json({error: "tags must be an array"});
			return;
		}
		const saved = TagOrder.replaceTagOrder(req.body.tags, req.authData.user_identifier);
		res.status(200).json({tags: saved});
	} catch (err) {
		logger.error(err, "::api/tag_order:replace");
		res.status(500).json({error: "Internal Error"});
	}
});

// プロジェクトが施錠中の場合に、構成を変更するAPI(名前変更/フォルダ操作/文書登録・解除/並び替え)を
// 一律で拒否するためのエラー応答。排他制御(誰かのロック)ではなく全利用者共有の状態で、
// 「誰でも編集できる/誰も編集できない」を切り替えるだけ(423 Locked)
const respondProjectLocked = (res) => {
	res.status(423).json({error: "このプロジェクトは施錠されています。編集するには鍵を解錠してください。"});
};

/**
 * プロジェクト一覧
 */
app.get(BASE_URL_PATH + 'api/projects', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(Projects.listProjects());
	} catch (err) {
		logger.error(err, "::api/projects:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * アーカイブ済みプロジェクト一覧
 */
app.get(BASE_URL_PATH + 'api/projects/archived', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(Projects.listArchivedProjects());
	} catch (err) {
		logger.error(err, "::api/projects/archived:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクト作成 (admin/readwrite)
 */
app.post(BASE_URL_PATH + 'api/projects', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.createProject(req.body.name, req.authData.user_identifier);
		res.status(200).json(project);
	} catch (err) {
		if (err.message === "project name is required") {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/projects:create");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクト名変更 (admin/readwrite)
 */
app.put(BASE_URL_PATH + 'api/projects/:id', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		Projects.renameProject(req.params.id, req.body.name);
		broadcastProjectsChanged();
		res.status(200).json(Projects.getProject(req.params.id));
	} catch (err) {
		if (err.message === "project name is required") {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/projects/:id:rename");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクトをアーカイブする (admin/readwrite。論理的な非表示化で、元に戻すボタンで復元できる)
 */
app.post(BASE_URL_PATH + 'api/projects/:id/archive', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const archived = Projects.archiveProject(req.params.id, req.authData.user_identifier);
		if (!archived) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(Projects.getProject(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/archive");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * アーカイブ済みプロジェクトを元に戻す (admin/readwrite)
 */
app.post(BASE_URL_PATH + 'api/projects/:id/restore', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const restored = Projects.restoreProject(req.params.id);
		if (!restored) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(Projects.getProject(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/restore");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクトを解錠する(admin/readwrite。全利用者で共有される状態で、解錠中は誰でも
 * 構成を編集できる。排他制御ではないため同時編集の競合防止にはならない。明示的に施錠
 * するまで解錠状態を維持し、タイムアウトによる自動施錠はしない)
 */
app.post(BASE_URL_PATH + 'api/projects/:id/unlock', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const updated = Projects.setProjectLocked(req.params.id, false);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		broadcastProjectsChanged();
		res.status(200).json(Projects.getProject(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/unlock");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクトを施錠する(admin/readwrite)。施錠中は名前変更・フォルダ操作・文書の
 * 登録/解除/並び替えがすべて423で拒否される
 */
app.post(BASE_URL_PATH + 'api/projects/:id/lock', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const updated = Projects.setProjectLocked(req.params.id, true);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		broadcastProjectsChanged();
		res.status(200).json(Projects.getProject(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/lock");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクト削除 (admin/readwrite。フォルダ・文書の登録もまとめて削除するが、文書自体は消えない)
 */
app.delete(BASE_URL_PATH + 'api/projects/:id', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const deleted = Projects.deleteProject(req.params.id);
		if (!deleted) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/projects/:id:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクトのツリー(フォルダ一覧 + 文書の配置一覧)を返す
 */
app.get(BASE_URL_PATH + 'api/projects/:id/tree', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (Projects.getProject(req.params.id) == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(Projects.getProjectTree(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/tree");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * フォルダ作成 (admin/readwrite)
 * body: {name, parentFolderId?} (parentFolderId省略/nullでプロジェクト直下)
 */
app.post(BASE_URL_PATH + 'api/projects/:id/folders', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const folder = Projects.createFolder(req.params.id, req.body.name, req.body.parentFolderId || null, req.authData.user_identifier);
		broadcastProjectsChanged();
		res.status(200).json(folder);
	} catch (err) {
		if (err.message === "folder name is required" || err.message === "parent folder not found") {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/projects/:id/folders:create");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * フォルダ名変更 (admin/readwrite)
 */
app.put(BASE_URL_PATH + 'api/projects/:id/folders/:folderId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const updated = Projects.renameFolder(req.params.id, req.params.folderId, req.body.name);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		broadcastProjectsChanged();
		res.status(200).json({id: req.params.folderId, name: req.body.name});
	} catch (err) {
		if (err.message === "folder name is required") {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/projects/:id/folders/:folderId:rename");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * フォルダ削除 (admin/readwrite)。中身(サブフォルダ・文書)が空の場合のみ削除できる
 */
app.delete(BASE_URL_PATH + 'api/projects/:id/folders/:folderId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const result = Projects.deleteFolder(req.params.id, req.params.folderId);
		if (result === "not_found") {
			res.status(404).json({error: "not found"});
			return;
		}
		if (result === "not_empty") {
			res.status(409).json({error: "フォルダの中身(サブフォルダ・文書)を空にしてから削除してください"});
			return;
		}
		broadcastProjectsChanged();
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/projects/:id/folders/:folderId:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書をプロジェクトの指定フォルダ(またはプロジェクト直下)へ登録/移動する (admin/readwrite)
 * body: {folderId?} (省略/nullでプロジェクト直下)。ドラッグ&ドロップによる登録・移動の実処理
 */
app.put(BASE_URL_PATH + 'api/projects/:id/documents/:documentId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const document = selectDocumentById.get(req.params.documentId);
		if (document == null) {
			res.status(404).json({error: "document not found"});
			return;
		}
		const placement = Projects.placeDocument(req.params.id, req.params.documentId, req.body.folderId || null, req.authData.user_identifier);
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "project_assign",
			documentId: req.params.documentId,
			entryFile: document.entry_file,
			projectId: req.params.id,
			projectName: project.name
		});
		broadcastProjectsChanged();
		res.status(200).json(placement);
	} catch (err) {
		if (err.message === "folder not found") {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/projects/:id/documents/:documentId:place");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * プロジェクトからの文書登録解除 (admin/readwrite。文書自体は消えない)
 */
app.delete(BASE_URL_PATH + 'api/projects/:id/documents/:documentId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const document = selectDocumentById.get(req.params.documentId);
		const removed = Projects.removeDocument(req.params.id, req.params.documentId);
		if (!removed) {
			res.status(404).json({error: "not found"});
			return;
		}
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "project_unassign",
			documentId: req.params.documentId,
			entryFile: document?.entry_file ?? null,
			projectId: req.params.id,
			projectName: project?.name ?? null
		});
		broadcastProjectsChanged();
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/projects/:id/documents/:documentId:remove");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * フォルダ(またはプロジェクト直下)内の文書の並び順を一括で書き換える (admin/readwrite)
 * body: {folderId?, documentIds: [...]} (この配列順がそのまま並び順になる)
 */
app.put(BASE_URL_PATH + 'api/projects/:id/reorder', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const project = Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		if (!Array.isArray(req.body.documentIds)) {
			res.status(400).json({error: "documentIds must be an array"});
			return;
		}
		Projects.reorderDocuments(req.params.id, req.body.folderId || null, req.body.documentIds);
		broadcastProjectsChanged();
		res.status(200).json(Projects.getProjectTree(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/reorder");
		res.status(500).json({error: "Internal Error"});
	}
});


const main = async () => {
	if (!AUTH_DISABLED) {
		oidcConfig = await initOidcClient();
	}
	server.listen(LISTEN_PORT);
	logger.info({LISTEN_PORT}, "server started on port");
	// 前回の起動時に強制終了等でバックグラウンド処理中(processing)のまま残った文書があれば
	// 未処理に戻す(プロセス内キューの情報は再起動で失われるため)。バックフィルより先に行うことで、
	// 未処理へ戻った文書もバックフィル/以後の索引付けで正しく再処理の対象になるようにする
	VectorSearch.recoverStaleProcessing();
	// 過去にアップロードされた(このベクトル検索機能の導入前からある)文書を差分バックフィルする。
	// サーバー起動をブロックしないよう非同期で流す。WEAVIATE_URL未設定時はisEnabled()の時点で
	// 弾き、全文書のcontent_textを読み出すクエリ自体を実行しない(単体SQLiteモードと同じ動作にする)
	if (VectorSearch.isEnabled()) {
		VectorSearch.backfillMissingDocuments(selectActiveDocumentsForIndexing.all());
	}
};

main().catch((err) => {
	logger.error(err, "::main");
	process.exit(1);
});
