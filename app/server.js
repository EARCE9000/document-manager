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

// すべての応答に付ける防御ヘッダー。setHTTPHeaders は各ルートが個別に呼ぶもので、
// 静的配信(express.static)には届かない = 画面本体(index.html)が無防備になるため、
// ここでミドルウェアとして入れる。
//   - X-Frame-Options: 画面を外部サイトのiframeに埋め込ませない(ログイン済みの利用者に
//     気づかせないまま操作させる攻撃を防ぐ)。アプリ自身のiframe(プレビュー・draw.ioビューア)は
//     同一オリジンなので影響しない
//   - Referrer-Policy: 外部サイトへ遷移するとき、文書IDを含むURLを渡さない
// CSPはここでは出さない。形式ごとに必要な内容が違い(html/svgはscript-src 'none'、
// draw.ioビューアは専用のもの、txtやpdfには付けない)、一律に出すと上書き合戦になる
app.use((req, res, next) => {
	res.setHeader("X-Frame-Options", "SAMEORIGIN");
	res.setHeader("Referrer-Policy", "same-origin");
	next();
});

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
// 1ファイルあたりのアップロード上限(バイト)。既定256MB
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 256 * 1024 * 1024);

// セッション管理(express-session)。Cookieの寿命(maxAge)をOIDCプロバイダが発行する
// access_token自体のTTLから切り離すことで、短命なaccess_token(プロバイダ依存)でも
// ブラウザ側のログイン状態を安定して維持できるようにする。
const session = require('express-session');
const oidc = require('openid-client');

// セッションの保存先。既定のMemoryStore(プロセス内メモリ)はプロセス再起動でセッションが
// 消えるうえ、複数インスタンス(ECS/Cloud Run等の水平スケール・ローリングデプロイ)で
// 共有されないため、永続ストアに置き換える。DATABASE_BACKEND環境変数で保存先を切り替える
// (既定はsqlite。将来postgres等を追加すれば全インスタンスでセッションを共有できる)
const {createSessionStore} = require('./lib/session-store.js');

const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (SESSION_SECRET === "") {
	logger.warn("SESSION_SECRET is not set. generating a random value (sessions will be invalidated on every restart)");
}
const SESSION_MAX_AGE_MS = Number(process.env.SESSION_MAX_AGE_HOURS || 8) * 60 * 60 * 1000;

app.use(session({
	store: createSessionStore(session),
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
			// どのクライアント(AIエージェント用Skillのバージョン等)からの呼び出しかを追えるようにする
			userAgent: req.headers["user-agent"] || null,
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

// .drawio をブラウザ上で描画するビューアのページ(static配信より前に置いてヘッダーを足す)。
// 図のラベルにはHTMLを書けるため、このページだけはスクリプトの出どころを自分自身に限定し、
// 図に仕込まれたスクリプト(インラインのイベントハンドラ等)が動かないようにする。
// (iframeのsandboxでオリジンごと落とす手も取れるが、オリジンを持たない文書では
//  ビューア本体のスクリプトを読み込めないため、同一オリジンのままCSPで閉じる)
const DRAWIO_VIEWER_CSP = [
	"default-src 'none'",
	// default-src では frame-ancestors は制限されないため個別に指定する
	// (このページを外部サイトのiframeに埋め込ませない)
	"frame-ancestors 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"frame-ancestors 'self'",
	"base-uri 'none'",
	"form-action 'none'"
].join("; ");
app.get(BASE_URL_PATH + 'drawio-viewer.html', (req, res) => {
	res.setHeader("Content-Security-Policy", DRAWIO_VIEWER_CSP);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.sendFile(path.join(__dirname, 'static', 'drawio-viewer.html'));
});

// static contents (frontend shell; actual data access is gated by requireAuth on api/*)
app.use(express.static(path.join(__dirname, 'static')));

const ApiKeys = require("./lib/api-keys.js");
const AllowedUsers = require("./lib/allowed-users.js");

// AUTH_DISABLED=true の間は認証を全てバイパスする(開発用。本番では未設定のこと)
const AUTH_DISABLED = /^(1|true)$/i.test(process.env.AUTH_DISABLED || "");
if (AUTH_DISABLED) {
	logger.warn("AUTH_DISABLED=true: 認証を無効化して起動しています(開発用途のみ)");
}
const DEV_AUTH_DATA = {user_identifier: "dev-user", role: AllowedUsers.ROLES.ADMIN};

// resolveAuthは、requireAuthと同じ手順(Bearer APIキー→セッションの順)で認証情報を
// 解決するが、失敗しても401を返さずreq.authDataを未設定のまま次へ進める(このモジュールの
// 唯一の役割は、後段のレート制限で「認証済みかどうか」を判定できるようにすること)。
// 実際の認証必須化は従来通りrequireAuth(下部で定義)が担う
// datastore経由の認証判定(AllowedUsers/ApiKeys)がasyncになったため、この関数もasync。
// asyncミドルウェアの例外はExpress4では自動捕捉されずリクエストが宙吊りになるため、
// 全体をtry/catchで囲み、想定外エラー時は認証情報を付けず(=未認証扱いで)next()する
// (従来からresolveRole等がエラー時にnullを返し未認証扱いにしていた挙動を踏襲する)
const resolveAuth = async (req, res, next) => {
	try {
		if (AUTH_DISABLED) {
			req.authData = DEV_AUTH_DATA;
			next();
			return;
		}
		const authorizationHeader = req.headers.authorization || "";
		if (authorizationHeader.startsWith("Bearer ")) {
			const apiKey = authorizationHeader.slice("Bearer ".length).trim();
			const verifyResult = await ApiKeys.verifyApiKey(apiKey);
			if (verifyResult.status === "expired") {
				req.authError = {status: 401, body: {error: "APIキーの有効期限が切れています。新しいキーを発行してください。"}};
				next();
				return;
			}
			if (verifyResult.status === "ok" && await AllowedUsers.isAllowed(verifyResult.row.created_by)) {
				const apiKeyRow = verifyResult.row;
				req.authData = {
					user_identifier: apiKeyRow.created_by,
					viaApiKey: apiKeyRow.label,
					role: apiKeyRow.role,
					// 「サーバーが更新された」を1回だけ知らせるための情報(下記のミドルウェアで使う)。
					// 認証時の照会に相乗りしているため、この取得でクエリは増えていない
					apiKeyId: apiKeyRow.id,
					notifiedBuild: apiKeyRow.notified_build ?? null
				};
			}
			next();
			return;
		}
		if (req.session?.user != null) {
			const role = await AllowedUsers.getRole(req.session.user.identifier);
			if (role != null) {
				req.authData = {user_identifier: req.session.user.identifier, role};
			}
		}
		next();
	} catch (err) {
		logger.error(err, "::resolveAuth");
		next();
	}
};

// レート制限。/loginは総当たり対策のため未認証のまま厳しめの上限をかける。api/*は
// 未認証(総当たり・スクレイピング等の悪用が主目的)と認証済み(正規利用者・AI連携APIキー等)を
// 別枠にする。api/*は全リクエストが原則認証必須なため、未認証側の上限は低めのままでよい一方、
// 認証済み側は複数文書の一括操作等でまとまった量のリクエストが発生するAI連携の実利用を踏まえ、
// 大幅に緩めている(実機でのAI連携テスト中に旧来の一律300/5分へ到達した実績があったため)。
// 認証済み側は、trust proxy配下で複数利用者が同一IPに見える環境(社内共有ネットワーク等)でも
// 利用者ごとに正しく分離されるよう、IPではなく利用者識別子(APIキー発行者/ログインユーザー)で
// カウントする
const {rateLimit, ipKeyGenerator} = require('express-rate-limit');
const RATE_LIMIT_MESSAGE = {error: "リクエストが多すぎます。しばらく待ってから再度お試しください。"};
const apiRateLimiterAnonymous = rateLimit({
	windowMs: 5 * 60 * 1000,
	limit: 300,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: RATE_LIMIT_MESSAGE,
	skip: (req) => req.authData != null
});
const apiRateLimiterAuthenticated = rateLimit({
	windowMs: 5 * 60 * 1000,
	limit: 1000,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: RATE_LIMIT_MESSAGE,
	skip: (req) => req.authData == null,
	// IP フォールバック時は ipKeyGenerator で包み、IPv6 を /64 サブネット単位に正しく集約する
	// (素の req.ip だと IPv6 の完全アドレス単位になり、上限を回避され得る)
	keyGenerator: (req) => req.authData?.user_identifier || ipKeyGenerator(req.ip)
});
const loginRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: RATE_LIMIT_MESSAGE
});
// AIエージェント用クライアント(Skill同梱のdm_client)が古いとき、応答ヘッダーで新しい版を知らせる。
// クライアントはこれを見て、利用者(とそれを操作しているAI)へ更新を促す。
// 判定は User-Agent の "document-manager-skill/<版>" で行い、他の利用者には何も付けない
const SKILL_USER_AGENT = /^document-manager-skill\/(\d+)\.(\d+)\.(\d+)/;

// 数字3つの版を比較する(大きいほど新しい)。解釈できない版は比較しない
const parseVersion = (value) => {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
	return match == null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};
const isOlder = (a, b) => {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (left == null || right == null) return false;
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] < right[i];
	}
	return false;
};

// 同梱クライアントの版は起動後に1度だけ読む(リクエストごとにファイルを読まない)
let bundledSkillClientVersionCache;
const bundledSkillClientVersion = () => {
	if (bundledSkillClientVersionCache === undefined) {
		bundledSkillClientVersionCache = ClaudeSkill.getBundledClientVersion();
	}
	return bundledSkillClientVersionCache;
};

app.use(BASE_URL_PATH + 'api/', (req, res, next) => {
	const match = SKILL_USER_AGENT.exec(String(req.headers["user-agent"] || ""));
	if (match == null) {
		next();
		return;
	}
	const bundled = bundledSkillClientVersion();
	if (bundled != null && isOlder(match[0].split("/")[1], bundled)) {
		// 値はASCIIのみ(ヘッダーに日本語は載せられない)。文面はクライアント側で組み立てる
		res.setHeader("X-Skill-Latest-Version", bundled);
	}
	next();
});

// サーバーが更新されたことを、APIキーごとに1回だけ知らせる。
//
// 手元のクライアントや貼り付けた利用ガイドは、サーバーが新しくなっても古いままになる
// (対応形式やAPIが増えても、AIは知らないものを使わないだけでエラーにならず、誰も気づけない)。
// そこでサーバー側が「変わったこと」を覚えていて教える。
//
// 合図にするのはビルド(VERSION.jsonのVERSION)であって、起動ではない。コンテナはクラッシュ復帰・
// ホスト再起動・ただのrestartでも起動するため、起動を合図にすると何も変わっていないのに
// 知らせてしまい、「出たら本当に変わった」という信号の価値を失う。
// ビルドを記録しておけば、再起動では誰にも知らせず、実際に入れ替わったときだけ1回知らせられる。
//
// 手元のクライアントが古いことを知らせる X-Skill-Latest-Version とは別物。あちらは版の比較だけで
// 決まるので状態を持たない(本当に古いクライアントは毎回言われるべき)。
// 通常はVERSION.json(イメージのビルド時に生成される)から読む。SERVER_BUILD で上書きできる
// のは検証・テスト用(ローカル開発にはVERSION.jsonが無く、この経路を通れないため)
// このプロセスが起動した時刻。コンテナのENTRYPOINTはexec形式でnodeがPID 1のため、
// プロセスの寿命はコンテナの寿命と一致する。「展開して入れ替わったのか、ただ再起動しただけか」を
// 区別するために使う(ビルド時刻と並べて見せる)
const STARTED_AT = new Date().toISOString();

const SERVER_BUILD = process.env.SERVER_BUILD
	|| (versionInfo != null && versionInfo.VERSION ? String(versionInfo.VERSION) : null);
app.use(BASE_URL_PATH + 'api/', resolveAuth, apiRateLimiterAnonymous, apiRateLimiterAuthenticated, async (req, res, next) => {
	try {
		const auth = req.authData;
		if (SERVER_BUILD == null || auth == null || auth.apiKeyId == null || auth.notifiedBuild === SERVER_BUILD) {
			next();
			return;
		}
		// 記録できたリクエストだけが知らせる(同時に来ても二重に出ない)
		if (await ApiKeys.markNotifiedBuild(auth.apiKeyId, SERVER_BUILD)) {
			res.setHeader("X-Server-Updated", SERVER_BUILD);
		}
	} catch (err) {
		// 知らせられなくても業務に影響は無い
		logger.error(err, "::serverUpdatedNotice");
	}
	next();
});
app.use(BASE_URL_PATH + 'login', loginRateLimiter);

// 外部公開時のパスプレフィックス。ApacheのReverseProxyはこのプレフィックスを
// 剥がしてこのアプリへ転送するため、Express内部のルーティング(BASE_URL_PATH)は
// ルート基準のままでよい。一方でブラウザへ返すリダイレクト先(ログイン/ログアウト/
// ホームの遷移先)は外部から見えるこのプレフィックス基準で組み立てる。
// 環境変数名は他の社内サービス(docker_management等)とそろえてある。
const PUBLIC_BASE_PATH = (process.env.BASE_PATH || "/document_management").replace(/\/+$/, "");

// 外部から見たこのサービスのオリジン(例 https://docs.example.com)。
// リバースプロキシ配下では、リクエストのHostヘッダーは公開URLとして信用できない:
//   - ProxyPreserveHostがOffだと転送先の宛先(コンテナ名:ポート)になり、外から到達できない値になる
//   - 呼び出し側が任意の値を入れられるため、応答に載せると「偽のURLを名乗らせる」余地ができる
// OIDC_REDIRECT_URIは公開URLそのもので、deploy/compose.shが起動時に存在を検査している。
// 設定が無い開発環境(AUTH_DISABLED等)ではnullのままにし、リクエストからの組み立てに戻す
const PUBLIC_ORIGIN = (() => {
	try {
		return new URL(String(process.env.OIDC_REDIRECT_URI)).origin;
	} catch {
		return null;
	}
})();
logger.info({PUBLIC_ORIGIN}, "public origin for URLs in responses");
const APP_ROOT_URI = `${PUBLIC_BASE_PATH}/`;
const LOGIN_URI = `${PUBLIC_BASE_PATH}/login`;

// ログイン後の戻り先(next)として受け入れてよいURLか判定し、安全なら正規化した相対パスを返す
// (受け入れられなければnull)。このアプリ自身のパス配下に限定し、外部へのオープンリダイレクトを防ぐ。
//
// 文字列の前方一致で判定してはいけない。ブラウザ(WHATWG URL)は http/https のような特別スキームで
// バックスラッシュをスラッシュと同等に扱うため、`/\evil.example` はプロトコル相対URLとして
// 解釈され外部サイトへ飛ぶ。`//` だけを弾く実装では素通りする(Expressが通すencodeurlも
// バックスラッシュを符号化しない)。そこでブラウザと同じ規則で実際に解決し、
// オリジンが変わらないことを確かめる。
//
// 返すのは解決後の値であって、受け取った文字列そのものではない。検査した対象と
// リダイレクト先を必ず同じものにするため(表記の違いで判定をすり抜ける余地を残さない)
const SAFE_NEXT_BASE = "https://document-manager.invalid";
const safeNextPath = (value) => {
	if (typeof value !== "string" || value === "") return null;
	try {
		const url = new URL(value, SAFE_NEXT_BASE);
		if (url.origin !== SAFE_NEXT_BASE) return null;
		if (!url.pathname.startsWith(`${PUBLIC_BASE_PATH}/`)) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
};


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

// バージョン情報(画面右下に小さく表示する用)。VERSION.jsonはDockerイメージのビルド時に
// 生成される(Dockerfile参照)ため、ローカル開発環境には無くversionInfoがnullのままになる。
// versionはビルド日付(8桁)、buildは同日に複数回ビルドしたときの区別用に時刻まで含む
app.get(BASE_URL_PATH + 'api/version', async (req, res) => {
	setHTTPHeaders(res);
	const build = versionInfo != null ? String(versionInfo.VERSION || "") : "";
	const match = build.match(/(\d{8})/);
	res.json({
		version: match ? match[1] : null,
		build: build || null,
		revision: versionInfo != null && versionInfo.REVISION ? String(versionInfo.REVISION) : null,
		builtAt: versionInfo != null && versionInfo.BUILT_AT ? String(versionInfo.BUILT_AT) : null
	});
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
const TagOrder = require("./lib/tag-order.js");
const Projects = require("./lib/projects.js");
const ClaudeSkill = require("./lib/claude-skill.js");
const ApiSpec = require("./lib/api-spec.js");
const DocumentLinks = require("./lib/document-links.js");
const AuditLog = require("./lib/audit-log.js");

const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";
const OIDC_SCOPE = process.env.OIDC_SCOPE || "openid profile email";
// プロバイダ側でクライアント登録時に選択した「username claim」に合わせる (既定: email)
const OIDC_USERNAME_CLAIM = process.env.OIDC_USERNAME_CLAIM || "email";

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
				const accessInfo = await AllowedUsers.describeAccess(user_identifier);
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
				// セッションに入っているのは正規化済みの値だが、ここでも再検査する
				// (検査を1箇所の記憶だけに頼らない)
				res.redirect(safeNextPath(transaction?.next) || APP_ROOT_URI);
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
		const next = safeNextPath(req.query.next);
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
			res.status(200).json({user_identifier: DEV_AUTH_DATA.user_identifier, isAdmin: true, role: DEV_AUTH_DATA.role, vectorSearchEnabled: VectorSearch.isEnabled(), mockupsEnabled: MockupStorage.isEnabled()});
			return;
		}

		if (req.session?.user != null) {
			const role = await AllowedUsers.getRole(req.session.user.identifier);
			if (role != null) {
				res.status(200).json({
					user_identifier: req.session.user.identifier,
					isAdmin: role === AllowedUsers.ROLES.ADMIN,
					role,
					vectorSearchEnabled: VectorSearch.isEnabled(),
					// 画面側はこれを見てモックアップの入口を出すか決める(ローカル保存のみ対応)
					mockupsEnabled: MockupStorage.isEnabled()
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
// 実際の認証情報の解決(Bearer APIキー→セッションの順、APIキー発行者のホワイトリスト
// 失効チェック、有効期限切れの個別メッセージ等)はresolveAuth(上部、レート制限の直前に
// api/*全体へグローバル適用済み)が既に行っている。requireAuthはその結果(req.authData/
// req.authError)を見て、未認証なら401を返すだけの薄いゲートになっている
/**
 * エラー応答に添える「AI向け利用ガイドの場所」。手探りでAPIを叩いている相手
 * (自作クライアント、APIキーだけ渡されたAI)が、次に何を読めばよいか分かるようにする。
 *
 * インターネットに公開する前提のため、案内を出すのは「APIキーを提示した相手」に限る。
 * 鍵を一切出していない相手(無認証のスキャン)にまで返すと、鍵を持たない者への道案内に
 * なるだけで、こちらには何の利点もない。ガイド本体は requireAuth の内側にあるため、
 * 場所を知られても中身は読めないが、余計なことを喋らないに越したことはない。
 *
 * `?baseUrl=` は意図的に参照しない。仕様取得APIでは呼び出し側が自分のURLを渡せるようにして
 * いるが、ここで同じことをすると「攻撃者が渡した任意のURLを、ガイドの場所としてAIに読ませる」
 * ことができてしまう。必ずリクエスト自身から組み立てる
 */
const apiGuideHint = (req) => {
	const base = PUBLIC_ORIGIN != null
		? `${PUBLIC_ORIGIN}${PUBLIC_BASE_PATH}`
		: `${req.protocol}://${req.get("host") || ""}${BASE_URL_PATH}`.replace(/\/+$/, "");
	return `APIの使い方(AI向け利用ガイド)は GET ${base}/api/usage.md で取得できます(APIキーが必要)`;
};

const requireAuth = (req, res, next) => {
	if (req.authData != null) {
		next();
		return;
	}
	if (req.authError != null) {
		// キーを出したが通らなかった相手(期限切れ・失効・無効)。次に何を読めばよいか示す
		res.status(req.authError.status).json({...req.authError.body, guide: apiGuideHint(req)});
		return;
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
 * ブラウザでログインしたセッションからのみ許可する操作の前段ミドルウェア。requireAuthの後段で使う。
 * APIキー管理(発行・一覧・失効)に使う。APIキーでAPIキーを発行できると、期限が切れる前に
 * キー自身が新しいキーを作り直せてしまい、有効期限の上限(最長1年)が意味を持たなくなるため。
 */
const requireSession = (req, res, next) => {
	if (req.authData.viaApiKey == null) {
		next();
		return;
	}
	res.status(403).json({error: "APIキーの管理は画面(ログイン)からのみ行えます"});
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
const ds = require("./lib/datastore.js");
const VectorSearch = require("./lib/vector-search.js");
const {extractDrawioText} = require("./lib/drawio.js");
const {OFFICE_EXTENSIONS, convertOfficeDocument} = require("./lib/office.js");
const OfficeRender = require("./lib/office-render.js");
const DbIntegrity = require("./lib/db-integrity.js");
const StorageReconcile = require("./lib/storage-reconcile.js");
const Mockups = require("./lib/mockups.js");
const MockupStorage = require("./lib/mockup-storage.js");
const MockupZip = require("./lib/mockup-zip.js");
const MockupToken = require("./lib/mockup-token.js");

const MHTML_EXTENSIONS = [".mhtml", ".mht"];
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
const IMAGE_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg"];
const CSV_EXTENSIONS = [".csv", ".tsv"];
const PLAIN_TEXT_EXTENSIONS = [".txt", ".log", ".json"];
const NATIVE_PREVIEW_EXTENSIONS = [".html", ".htm", ".pdf"];
// draw.io のネイティブ形式。ブラウザでは直接描画できないため、実体(=ダウンロード対象)は
// .drawio のまま保持し、プレビューはアップロード時に一緒に送られた画像(svg/png等)を用いる
// (サーバ側ではXML→画像変換はしない)。XML内のラベルは全文検索用に抽出する。
const DRAWIO_EXTENSIONS = [".drawio"];
// Excel/Word/PowerPoint(OOXML)。ブラウザは描画できないため、アップロード時に概要プレビュー用の
// HTMLへ変換する(lib/office.js)。元の体裁は再現しない。実体は元のまま保持しダウンロードできる
const OFFICE_FILE_EXTENSIONS = [...OFFICE_EXTENSIONS];
const ENTRY_FILE_EXTENSIONS = [...NATIVE_PREVIEW_EXTENSIONS, ...MHTML_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...IMAGE_EXTENSIONS, ...CSV_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS, ...DRAWIO_EXTENSIONS, ...OFFICE_FILE_EXTENSIONS];
/**
 * アップロードされたファイル名として受け入れてよいか。
 *
 * この名前は保存先の組み立てに使われる。しかも使うのはサーバだけではなく、応答(entryFile)
 * として利用者とAIエージェントへ渡り、クライアント(同梱のdm_client等)がローカルの保存先
 * としても使う。区切り文字が混じった名前が記録されると、受け取った側で作業場所の外へ
 * 書かせることができてしまう。
 *
 * 現時点では、ここへ届く前に busboy(multipartの解析)が独自のbasenameで `/` と `\` の
 * 両方を落とし、".."と"."は空文字にしている(app/node_modules/busboy/lib/utils.js)。
 * つまりこの判定は今のところ通過するだけで、脆弱性を塞いでいるわけではない。
 * それでも置いておくのは、安全性が「上流ライブラリの実装詳細」だけに依存している状態を
 * 避けるため(バージョン更新や別ライブラリへの差し替えで静かに崩れる)。
 * 判定はプラットフォームに依存しない形にしてある。
 */
const isSafeEntryFileName = (name) =>
	typeof name === "string" &&
	name !== "" &&
	name !== "." &&
	name !== ".." &&
	!name.includes("/") &&
	!name.includes("\\") &&
	// 制御文字(NUL・改行等)。NULはfsが例外を投げて500になっていたため、ここで400にする
	!/[\u0000-\u001f\u007f]/.test(name);

/**
 * Content-Disposition の値を組み立てる。
 *
 * ファイル名は利用者が決めた値なので、ヘッダーを壊されないことが第一。従来は
 * `filename="${encodeURIComponent(name)}"` としていて安全ではあったが、日本語名が
 * `%E6%97%A5...` のまま保存されてしまう。RFC 6266 のとおり、ASCIIに落とした
 * `filename` と、UTF-8を明示した `filename*` の両方を出す(対応する環境では後者が使われる)。
 * どちらの値も符号化済み・引用符を含まないため、ヘッダーの分割はできない。
 */
const contentDisposition = (type, name) => {
	const safe = String(name || "download");
	// ASCII以外・引用符・制御文字を落とした控えめな名前(古い環境向けのフォールバック)
	// eslint-disable-next-line no-control-regex
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
};

const PREVIEW_FILENAME = "preview.html";
// .drawio に添付できるプレビュー画像の拡張子(IMAGE_EXTENSIONSと同じ。保存名は preview<ext>)
const DRAWIO_PREVIEW_EXTENSIONS = IMAGE_EXTENSIONS;

// ブラウザ上でスクリプトを実行し得る(=アップロードされた内容がそのまま配信されると
// 保存型XSSになり得る)形式。これらをinline配信する際は、下記ACTIVE_CONTENT_CSPを付けて
// スクリプト実行を無効化する。mhtml/md/markdown/csv/tsv は preview.html(=.html)へ変換して
// 配信されるためこの.htmlで捕捉される。png/jpg/pdf/txt/log/json はスクリプトを実行しないため
// 対象外(特にpdfはブラウザのネイティブPDFビューアの挙動を尊重してCSPを付けない)
const ACTIVE_CONTENT_EXTENSIONS = [".html", ".htm", ".svg"];
// プレビュー表示(画像・CSS・フォント等の描画)は一切損なわず、スクリプト実行・プラグイン・
// フォーム送信・baseタグ乗っ取りだけを無効化する。default-srcは指定しないため、文書内の
// 画像/スタイル等の読み込みは従来どおり動く。アプリ内iframe(sandbox="allow-same-origin")では
// 元々スクリプトが動かないが、別ウィンドウ/共有リンク(api/documents/:id/viewer)や
// api/documents/:id/file への直接アクセスはトップレベル文書となりサンドボックスが効かないため、
// レスポンスヘッダーのCSPで防ぐ(SVGのトップレベル配信にも効かせるためmetaではなくヘッダーで付与する)
const ACTIVE_CONTENT_CSP = "script-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

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
	".json": "application/json; charset=utf-8",
	".drawio": "application/xml; charset=utf-8",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".docm": "application/vnd.ms-word.document.macroEnabled.12",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
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

// Office(Excel/Word/PowerPoint)の概要プレビュー。元の体裁は再現しないため、
// 「概要表示であること」を上部に明示し、原本はダウンロードしてもらう
const OFFICE_PREVIEW_TEMPLATE = (bodyHtml) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">
<style>
body { font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; margin: 1em; line-height: 1.7; color: #24292f; }
.previewNotice { background: #fff8e6; border: 1px solid #f0d58c; color: #8a6d00; border-radius: 4px; padding: 6px 10px; font-size: 0.85em; margin-bottom: 1em; }
h2 { font-size: 1.1em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; margin-top: 1.6em; }
h3 { font-size: 1em; }
section.slide { border-left: 3px solid #9cc2ff; padding-left: 0.8em; }
.tableWrap { overflow-x: auto; }
table { border-collapse: collapse; font-size: 0.85em; white-space: nowrap; }
td, th { border: 1px solid #ddd; padding: 0.3em 0.7em; text-align: left; }
tr:nth-child(even) td { background: #fafbfc; }
ul { margin: 0.3em 0; }
.note { color: #666; font-size: 0.85em; }
</style>
</head><body>
<div class="previewNotice">内容の概要を表示しています(書式・図・グラフは再現しません)。原本はダウンロードしてください。</div>
${bodyHtml}</body></html>`;

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
const buildPreviewFile = async (documentId, originalName, extension, officeContent) => {
	try {
		// Office文書は概要HTMLへ変換する(変換できなければプレビュー不可。ダウンロードは可能)
		if (OFFICE_FILE_EXTENSIONS.includes(extension)) {
			if (officeContent == null) return null;
			await storage.writeFile(documentId, PREVIEW_FILENAME, Buffer.from(OFFICE_PREVIEW_TEMPLATE(officeContent.bodyHtml), "utf-8"));
			return PREVIEW_FILENAME;
		}
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

// .drawio と一緒にアップロードされたプレビュー画像(svg/png等)を保存し、保存名を返す。
// 画像が無ければ null(=プレビュー不可。ダウンロードは可能)。呼び出し元で拡張子は検証済み。
const storeDrawioPreview = async (documentId, previewUpload) => {
	if (previewUpload == null) return null;
	const previewName = path.basename(fixUploadedFilenameEncoding(String(previewUpload.name || "")));
	const previewExt = path.extname(previewName).toLowerCase();
	// 保存名は preview<ext> に統一(プレビュー配信時の Content-Type は拡張子から決まる)
	const storedName = `preview${previewExt}`;
	await storage.writeFile(documentId, storedName, previewUpload.data);
	return storedName;
};

// 全文検索用に本文のプレーンテキストを抽出する (失敗時は null。検索対象から外れるだけで他の処理には影響しない)
const extractContentText = async (documentId, originalName, extension, previewFile, officeContent) => {
	try {
		// Office文書はプレビュー用の変換で取り出したテキストをそのまま使う(二重に解析しない)
		if (OFFICE_FILE_EXTENSIONS.includes(extension)) {
			return officeContent == null || officeContent.text === "" ? null : officeContent.text;
		}
		// .drawio はXMLなので、ページ名・図形ラベルを入口ファイル(=XML)から直接抽出する
		// (プレビューは画像のためテキストは取れない。画像向け分岐より先に捕捉する)
		if (DRAWIO_EXTENSIONS.includes(extension)) {
			const xml = (await storage.readFile(documentId, originalName)).toString("utf-8");
			const text = extractDrawioText(xml);
			return text === "" ? null : text;
		}
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

/* _/_/_/ Office文書の体裁つき表示(PDF変換) _/_/_/ */

const SQL_UPDATE_RENDER_STATUS = `
	UPDATE documents SET render_status = @status, render_error = @error, render_file = @file, rendered_at = @rendered_at WHERE id = @id
`;

// アップロード直後に裏で変換する。結果はDBに記録し、画面はSSEの更新通知で拾う。
// 失敗しても文書の登録・検索・概要プレビューには影響させない(体裁つき表示が出ないだけ)
const renderOfficeDocument = async (documentId, buffer, extension) => {
	await ds.run(SQL_UPDATE_RENDER_STATUS, {id: documentId, status: "pending", error: null, file: null, rendered_at: null});
	try {
		const pdf = await OfficeRender.renderToPdf(buffer, extension, documentId);
		await storage.writeFile(documentId, OfficeRender.RENDER_FILENAME, pdf);
		await ds.run(SQL_UPDATE_RENDER_STATUS, {
			id: documentId, status: "ok", error: null,
			file: OfficeRender.RENDER_FILENAME, rendered_at: new Date().toISOString()
		});
		logger.info({documentId, bytes: pdf.length}, "::officeRender:ok");
	} catch (err) {
		await ds.run(SQL_UPDATE_RENDER_STATUS, {
			id: documentId, status: "failed", error: String(err.message).slice(0, 500), file: null, rendered_at: null
		});
		logger.warn({documentId, error: err.message}, "::officeRender:failed");
	}
	// 画面の「体裁つきで開く」ボタンの出し分けを更新させる
	broadcastDocumentsChanged();
};

// 検索用に保存する本文の上限(文字数)。巨大なログ・CSV等を1つ登録しただけでDBが膨らむのを防ぐ。
// 超過分は検索対象から外れるだけで、ファイルの登録・プレビュー・ダウンロードには影響しない
// (ファイル名・タグ・メモは量に関係なく検索できる)
const CONTENT_TEXT_MAX_CHARS = Number(process.env.CONTENT_TEXT_MAX_CHARS || 300000);
// メモ・タグの上限。これらは文書一覧・検索の応答すべてに載り、AIエージェントが必ず読む。
// 人が書くメモとして十分な長さを残しつつ、応答を埋め尽くせないようにする
const MEMO_MAX_CHARS = Number(process.env.MEMO_MAX_CHARS || 4000);
const TAG_MAX_CHARS = 50;
const DOCUMENT_MAX_TAGS = 50;

const truncateContentText = (contentText) => {
	if (contentText == null || contentText.length <= CONTENT_TEXT_MAX_CHARS) {
		return {contentText, truncated: false};
	}
	return {contentText: contentText.slice(0, CONTENT_TEXT_MAX_CHARS), truncated: true};
};

const SQL_INSERT_DOCUMENT = `
	INSERT INTO documents (id, entry_file, preview_file, content_text, size, uploaded_by, uploaded_at, previous_id, content_truncated)
	VALUES (@id, @entry_file, @preview_file, @content_text, @size, @uploaded_by, @uploaded_at, @previous_id, @content_truncated)
`;

const SQL_INSERT_DOCUMENT_FTS = `
	INSERT INTO documents_fts (id, entry_file, content_text)
	VALUES (@id, @entry_file, @content_text)
`;

// アーカイブ(論理削除)された文書は全文検索の索引から外し、復元時に documents の本文から入れ直す。
// これでアーカイブがいくら増えても索引は「アクティブな文書の分」だけに保たれる(SQLite専用。
// Postgresは pg_trgm の部分インデックス(deleted_at IS NULL)で同じ効果を得ている)
const SQL_DELETE_DOCUMENT_FTS = `DELETE FROM documents_fts WHERE id = ?`;
const SQL_REINSERT_DOCUMENT_FTS = `
	INSERT INTO documents_fts (id, entry_file, content_text)
	SELECT id, entry_file, content_text FROM documents
	WHERE id = ? AND id NOT IN (SELECT id FROM documents_fts)
`;

const SQL_SELECT_ACTIVE_DOCUMENTS = `
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo, previous_id, content_truncated, render_status, render_error, render_file
	FROM documents
	WHERE deleted_at IS NULL
	ORDER BY uploaded_at DESC
`;

// 体裁つき表示(PDF)の状態で絞り込む。変換に失敗した文書を探す手段がこれまで無く、
// 管理画面からも「再実行すべき文書」を見つけられなかった
const SQL_SELECT_ACTIVE_DOCUMENTS_BY_RENDER_STATUS = `
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo, previous_id, content_truncated, render_status, render_error, render_file
	FROM documents
	WHERE deleted_at IS NULL AND render_status = ?
	ORDER BY uploaded_at DESC
`;
// 値は限られているため、受け取った文字列をそのままSQLへ渡さず許可リストで確かめる
const RENDER_STATUS_VALUES = ["ok", "pending", "failed"];

// 起動時のベクトル検索バックフィル(過去にアップロードされた文書)用。VectorSearch側で
// 既にWeaviateに登録済みの文書は除外されるため、ここではアクティブな文書を全件渡すだけでよい
const SQL_SELECT_ACTIVE_DOCUMENTS_FOR_INDEXING = `SELECT id, content_text FROM documents WHERE deleted_at IS NULL`;

// ファイル名・本文はFTS5(trigramトークナイザ)で部分一致検索する。日本語等CJKでも
// 単語分割不要で高速だが、3文字未満のクエリはヒットしないためLIKEにフォールバックする
// (タグは元々短い文字列でLIKEで十分高速なため、こちらは常にLIKEのまま)。
const MIN_FTS_QUERY_LENGTH = 3;

const SQL_SEARCH_ACTIVE_DOCUMENTS_BY_LIKE = `
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.memo, d.previous_id
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
`;

const SQL_SEARCH_ACTIVE_DOCUMENTS_BY_FTS = `
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.memo, d.previous_id
	FROM documents d
	WHERE d.deleted_at IS NULL
	AND (
		d.id IN (SELECT id FROM documents_fts WHERE documents_fts MATCH @ftsQuery)
		OR d.memo LIKE '%' || @q || '%'
		OR d.id IN (SELECT document_id FROM document_tags WHERE tag LIKE '%' || @q || '%')
	)
	ORDER BY d.uploaded_at DESC
`;

// Postgresでは FTS5 が無いため、pg_trgm(GINインデックス)で加速される ILIKE 部分一致を使う。
// LIKE版と同じ条件だが ILIKE で大文字小文字を無視する(SQLiteのLIKEの既定挙動に合わせる)
const SQL_SEARCH_ACTIVE_DOCUMENTS_PG = `
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.memo, d.previous_id
	FROM documents d
	LEFT JOIN document_tags t ON t.document_id = d.id
	WHERE d.deleted_at IS NULL
	AND (
		d.entry_file ILIKE '%' || @q || '%'
		OR d.content_text ILIKE '%' || @q || '%'
		OR d.memo ILIKE '%' || @q || '%'
		OR t.tag ILIKE '%' || @q || '%'
	)
	ORDER BY d.uploaded_at DESC
`;

// ユーザー入力をFTS5のフレーズクエリとして安全に組み立てる(演算子等として解釈させない)
const toFtsPhraseQuery = (q) => `"${q.replace(/"/g, '""')}"`;

const searchActiveDocuments = async (q) => {
	if (ds.backend === "postgres") {
		return ds.all(SQL_SEARCH_ACTIVE_DOCUMENTS_PG, {q});
	}
	if (q.length < MIN_FTS_QUERY_LENGTH) {
		return ds.all(SQL_SEARCH_ACTIVE_DOCUMENTS_BY_LIKE, {q});
	}
	try {
		return await ds.all(SQL_SEARCH_ACTIVE_DOCUMENTS_BY_FTS, {ftsQuery: toFtsPhraseQuery(q), q});
	} catch (err) {
		logger.error(err, "::searchActiveDocuments:fts_fallback");
		return ds.all(SQL_SEARCH_ACTIVE_DOCUMENTS_BY_LIKE, {q});
	}
};

// アーカイブ(論理削除済み)一覧・検索。アクティブ一覧と同じ検索方式(FTS5/LIKE)を、
// 対象をdeleted_at IS NOT NULLに変えて流用する
const SQL_SEARCH_DELETED_DOCUMENTS_BY_LIKE = `
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.deleted_by, d.deleted_at, d.memo, d.previous_id
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
`;

const SQL_SEARCH_DELETED_DOCUMENTS_PG = `
	SELECT DISTINCT d.id, d.entry_file, d.preview_file, d.size, d.uploaded_by, d.uploaded_at, d.deleted_by, d.deleted_at, d.memo, d.previous_id
	FROM documents d
	LEFT JOIN document_tags t ON t.document_id = d.id
	WHERE d.deleted_at IS NOT NULL
	AND (
		d.entry_file ILIKE '%' || @q || '%'
		OR d.content_text ILIKE '%' || @q || '%'
		OR d.memo ILIKE '%' || @q || '%'
		OR t.tag ILIKE '%' || @q || '%'
	)
	ORDER BY d.deleted_at DESC
`;

// アーカイブ済みはFTSの索引に載せていないため、本文へのLIKEで検索する(索引なしの走査だが、
// 1万件規模でも実測で100ms未満。アーカイブ画面は利用頻度も低い)。Postgresも本文の索引は
// アクティブ限定のため、こちらは索引なしのILIKEになる
const searchDeletedDocuments = async (q) => {
	if (ds.backend === "postgres") {
		return ds.all(SQL_SEARCH_DELETED_DOCUMENTS_PG, {q});
	}
	return ds.all(SQL_SEARCH_DELETED_DOCUMENTS_BY_LIKE, {q});
};

const SQL_SELECT_ACTIVE_DOCUMENT_BY_ID = `
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo, previous_id, content_truncated, render_status, render_error, render_file
	FROM documents
	WHERE id = ? AND deleted_at IS NULL
`;

// アーカイブ済み文書もプレビュー/ダウンロードできるよう、状態を問わずidだけで引く
const SQL_SELECT_DOCUMENT_BY_ID = `
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, memo, previous_id, deleted_by, deleted_at, content_truncated, render_status, render_error, render_file
	FROM documents
	WHERE id = ?
`;

// 文書復元時、ベクトル検索インデックス(Weaviate)へ再登録するためだけに使う
const SQL_SELECT_CONTENT_TEXT_BY_ID = `SELECT content_text FROM documents WHERE id = ?`;

const SQL_SOFT_DELETE_DOCUMENT = `
	UPDATE documents SET deleted_at = @deleted_at, deleted_by = @deleted_by
	WHERE id = @id AND deleted_at IS NULL
`;

const SQL_SELECT_DELETED_DOCUMENTS = `
	SELECT id, entry_file, preview_file, size, uploaded_by, uploaded_at, deleted_by, deleted_at, memo, previous_id, content_truncated, render_status, render_error, render_file
	FROM documents
	WHERE deleted_at IS NOT NULL
	ORDER BY deleted_at DESC
`;

const SQL_RESTORE_DOCUMENT = `
	UPDATE documents SET deleted_at = NULL, deleted_by = NULL
	WHERE id = ? AND deleted_at IS NOT NULL
`;

const SQL_UPDATE_DOCUMENT_MEMO = `UPDATE documents SET memo = ? WHERE id = ?`;
// 後から版を紐づける/解除する(アップロード時以外でprevious_idを書き換えるのはここだけ)
const SQL_UPDATE_DOCUMENT_PREVIOUS_ID = `UPDATE documents SET previous_id = ? WHERE id = ?`;

const SQL_SELECT_TAGS_BY_DOCUMENT_ID = `SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`;
const SQL_DELETE_TAGS_BY_DOCUMENT_ID = `DELETE FROM document_tags WHERE document_id = ?`;
// ON CONFLICT DO NOTHING はSQLite(3.24+)・Postgres双方で有効(旧 INSERT OR IGNORE の可搬形)。
// document_tags は PRIMARY KEY(document_id, tag) のため重複挿入は無視される
const SQL_INSERT_TAG = `INSERT INTO document_tags (document_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING`;
// 版の紐付け: previous_idで「この文書が置き換えた旧版」を持つ。新版(next)は逆引きで求める。
// 旧版1つにつき新版は1つだけ(アップロード時に既に新版がある旧版の指定は409で拒否する)だが、
// 念のため新しいものを優先して1件に絞る
const SQL_SELECT_NEXT_VERSION_ID = `SELECT id FROM documents WHERE previous_id = ? ORDER BY uploaded_at DESC LIMIT 1`;
// 版履歴を辿る上限(循環や異常データで無限ループしないための保険)
const MAX_VERSION_CHAIN = 200;

const replaceDocumentTags = async (documentId, tags) => {
	await ds.transaction(async (tx) => {
		await tx.run(SQL_DELETE_TAGS_BY_DOCUMENT_ID, [documentId]);
		for (const tag of tags) await tx.run(SQL_INSERT_TAG, [documentId, tag]);
	});
};

const toDocumentResponse = async (row) => ({
	id: row.id,
	entryFile: row.entry_file,
	previewFile: row.preview_file,
	size: row.size,
	uploadedBy: row.uploaded_by,
	modified: row.uploaded_at,
	memo: row.memo,
	previousId: row.previous_id ?? null,
	nextId: (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [row.id]))?.id ?? null,
	contentTruncated: row.content_truncated === 1,
	contentTextMaxChars: CONTENT_TEXT_MAX_CHARS,
	// 体裁つき表示(PDF変換)の状態。null=対象外、pending/ok/failed
	renderStatus: row.render_status ?? null,
	renderError: row.render_error ?? null,
	tags: (await ds.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [row.id])).map((tagRow) => tagRow.tag)
});

const toDeletedDocumentResponse = async (row) => ({
	id: row.id,
	entryFile: row.entry_file,
	previewFile: row.preview_file,
	size: row.size,
	uploadedBy: row.uploaded_by,
	modified: row.uploaded_at,
	deletedBy: row.deleted_by,
	deletedAt: row.deleted_at,
	memo: row.memo,
	previousId: row.previous_id ?? null,
	nextId: (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [row.id]))?.id ?? null,
	tags: (await ds.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [row.id])).map((tagRow) => tagRow.tag)
});

/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */
/*
	文書一覧の変更(アップロード/削除)をSSEで全クライアントに通知する。
	接続はメモリ上のSetで保持するため、単一プロセス構成であることが前提。
*/
/* _/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/_/ */

const sseClients = new Set();

// このプロセスに接続しているSSEクライアントへ実際に書き込む(ローカル配信)
const deliverDocumentsChanged = () => {
	for (const client of sseClients) {
		client.write("event: documents-changed\ndata: {}\n\n");
	}
};
const deliverProjectsChanged = () => {
	for (const client of sseClients) {
		client.write("event: projects-changed\ndata: {}\n\n");
	}
};
// 誰かの操作(アップロード・新しい版・タグ付け・アーカイブ・復元)を画面右下のポップアップ通知用に配信する。
// payloadは broadcastActivity() が作るJSON文字列(改行を含まない)をそのまま流す
const deliverDocumentActivity = (payload) => {
	for (const client of sseClients) {
		client.write(`event: document-activity\ndata: ${payload}\n\n`);
	}
};

// 変更通知は datastore の pub/sub 経由で発火する。SQLite(単一インスタンス)ではプロセス内で
// 即座にローカル配信され、Postgres(複数インスタンス)ではLISTEN/NOTIFYで全インスタンスへ伝播し、
// 各インスタンスが自分に繋がるSSEクライアントへ配信する(発行元インスタンスにも届く)。
// 呼び出し側の使い勝手は従来と同じ(broadcast*()を呼ぶだけ)。
const broadcastDocumentsChanged = () => {
	ds.notify("documents_changed").catch((err) => logger.error({err}, "::notify:documents_changed"));
};
const broadcastProjectsChanged = () => {
	ds.notify("projects_changed").catch((err) => logger.error({err}, "::notify:projects_changed"));
};

// 操作通知(ポップアップ用)のペイロードは Postgres の NOTIFY 上限(8000バイト)に収まるよう、
// ファイル名・タグを切り詰めて小さく保つ。userは操作者(APIキー経由ならキーの発行者)、
// viaApiKeyはAPIキー(AIエージェント等)経由の操作かどうか(自分自身の操作でも、APIキー経由なら
// 画面に通知を出すための判定に使う)
const ACTIVITY_MAX_TEXT = 200;
const ACTIVITY_MAX_TAGS = 20;
const truncateText = (value) => (value == null ? null : String(value).slice(0, ACTIVITY_MAX_TEXT));
const broadcastActivity = (req, {action, documentId, entryFile, tags, relatedEntryFile}) => {
	const payload = JSON.stringify({
		action,
		documentId,
		entryFile: truncateText(entryFile),
		relatedEntryFile: relatedEntryFile == null ? undefined : truncateText(relatedEntryFile),
		tags: Array.isArray(tags) ? tags.slice(0, ACTIVITY_MAX_TAGS).map((tag) => String(tag).slice(0, 50)) : undefined,
		user: truncateText(req.authData.user_identifier),
		viaApiKey: req.authData.viaApiKey != null,
		at: new Date().toISOString()
	});
	ds.notify("document_activity", payload).catch((err) => logger.error({err}, "::notify:document_activity"));
};

// 通知チャンネルを購読し、受信したら対応するローカル配信を行う
ds.subscribe(["documents_changed", "projects_changed", "document_activity"], (channel, payload) => {
	if (channel === "documents_changed") {
		deliverDocumentsChanged();
	} else if (channel === "projects_changed") {
		deliverProjectsChanged();
	} else if (channel === "document_activity" && payload) {
		deliverDocumentActivity(payload);
	}
});

// ベクトル索引の状態(processing/ok/error)がバックグラウンドで変化するたびに、SSE経由で
// 「ベクトル索引」画面を開いている全クライアントへ反映する(indexDocumentはawaitせず
// fire-and-forgetで呼ぶため、完了をこの通知でしか知る術がない。詳細はvector-search.js参照)
VectorSearch.setStatusChangeListener(broadcastDocumentsChanged);

/**
 * 文書一覧変更通知 (SSE)
 * ブラウザ(ログインセッション)だけでなく、APIキー(Authorization: Bearer)でも購読できる
 * (readonlyキー可)。イベント: documents-changed / projects-changed(中身は{}。再取得のきっかけ)、
 * document-activity(誰が・どの文書に・何をしたか。JSON)。30秒ごとにコメント行(:heartbeat)を送る。
 * 切断中のイベントは再送しない(Last-Event-IDは未対応)ため、再接続後は必要に応じて一覧を取り直すこと
 */
app.get(BASE_URL_PATH + 'api/documents/events', requireAuth, (req, res) => {
	setHTTPHeaders(res);
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Connection", "keep-alive");
	// nginx等のリバースプロキシがレスポンスをバッファリングしてイベントが遅延・滞留しないようにする
	res.setHeader("X-Accel-Buffering", "no");
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
		const renderStatus = String(req.query.renderStatus || "").trim();
		if (renderStatus !== "" && !RENDER_STATUS_VALUES.includes(renderStatus)) {
			res.status(400).json({error: `renderStatus は ${RENDER_STATUS_VALUES.join(" / ")} のいずれかを指定してください`});
			return;
		}
		let rows;
		if (renderStatus !== "") {
			// 絞り込みは検索語と併用しない(用途が「失敗した文書を探す」に限られるため)
			rows = await ds.all(SQL_SELECT_ACTIVE_DOCUMENTS_BY_RENDER_STATUS, [renderStatus]);
		} else {
			rows = q === "" ? await ds.all(SQL_SELECT_ACTIVE_DOCUMENTS) : await searchActiveDocuments(q);
		}
		const documents = await Promise.all(rows.map(toDocumentResponse));
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
		const documents = [];
		for (const hit of hits) {
			const row = await ds.get(SQL_SELECT_ACTIVE_DOCUMENT_BY_ID, [hit.documentId]);
			if (row == null) {
				continue;
			}
			documents.push({...(await toDocumentResponse(row)), snippet: hit.snippet, distance: hit.distance});
		}
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
			documents: VectorSearch.isEnabled() ? await VectorSearch.listIndexStatuses() : []
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
		res.status(200).json(await VectorSearch.getChunkSettings());
	} catch (err) {
		logger.error(err, "::api/vector-index/settings:get");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトル検索のチャンク分割設定をGUIから変更する(要 admin ロール。システム全体に影響するため)。
 * 変更は新規に索引付けする文書からのみ反映され、既存の索引付け済み文書には遡って適用されない
 */
/**
 * DBと実ファイルの照合(要 admin ロール)。読み取りのみで、何も変更しない。
 */
app.get(BASE_URL_PATH + 'api/storage-reconcile', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(await StorageReconcile.scan(DOCUMENTS_DIR));
	} catch (err) {
		logger.error(err, "::api/storage-reconcile");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 孤立ファイル(実ファイルはあるがDBに無い文書)をDBへ登録し直す(要 admin ロール)。
 *
 * **アーカイブ済みとして登録する**。元がアーカイブ済みだったかを知る手段が無いため、
 * 現役として復活させると一覧が汚れ、版の鎖も壊れて見える。アーカイブなら一覧は汚れず、
 * 必要なら既存の「復元」操作で戻せる(そのとき全文検索とベクトル索引にも入る)。
 *
 * タグ・メモ・版の鎖・アップロード者は、ファイルからは再生できないため空のままになる。
 */
app.post(BASE_URL_PATH + 'api/storage-reconcile/restore', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!StorageReconcile.isSupported()) {
			res.status(503).json({error: "このストレージ構成では対応していません(ローカル保存のみ)"});
			return;
		}
		const id = String(req.body?.id ?? "").trim();
		if (!StorageReconcile.isValidDocumentId(id)) {
			res.status(400).json({error: "文書IDの形式が正しくありません"});
			return;
		}
		if (await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [id]) != null) {
			res.status(409).json({error: "この文書は既にDBへ登録されています"});
			return;
		}
		const found = StorageReconcile.inspectOrphan(DOCUMENTS_DIR, id);
		if (!found.ok) {
			res.status(400).json({error: found.reason});
			return;
		}
		const extension = path.extname(found.entryFile).toLowerCase();
		if (!ENTRY_FILE_EXTENSIONS.includes(extension)) {
			res.status(400).json({error: "対応していない拡張子のため復元できません"});
			return;
		}

		// アップロードと同じ手順でプレビューと全文検索テキストを作り直す
		const buffer = await storage.readFile(id, found.entryFile);
		const officeContent = OFFICE_FILE_EXTENSIONS.includes(extension) ? convertOfficeDocument(buffer, extension) : null;
		const previewFile = extension === ".drawio"
			? null // .drawio は画面側が図をそのまま描画する(代替画像は無ければnullでよい)
			: await buildPreviewFile(id, found.entryFile, extension, officeContent);
		const extracted = await extractContentText(id, found.entryFile, extension, previewFile, officeContent);
		const {contentText, truncated} = truncateContentText(extracted);

		const now = new Date().toISOString();
		await ds.transaction(async (tx) => {
			await tx.run(SQL_INSERT_DOCUMENT, {
				id,
				entry_file: found.entryFile,
				preview_file: previewFile,
				content_text: contentText,
				size: found.sizeBytes,
				// 誰が入れたものか分からないため、復元であることが分かる値を入れる
				uploaded_by: `restored:${req.authData.user_identifier}`,
				// ファイルの更新時刻を採る(IDの年月とずれることがあるが、他に手がかりが無い)
				uploaded_at: found.modifiedAt || now,
				previous_id: null,
				content_truncated: truncated ? 1 : 0
			});
			// アーカイブ済みとして登録する。全文検索の索引には入れない
			// (アーカイブ済みは索引から外す方針のため。「復元」操作で入る)
			await tx.run(SQL_SOFT_DELETE_DOCUMENT, {id, deleted_at: now, deleted_by: `restored:${req.authData.user_identifier}`});
		});

		logger.info({audit: "reconcile_restore", user: req.authData.user_identifier, documentId: id, entryFile: found.entryFile}, "audit");
		broadcastDocumentsChanged();
		res.status(200).json({
			id,
			entryFile: found.entryFile,
			archived: true,
			note: "アーカイブ済みとして登録しました。内容を確認のうえ、必要なら「復元」してください。タグ・メモ・版の紐付けは復元できません"
		});
	} catch (err) {
		logger.error(err, "::api/storage-reconcile/restore");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 変換サービス(converter)の状態(要 admin ロール)。
 *
 * これまで到達性は起動時のログにしか出ておらず、画面から確かめる手段が無かった。
 * 変換が動かないときに「設定していないのか、落ちているのか」を切り分けられるようにする。
 */
app.get(BASE_URL_PATH + 'api/office-render/health', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!OfficeRender.isEnabled()) {
			// 未設定は異常ではない。converterを動かさない構成では概要プレビューだけで成立する
			res.status(200).json({enabled: false, reachable: false, checkedAt: new Date().toISOString()});
			return;
		}
		const health = await OfficeRender.checkHealth();
		res.status(200).json({
			enabled: true,
			reachable: health != null,
			checkedAt: new Date().toISOString(),
			...(health != null ? {
				libreOffice: health.libreOffice ?? null,
				apiVersion: health.apiVersion ?? null,
				maxBytes: health.maxBytes ?? null,
				timeoutSeconds: health.timeoutSeconds ?? null
			} : {})
		});
	} catch (err) {
		logger.error(err, "::api/office-render/health");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * サーバーの状態(要 admin ロール)。
 *
 * 版・起動時刻・DBの状態を1箇所で返す。SSHできない状況でも「展開できたのか」
 * 「ただ再起動しただけか」「DBは壊れていないか」を判断できるようにするのが目的。
 *
 * 公開の api/version には起動時刻を載せない(スキャンに余計な材料を与えない)。
 * DBのファイルはパスではなく名前だけを返す(ディレクトリ構成を晒さない)。
 */
app.get(BASE_URL_PATH + 'api/server-status', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const build = versionInfo != null ? String(versionInfo.VERSION || "") : "";
		// sqliteのときだけ、DBファイルの一覧とサイズを返す。旧バージョンのファイルは移行時に
		// 残す設計のため、ここに並ぶことで「切り戻せる状態か」も分かる
		let database = {backend: ds.backend};
		if (ds.backend === "sqlite") {
			const db = require("./lib/db.js");
			const dir = path.dirname(db.name);
			const current = path.basename(db.name);
			const files = fs.readdirSync(dir)
				.filter((name) => name.endsWith(".sqlite"))
				.sort()
				.map((name) => ({
					name,
					current: name === current,
					sizeBytes: (() => {
						try { return fs.statSync(path.join(dir, name)).size; } catch { return null; }
					})()
				}));
			database = {backend: ds.backend, files};
		}
		res.status(200).json({
			version: versionInfo != null ? (build.match(/(\d{8})/)?.[1] ?? null) : null,
			build: build || null,
			revision: versionInfo != null && versionInfo.REVISION ? String(versionInfo.REVISION) : null,
			builtAt: versionInfo != null && versionInfo.BUILT_AT ? String(versionInfo.BUILT_AT) : null,
			startedAt: STARTED_AT,
			uptimeSeconds: Math.floor(process.uptime()),
			skillClientVersion: bundledSkillClientVersion(),
			database,
			// 起動時に確認した結果。画面を開いただけで検査を走らせないため、前回の結果を見せる
			integrity: DbIntegrity.getLastResult()
		});
	} catch (err) {
		logger.error(err, "::api/server-status");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * DBの整合性を確認する(要 admin ロール)。
 *
 * SQLiteの破損は、書き込みは通り続けたまま一部のページだけ読めなくなる形で進むことがあり、
 * 画面上は正常に見えるのに特定の文書だけ消えている、という気づきにくい壊れ方をする。
 * 起動時にも自動で簡易確認しているが(結果はログ)、任意のタイミングで確認できるようにする。
 *
 * `?mode=full` は索引と表の整合まで検査する。確実だが、better-sqlite3は同期APIのため
 * 検査中はサーバーの他の処理が止まる。大きなDBでは業務時間外に実行すること。
 */
app.get(BASE_URL_PATH + 'api/db-integrity', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const mode = DbIntegrity.MODES.includes(String(req.query.mode)) ? String(req.query.mode) : "quick";
		const result = await DbIntegrity.check(mode);
		if (result.supported && !result.healthy) {
			logger.error({problems: result.problems, problemCount: result.problemCount, user: req.authData.user_identifier}, "DBの整合性に問題が見つかりました");
		}
		res.status(200).json(result);
	} catch (err) {
		logger.error(err, "::api/db-integrity");
		res.status(500).json({error: "Internal Error"});
	}
});

app.put(BASE_URL_PATH + 'api/vector-index/settings', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		const chunkSize = Number(req.body.chunkSize);
		const chunkOverlap = Number(req.body.chunkOverlap);
		const settings = await VectorSearch.updateChunkSettings({chunkSize, chunkOverlap}, req.authData.user_identifier);
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
		res.status(200).json(await VectorSearch.resetChunkSettings());
	} catch (err) {
		logger.error(err, "::api/vector-index/settings:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 現在有効なベクトライザーと、選択可能な候補一覧(環境変数が設定済みかどうか含む)を取得する
 * (要 admin/readwrite ロール。画面表示用)。認証情報そのものは含めない
 */
app.get(BASE_URL_PATH + 'api/vector-index/vectorizer', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(await VectorSearch.getVectorizerSetting());
	} catch (err) {
		logger.error(err, "::api/vector-index/vectorizer:get");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトライザーをGUIから切り替える(要 admin ロール。システム全体に影響するため)。
 * 必要な環境変数が未設定の候補への切り替えは400を返す。切り替えに伴い既存コレクションを
 * 削除し全文書の索引状態を未処理へ戻すため、応答後に「全件を再索引」を行うことを画面側で促す
 */
app.put(BASE_URL_PATH + 'api/vector-index/vectorizer', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		const settings = await VectorSearch.updateVectorizerSetting(String(req.body.vectorizer || ""), req.authData.user_identifier);
		res.status(200).json(settings);
	} catch (err) {
		if (err instanceof Error && /vectorizer|環境変数/.test(err.message)) {
			res.status(400).json({error: err.message});
			return;
		}
		logger.error(err, "::api/vector-index/vectorizer:put");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * ベクトライザーを環境変数の既定値に戻す(要 admin ロール)
 */
app.delete(BASE_URL_PATH + 'api/vector-index/vectorizer', requireAuth, requireAdmin, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!VectorSearch.isEnabled()) {
			res.status(503).json({error: "ベクトル検索は設定されていません(WEAVIATE_URL未設定)"});
			return;
		}
		res.status(200).json(await VectorSearch.resetVectorizerSetting());
	} catch (err) {
		logger.error(err, "::api/vector-index/vectorizer:delete");
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
	// 失敗したときの後始末に使う。try の中で宣言すると catch から見えないため、ここで持つ
	// (見えないままだと後始末が ReferenceError になり、応答を返す前に落ちる)
	let documentId = null;
	const writtenFiles = [];
	let registered = false;
	try {
		setHTTPHeaders(res);
		if (req.files == null || req.files.uploadfile == null) {
			res.status(400).json({error: "uploadfile is required"});
			return;
		}
		const uploadfile = req.files.uploadfile;
		const originalName = path.basename(fixUploadedFilenameEncoding(String(uploadfile.name || "")));
		const extension = path.extname(originalName).toLowerCase();
		// 名前の妥当性を入口で確かめる(下記の判定関数を参照)
		if (!isSafeEntryFileName(originalName)) {
			res.status(400).json({error: "ファイル名にパス区切り文字(/ \\)・制御文字は使用できません"});
			return;
		}
		if (originalName === "" || !ENTRY_FILE_EXTENSIONS.includes(extension)) {
			res.status(400).json({error: "html / mhtml / markdown / pdf / svg / png / jpeg / csv / tsv / txt / log / json / drawio / xlsx / docx / pptx ファイルのみアップロード可能です"});
			return;
		}

		// .drawio のときだけ、同時アップロードされたプレビュー画像(previewfile)を受け付ける。
		// 他形式では previewfile は無視する(プレビューは従来どおりサーバ側で生成/ネイティブ描画)
		const isDrawio = DRAWIO_EXTENSIONS.includes(extension);
		const previewUpload = isDrawio ? (req.files.previewfile ?? null) : null;
		if (previewUpload != null) {
			const previewExt = path.extname(path.basename(fixUploadedFilenameEncoding(String(previewUpload.name || "")))).toLowerCase();
			if (!DRAWIO_PREVIEW_EXTENSIONS.includes(previewExt)) {
				res.status(400).json({error: "プレビュー画像(previewfile)は svg / png / jpg / jpeg のみ指定できます"});
				return;
			}
		}

		// 新しい版としてのアップロード(任意)。previousIdで指定した旧版は、新版の登録と同時に
		// アーカイブし、タグ・プロジェクトの登録(フォルダ・並び順)を新版へ引き継ぐ。
		// 既に新版がある旧版(=最新版ではない)を指定すると版履歴が分岐するため409で拒否する
		const previousId = String(req.body?.previousId ?? "").trim() || null;
		const previousDocument = previousId == null ? null : await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [previousId]);
		if (previousId != null) {
			if (previousDocument == null) {
				res.status(404).json({error: "previousId で指定された旧版の文書が見つかりません"});
				return;
			}
			const existingNextId = (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [previousId]))?.id;
			if (existingNextId != null) {
				res.status(409).json({error: "指定された旧版には既に新しい版があります。最新版の文書IDを指定してください", nextId: existingNextId});
				return;
			}
		}

		const id = `${currentYearMonth()}_${uuidv4()}`;
		// ここから下でファイルを書く。DBへの登録まで到達できなかった場合、書いたものを捨てる。
		// 捨てるのは「このリクエストで書いた名前」だけで、登録に成功したものは決して捨てない
		// (アーカイブは論理削除であり、実ファイルは残す仕様のため)
		documentId = id;
		// uploadfile.mv()はローカルディスク専用のAPIのため使わず、メモリ上のBuffer(uploadfile.data)を
		// storage経由で書き込む(express-fileuploadはuseTempFiles未設定=false相当で常にdataを保持する)
		await storage.writeFile(id, originalName, uploadfile.data);
		writtenFiles.push(originalName);

		// .drawio はXML→画像変換をサーバで行わず、添付されたプレビュー画像をそのまま採用する
		// (無ければ null=プレビュー不可)。それ以外は従来どおり変換/ネイティブ描画を判定する
		// Office文書(Excel/Word/PowerPoint)は、プレビュー用HTMLと全文検索用テキストを
		// 1回の変換でまとめて作る(ZIP+XMLの解析を二度行わないため)
		const officeContent = OFFICE_FILE_EXTENSIONS.includes(extension)
			? convertOfficeDocument(uploadfile.data, extension)
			: null;
		if (officeContent == null && OFFICE_FILE_EXTENSIONS.includes(extension)) {
			logger.warn({documentId: id, entryFile: originalName}, "::api/documents:upload:officeConvertFailed");
		}
		const previewFile = isDrawio
			? await storeDrawioPreview(id, previewUpload)
			: await buildPreviewFile(id, originalName, extension, officeContent);
		// プレビューが実体のファイルとして作られた場合だけ覚える
		// (ネイティブ表示できる形式では previewFile が原本の名前そのものになる)
		if (previewFile != null && previewFile !== originalName) writtenFiles.push(previewFile);
		const extractedText = await extractContentText(id, originalName, extension, previewFile, officeContent);
		const {contentText, truncated} = truncateContentText(extractedText);
		if (truncated) {
			logger.info({documentId: id, entryFile: originalName, chars: extractedText.length, kept: CONTENT_TEXT_MAX_CHARS}, "::api/documents:upload:contentTextTruncated");
		}

		const row = {
			id,
			entry_file: originalName,
			preview_file: previewFile,
			content_text: contentText,
			size: uploadfile.size,
			uploaded_by: req.authData.user_identifier,
			uploaded_at: new Date().toISOString(),
			previous_id: previousId,
			content_truncated: truncated ? 1 : 0
		};
		// 新版の登録と旧版のアーカイブ・引き継ぎは1トランザクションで行い、途中で失敗しても
		// 「新版だけ登録されて旧版が残る」等の中途半端な状態にしない
		let archivedPrevious = false;
		let transferredProjectIds = [];
		await ds.transaction(async (tx) => {
			await tx.run(SQL_INSERT_DOCUMENT, row);
			// documents_fts はSQLite(FTS5)専用。Postgresではpg_trgmインデックスで代替するため不要
			if (ds.backend === "sqlite") {
				await tx.run(SQL_INSERT_DOCUMENT_FTS, row);
			}
			if (previousDocument != null) {
				for (const tagRow of await tx.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [previousId])) {
					await tx.run(SQL_INSERT_TAG, [id, tagRow.tag]);
				}
				transferredProjectIds = await Projects.transferPlacements(tx, previousId, id);
				// 既にアーカイブ済みの旧版を指定した場合は紐付けと引き継ぎだけ行う
				const archiveResult = await tx.run(SQL_SOFT_DELETE_DOCUMENT, {
					id: previousId,
					deleted_at: row.uploaded_at,
					deleted_by: req.authData.user_identifier
				});
				archivedPrevious = archiveResult.changes > 0;
				if (archivedPrevious && ds.backend === "sqlite") {
					await tx.run(SQL_DELETE_DOCUMENT_FTS, [previousId]);
				}
			}
		});
		// ここまで来たらDBへの登録は終わっている。以降で何が起きてもファイルは捨てない
		registered = true;

		// ベクトル検索(Weaviate)への索引登録はベストエフォート・非同期(埋め込み計算に数秒
		// かかるため、awaitせずバックグラウンドで実行しアップロードAPIの応答をブロックしない。
		// WEAVIATE_URL未設定/接続失敗でもアップロード自体は成功させる。詳細はlib/vector-search.js参照)
		VectorSearch.indexDocument(id, contentText).catch((err) => logger.error({err, documentId: id}, "::api/documents:upload:indexDocument"));

		// Office文書の体裁つき表示(PDF変換)。待たせないよう裏で進め、終わったらSSEで画面を更新する
		if (OfficeRender.isRenderable(extension, uploadfile.data.length)) {
			renderOfficeDocument(id, uploadfile.data, extension)
				.catch((err) => logger.error({err, documentId: id}, "::api/documents:upload:renderOfficeDocument"));
		}
		logger.info({
			audit: "upload",
			user: req.authData.user_identifier,
			documentId: id,
			entryFile: originalName
		}, "audit");
		AuditLog.record({userIdentifier: req.authData.user_identifier, action: "upload", documentId: id, entryFile: originalName});
		if (archivedPrevious) {
			VectorSearch.removeDocument(previousId).catch((err) => logger.error({err, documentId: previousId}, "::api/documents:upload:removePreviousDocument"));
			logger.info({
				audit: "supersede",
				user: req.authData.user_identifier,
				documentId: previousId,
				nextId: id,
				projectIds: transferredProjectIds
			}, "audit");
			AuditLog.record({userIdentifier: req.authData.user_identifier, action: "supersede", documentId: previousId, entryFile: previousDocument.entry_file});
		}
		broadcastDocumentsChanged();
		if (transferredProjectIds.length > 0) {
			broadcastProjectsChanged();
		}
		broadcastActivity(req, {action: previousDocument != null ? "revise" : "upload", documentId: id, entryFile: originalName});

		res.status(200).json(await toDocumentResponse(row));
	} catch (err) {
		logger.error(err, "::api/documents:upload");
		// 書いたファイルを残さない。残すとDBに無いファイルが失敗のたびに増え続ける
		// (管理画面の「DBと実ファイルの照合」で拾えるが、そもそも作らないほうがよい)。
		// 後始末で失敗しても応答は変えない(利用者にできることが無いため、ログに残して終える)
		if (!registered && documentId != null && writtenFiles.length > 0) {
			try {
				// 捨てる直前に、その文書がDBに無いことをDBへ問い合わせて確かめる。
				// registeredフラグだけに頼らない(フラグの置き場所を将来動かしたときに、
				// 登録済みの文書のファイルを消してしまう事故を、これで防ぐ)。
				// 失敗したリクエストでしか通らない経路なので、問い合わせが1回増えても影響しない
				if (await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [documentId]) != null) {
					logger.error({documentId}, "::api/documents:upload:discard: DBに登録済みのため捨てません");
				} else {
					await storage.discardUpload(documentId, writtenFiles);
					logger.info({documentId, files: writtenFiles}, "::api/documents:upload:discard: 登録できなかったファイルを捨てました");
				}
			} catch (discardErr) {
				logger.error({err: discardErr, documentId, files: writtenFiles}, "::api/documents:upload:discard");
			}
		}
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
	const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
	if (document == null) {
		res.status(404).json({error: "not found"});
		return;
	}
	const isDownload = "download" in req.query;
	// ?source=1 は .drawio の原本(XML)をブラウザ上のビューアへ渡すためのもの。
	// 画像化を挟まず描画するために使う(drawio-viewer.html参照)。ダウンロードではないため
	// 監査ログは残さず、添付ファイル扱いにもしない。他の形式では使えない
	const isDrawioSource = "source" in req.query && DRAWIO_EXTENSIONS.includes(path.extname(document.entry_file || "").toLowerCase());
	if ("source" in req.query && !isDrawioSource) {
		res.status(400).json({error: "source=1 は .drawio でのみ使えます"});
		return;
	}
	// ?render=1 は Office文書を体裁つき(PDF)で見るためのもの。変換できていなければ404
	const isRender = "render" in req.query;
	if (isRender && document.render_file == null) {
		res.status(404).json({error: "体裁つきの表示は用意されていません", renderStatus: document.render_status ?? null});
		return;
	}
	const targetFile = isRender ? document.render_file
		: (isDownload || isDrawioSource ? document.entry_file : document.preview_file);
	if (targetFile == null) {
		res.status(404).json({error: "preview not available"});
		return;
	}
	if (!(await storage.exists(document.id, targetFile))) {
		res.status(404).json({error: "not found"});
		return;
	}
	const extension = path.extname(targetFile).toLowerCase();
	// .drawio の原本はXMLだが、ブラウザが直接開いたときにマークアップとして解釈しないよう
	// テキストとして返す(取り込み先のビューアはfetchで文字列として読む)
	res.setHeader("Content-Type", isDrawioSource ? "text/plain; charset=utf-8" : (CONTENT_TYPE_BY_EXTENSION[extension] || "application/octet-stream"));
	// スクリプトを実行し得る形式(html/htm/svg)は、inline配信・別ウィンドウ・直接アクセスの
	// いずれでもスクリプトが走らないようCSPで無効化する(保存型XSS対策)。画像/CSS等の描画には
	// 影響しないためプレビュー表示は従来どおり。ダウンロード(attachment)時も念のため付けておく
	if (ACTIVE_CONTENT_EXTENSIONS.includes(extension) || isDrawioSource) {
		res.setHeader("Content-Security-Policy", ACTIVE_CONTENT_CSP);
	}
	if (isDownload) {
		logger.info({
			audit: "download",
			user: req.authData.user_identifier,
			documentId: document.id,
			entryFile: document.entry_file
		}, "audit");
		res.setHeader("Content-Disposition", contentDisposition("attachment", document.entry_file));
	} else {
		res.setHeader("Content-Disposition", contentDisposition("inline", targetFile));
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
			const role = req.session?.user != null ? await AllowedUsers.getRole(req.session.user.identifier) : null;
			if (role == null) {
				res.redirect(`${LOGIN_URI}?next=${encodeURIComponent(PUBLIC_BASE_PATH + req.originalUrl)}`);
				return;
			}
			req.authData = {user_identifier: req.session.user.identifier, role};
		}
		// .drawio は画像化していないため、ブラウザ上で描画するビューアのページへ送る
		// (ログインの確認はここで済ませてある。ビューア側が図のXMLを取りに来る)
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document != null && DRAWIO_EXTENSIONS.includes(path.extname(document.entry_file || "").toLowerCase())) {
			// 相対パスで返す(このURLは api/documents/<id>/viewer なので3つ上がアプリのルート)。
			// リバースプロキシ配下でも、実際に開かれているURLを基準に解決される
			res.redirect(`../../../drawio-viewer.html?id=${encodeURIComponent(document.id)}`);
			return;
		}
		await serveDocumentFile(req, res);
	} catch (err) {
		handleServeFileError(err, req, res, "::api/documents/:id/viewer");
	}
});

/**
 * 体裁つき表示(PDF変換)の再実行。変換サービスが落ちていた・タイムアウトした場合に使う
 */
app.post(BASE_URL_PATH + 'api/documents/:id/render/retry', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!OfficeRender.isEnabled()) {
			res.status(503).json({error: "体裁つき表示は設定されていません(OFFICE_RENDER_URL未設定)"});
			return;
		}
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const extension = path.extname(document.entry_file || "").toLowerCase();
		if (!OfficeRender.isRenderable(extension, document.size)) {
			res.status(400).json({error: "この文書は体裁つき表示の対象外です(対応: xlsx / docx / pptx、上限あり)"});
			return;
		}
		const buffer = await storage.readFile(document.id, document.entry_file);
		await renderOfficeDocument(document.id, buffer, extension);
		const updated = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [document.id]);
		res.status(200).json({id: document.id, renderStatus: updated.render_status, renderError: updated.render_error});
	} catch (err) {
		logger.error(err, "::api/documents/:id/render/retry");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書削除 (論理削除: documents.deleted_at/deleted_by を設定する。実体ファイルは残す)
 */
app.delete(BASE_URL_PATH + 'api/documents/:id', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const result = await ds.run(SQL_SOFT_DELETE_DOCUMENT, {
			id: req.params.id,
			deleted_at: new Date().toISOString(),
			deleted_by: req.authData.user_identifier
		});
		if (result.changes === 0) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (ds.backend === "sqlite") {
			await ds.run(SQL_DELETE_DOCUMENT_FTS, [req.params.id]);
		}
		VectorSearch.removeDocument(req.params.id).catch((err) => logger.error({err, documentId: req.params.id}, "::api/documents/:id:delete:removeDocument"));
		logger.info({
			audit: "delete",
			user: req.authData.user_identifier,
			documentId: req.params.id
		}, "audit");
		const archivedEntryFile = (await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]))?.entry_file ?? null;
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "delete",
			documentId: req.params.id,
			entryFile: archivedEntryFile
		});
		broadcastDocumentsChanged();
		broadcastActivity(req, {action: "archive", documentId: req.params.id, entryFile: archivedEntryFile});
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/documents/:id:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * アーカイブ(論理削除)済み文書の一覧・検索。通常一覧と同じ検索方式(FTS5/LIKE)を使う (要 admin/readwrite ロール)
 *
 * 同じ処理を2つのパスで公開している:
 *   - api/documents/archived … 推奨。この機能は「ゴミ箱」ではなくGmail風のアーカイブ(復元可能・実ファイルも残る)
 *     であり、trash(ゴミ箱)という名前だとAI連携時に「削除済み」「完全削除」と誤解されやすいため
 *   - api/documents/trash    … 従来のパス。既存の利用者・AIの認識を壊さないよう残している
 */
const listArchivedDocuments = async (req, res) => {
	try {
		setHTTPHeaders(res);
		const q = String(req.query.q || "").trim();
		const rows = q === "" ? await ds.all(SQL_SELECT_DELETED_DOCUMENTS) : await searchDeletedDocuments(q);
		res.status(200).json(await Promise.all(rows.map(toDeletedDocumentResponse)));
	} catch (err) {
		logger.error(err, "::api/documents/archived:list");
		res.status(500).json({error: "Internal Error"});
	}
};
app.get(BASE_URL_PATH + 'api/documents/archived', requireAuth, requireWrite, listArchivedDocuments);
app.get(BASE_URL_PATH + 'api/documents/trash', requireAuth, requireWrite, listArchivedDocuments);

// 単一文書の応答。アーカイブ済みかどうか(archived)も含める(版履歴から旧版を開く場合など、
// 通常一覧/アーカイブ一覧のどちらに属するかを呼び出し側が知らなくても扱えるようにするため)
const toSingleDocumentResponse = async (row) => ({
	...(await toDocumentResponse(row)),
	archived: row.deleted_at != null,
	deletedBy: row.deleted_by ?? null,
	deletedAt: row.deleted_at ?? null
});

/**
 * 文書のメタ情報を1件取得する(アーカイブ済みも対象)
 */
app.get(BASE_URL_PATH + 'api/documents/:id', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(await toSingleDocumentResponse(document));
	} catch (err) {
		logger.error(err, "::api/documents/:id:get");
		res.status(500).json({error: "Internal Error"});
	}
});

// 後から版を紐づけるとき用。循環(A→B→…→A)を作らないよう、対象文書から新版方向へ辿る
const collectNewerVersionIds = async (documentId) => {
	const ids = new Set([documentId]);
	let cursor = documentId;
	while (ids.size < MAX_VERSION_CHAIN) {
		const nextId = (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [cursor]))?.id;
		if (nextId == null || ids.has(nextId)) break;
		ids.add(nextId);
		cursor = nextId;
	}
	return ids;
};

/**
 * 関連文書の一覧。種類も方向も持たない対等な紐付けで、どちらから引いても相手が返る。
 * アーカイブ済みの文書も含む(archivedで判別できる)
 */
app.get(BASE_URL_PATH + 'api/documents/:id/links', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if ((await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id])) == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(await DocumentLinks.listLinks(req.params.id));
	} catch (err) {
		logger.error(err, "::api/documents/:id/links:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 関連文書として紐づける (要 admin/readwrite ロール)。既に紐づいていれば何もしない(冪等)
 */
app.put(BASE_URL_PATH + 'api/documents/:id/links/:relatedId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const {id, relatedId} = req.params;
		if (id === relatedId) {
			res.status(400).json({error: "同じ文書同士は関連づけられません"});
			return;
		}
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [id]);
		const related = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [relatedId]);
		if (document == null || related == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		await DocumentLinks.link(id, relatedId, req.authData.user_identifier);
		logger.info({audit: "link_documents", user: req.authData.user_identifier, documentId: id, relatedId}, "audit");
		broadcastDocumentsChanged();
		broadcastActivity(req, {action: "link_documents", documentId: id, entryFile: document.entry_file, relatedEntryFile: related.entry_file});
		res.status(200).json(await DocumentLinks.listLinks(id));
	} catch (err) {
		logger.error(err, "::api/documents/:id/links:link");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 関連文書の紐付けを解除する (要 admin/readwrite ロール)。文書自体には影響しない
 */
app.delete(BASE_URL_PATH + 'api/documents/:id/links/:relatedId', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const {id, relatedId} = req.params;
		if (!(await DocumentLinks.unlink(id, relatedId))) {
			res.status(404).json({error: "この2つの文書は関連づけられていません"});
			return;
		}
		logger.info({audit: "unlink_documents", user: req.authData.user_identifier, documentId: id, relatedId}, "audit");
		broadcastDocumentsChanged();
		res.status(200).json(await DocumentLinks.listLinks(id));
	} catch (err) {
		logger.error(err, "::api/documents/:id/links:unlink");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 既にある文書同士を、後から「旧版 → この文書」として紐づける (要 admin/readwrite ロール)
 * アップロード時の previousId と同じ結果にする: 旧版をアーカイブし、タグとプロジェクトの登録を引き継ぐ。
 * ただし後からの紐付けでは新版が既に自分のタグ・配置を持つため、タグは和集合にし、
 * 配置は新版が未登録のプロジェクトだけ付け替える(登録済みなら旧版側の登録を外す)
 */
app.put(BASE_URL_PATH + 'api/documents/:id/previous', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const previousId = String(req.body?.previousId ?? "").trim();
		if (previousId === "") {
			res.status(400).json({error: "previousId is required"});
			return;
		}
		if (previousId === document.id) {
			res.status(400).json({error: "自分自身を旧版として指定することはできません"});
			return;
		}
		const previousDocument = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [previousId]);
		if (previousDocument == null) {
			res.status(404).json({error: "previousId で指定された旧版の文書が見つかりません"});
			return;
		}
		if (document.previous_id === previousId) {
			res.status(200).json(await toSingleDocumentResponse(document));
			return;
		}
		if (document.previous_id != null) {
			res.status(409).json({error: "この文書には既に旧版が紐づいています。先に紐付けを解除してください", previousId: document.previous_id});
			return;
		}
		const existingNextId = (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [previousId]))?.id;
		if (existingNextId != null) {
			res.status(409).json({error: "指定された旧版には既に新しい版があります。最新版に対して紐づけてください", nextId: existingNextId});
			return;
		}
		// 旧版が「この文書の新版側」にいると版履歴が循環するため拒否する
		if ((await collectNewerVersionIds(document.id)).has(previousId)) {
			res.status(409).json({error: "指定された文書はこの文書の新しい版のため、旧版として紐づけられません"});
			return;
		}

		let archivedPrevious = false;
		let transferredProjectIds = [];
		await ds.transaction(async (tx) => {
			await tx.run(SQL_UPDATE_DOCUMENT_PREVIOUS_ID, [previousId, document.id]);
			// 旧版のタグのうち、新版が持っていないものを足す(新版のタグは消さない)
			const currentTags = new Set((await tx.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [document.id])).map((row) => row.tag));
			for (const tagRow of await tx.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [previousId])) {
				if (!currentTags.has(tagRow.tag)) {
					await tx.run(SQL_INSERT_TAG, [document.id, tagRow.tag]);
				}
			}
			transferredProjectIds = await Projects.transferPlacements(tx, previousId, document.id);
			const archiveResult = await tx.run(SQL_SOFT_DELETE_DOCUMENT, {
				id: previousId,
				deleted_at: new Date().toISOString(),
				deleted_by: req.authData.user_identifier
			});
			archivedPrevious = archiveResult.changes > 0;
			if (archivedPrevious && ds.backend === "sqlite") {
				await tx.run(SQL_DELETE_DOCUMENT_FTS, [previousId]);
			}
		});

		if (archivedPrevious) {
			VectorSearch.removeDocument(previousId).catch((err) => logger.error({err, documentId: previousId}, "::api/documents/:id/previous:removePreviousDocument"));
			AuditLog.record({userIdentifier: req.authData.user_identifier, action: "supersede", documentId: previousId, entryFile: previousDocument.entry_file});
		}
		logger.info({
			audit: "link_version",
			user: req.authData.user_identifier,
			documentId: document.id,
			previousId,
			archivedPrevious,
			projectIds: transferredProjectIds
		}, "audit");
		broadcastDocumentsChanged();
		if (transferredProjectIds.length > 0) {
			broadcastProjectsChanged();
		}
		broadcastActivity(req, {action: "link_version", documentId: document.id, entryFile: document.entry_file});
		res.status(200).json(await toSingleDocumentResponse(await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [document.id])));
	} catch (err) {
		logger.error(err, "::api/documents/:id/previous:link");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 版の紐付けを解除する (要 admin/readwrite ロール)
 * 紐付けを外すだけで、アーカイブ済みの旧版は自動では戻さない(必要なら復元APIを使う)
 */
app.delete(BASE_URL_PATH + 'api/documents/:id/previous', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (document.previous_id == null) {
			res.status(404).json({error: "この文書には旧版が紐づいていません"});
			return;
		}
		await ds.run(SQL_UPDATE_DOCUMENT_PREVIOUS_ID, [null, document.id]);
		logger.info({audit: "unlink_version", user: req.authData.user_identifier, documentId: document.id, previousId: document.previous_id}, "audit");
		broadcastDocumentsChanged();
		res.status(200).json(await toSingleDocumentResponse(await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [document.id])));
	} catch (err) {
		logger.error(err, "::api/documents/:id/previous:unlink");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 版履歴。指定文書から previous_id を遡り・新版を辿って、古い順に並べた一連の版を返す
 * (旧版はアップロード時にアーカイブされるため、archived付きで返す)
 */
app.get(BASE_URL_PATH + 'api/documents/:id/versions', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const seen = new Set([document.id]);
		const older = [];
		let cursor = document;
		while (cursor.previous_id != null && !seen.has(cursor.previous_id) && seen.size < MAX_VERSION_CHAIN) {
			const previous = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [cursor.previous_id]);
			if (previous == null) break;
			seen.add(previous.id);
			older.unshift(previous);
			cursor = previous;
		}
		const newer = [];
		cursor = document;
		while (seen.size < MAX_VERSION_CHAIN) {
			const nextId = (await ds.get(SQL_SELECT_NEXT_VERSION_ID, [cursor.id]))?.id;
			if (nextId == null || seen.has(nextId)) break;
			const next = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [nextId]);
			if (next == null) break;
			seen.add(next.id);
			newer.push(next);
			cursor = next;
		}
		res.status(200).json(await Promise.all([...older, document, ...newer].map(toSingleDocumentResponse)));
	} catch (err) {
		logger.error(err, "::api/documents/:id/versions");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * 文書復元 (アーカイブ=論理削除の取り消し。要 admin/readwrite ロール)
 */
app.post(BASE_URL_PATH + 'api/documents/:id/restore', requireAuth, requireWrite, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const result = await ds.run(SQL_RESTORE_DOCUMENT, [req.params.id]);
		if (result.changes === 0) {
			res.status(404).json({error: "not found"});
			return;
		}
		// アーカイブ時に全文検索の索引から外しているため、documentsの本文から入れ直す
		if (ds.backend === "sqlite") {
			await ds.run(SQL_REINSERT_DOCUMENT_FTS, [req.params.id]);
		}
		// 論理削除時にWeaviate側のチャンクは削除済みのため、content_textから再登録する
		VectorSearch.indexDocument(req.params.id, (await ds.get(SQL_SELECT_CONTENT_TEXT_BY_ID, [req.params.id]))?.content_text ?? null)
			.catch((err) => logger.error({err, documentId: req.params.id}, "::api/documents/:id/restore:indexDocument"));
		logger.info({
			audit: "restore",
			user: req.authData.user_identifier,
			documentId: req.params.id
		}, "audit");
		const restoredEntryFile = (await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.id]))?.entry_file ?? null;
		AuditLog.record({
			userIdentifier: req.authData.user_identifier,
			action: "restore",
			documentId: req.params.id,
			entryFile: restoredEntryFile
		});
		broadcastDocumentsChanged();
		broadcastActivity(req, {action: "restore", documentId: req.params.id, entryFile: restoredEntryFile});
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
		const document = await ds.get(SQL_SELECT_ACTIVE_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		const rawTags = Array.isArray(req.body.tags) ? req.body.tags : [];
		// タグも応答すべてに載るため、長さと件数に上限を設ける(メモと同じ理由)
		const tags = [...new Set(
			rawTags.map((tag) => String(tag).trim().slice(0, TAG_MAX_CHARS)).filter((tag) => tag !== "")
		)].slice(0, DOCUMENT_MAX_TAGS);

		const previousTags = (await ds.all(SQL_SELECT_TAGS_BY_DOCUMENT_ID, [document.id])).map((row) => row.tag);
		await replaceDocumentTags(document.id, tags);
		broadcastDocumentsChanged();
		// 実際に変わったときだけ通知する。追加されたタグがあればそれを、削除だけなら空配列を載せる
		const addedTags = tags.filter((tag) => !previousTags.includes(tag));
		if (addedTags.length > 0 || previousTags.some((tag) => !tags.includes(tag))) {
			broadcastActivity(req, {action: "tags", documentId: document.id, entryFile: document.entry_file, tags: addedTags});
		}
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
		const document = await ds.get(SQL_SELECT_ACTIVE_DOCUMENT_BY_ID, [req.params.id]);
		if (document == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		// メモは文書一覧・検索の応答すべてに載る。上限が無いと、1件のメモに大量の文章を
		// 仕込むだけでAIエージェントの文脈をほぼ占有でき、そこに書いた指示を「サービスからの
		// 指示」として読ませる余地ができる(ファイル名やSSEには既に上限がある)
		const memo = String(req.body.memo || "").slice(0, MEMO_MAX_CHARS);
		await ds.run(SQL_UPDATE_DOCUMENT_MEMO, [memo === "" ? null : memo, document.id]);
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
		res.status(200).json(await AuditLog.listMine(req.authData.user_identifier));
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
 * API仕様の提供。OpenAPI(機械可読)とAI向け利用ガイド(Markdown)を、同じ定義(lib/api-spec.js)から返す。
 *
 * ベースURL(応答に載せる絶対URL)は、リバースプロキシ配下でも正しくなるよう、呼び出し側が
 * `?baseUrl=` で自分のURLを渡せる(画面はこれを使う)。省略時はリクエストから組み立てる。
 * 値は本文のテキストにしか使わないが、念のため http/https のURLだけを受け付ける
 */
const resolveSpecBaseUrl = (req) => {
	// 受け入れてよいオリジン。公開オリジンが設定されていればそれだけを信じる。
	// リクエスト由来のオリジン(Hostヘッダー)は呼び出し側が名乗れる値なので、
	// 設定がある場合にわざわざ許可リストへ入れる理由がない。
	// 設定が無い開発環境では、リクエスト自身のオリジンに限る
	const allowedOrigins = new Set(
		PUBLIC_ORIGIN != null ? [PUBLIC_ORIGIN] : [`${req.protocol}://${req.get("host") || ""}`]
	);

	const requested = String(req.query.baseUrl || "").trim();
	if (requested !== "" && requested.length <= 500) {
		try {
			const url = new URL(requested);
			// 自分以外のオリジンは受け付けない。ここを通すと「正規のドメインのURLを渡すだけで、
			// ベースURLだけ別サイトに差し替えた利用ガイド」を作れてしまう。AIはそれを信じて
			// 以降の呼び出しを——APIキーを添えて——その別サイトへ送ることになる
			if ((url.protocol === "http:" || url.protocol === "https:") && allowedOrigins.has(url.origin)) {
				return url.href.replace(/\/$/, "");
			}
			logger.warn({requestedOrigin: url.origin}, "::resolveSpecBaseUrl: 自分以外のオリジンを指定されたため無視しました");
		} catch {
			// 不正な値は無視して、リクエストから組み立てた既定値を使う
		}
	}
	// 指定が無い(または受け付けられない)場合。プロキシ配下ではリクエストのHostが内部の宛先に
	// なりうるため、設定された公開オリジンを優先する
	if (PUBLIC_ORIGIN != null) return `${PUBLIC_ORIGIN}${PUBLIC_BASE_PATH}`;
	const base = `${req.protocol}://${req.get("host") || ""}${BASE_URL_PATH}`;
	return base.replace(/\/$/, "");
};

app.get(BASE_URL_PATH + 'api/openapi.json', requireAuth, (req, res) => {
	try {
		setHTTPHeaders(res);
		res.status(200).json(ApiSpec.buildOpenApi({
			baseUrl: resolveSpecBaseUrl(req),
			vectorSearchEnabled: VectorSearch.isEnabled(),
			version: versionInfo != null ? String(versionInfo.VERSION || "0") : "0",
			clientVersion: bundledSkillClientVersion()
		}));
	} catch (err) {
		logger.error(err, "::api/openapi.json");
		res.status(500).json({error: "Internal Error"});
	}
});

app.get(BASE_URL_PATH + 'api/usage.md', requireAuth, (req, res) => {
	try {
		setHTTPHeaders(res);
		res.setHeader("Content-Type", "text/markdown; charset=utf-8");
		res.status(200).send(ApiSpec.buildUsageMarkdown({
			baseUrl: resolveSpecBaseUrl(req),
			vectorSearchEnabled: VectorSearch.isEnabled(),
			version: versionInfo != null ? String(versionInfo.VERSION || "0") : "0",
			clientVersion: bundledSkillClientVersion()
		}));
	} catch (err) {
		logger.error(err, "::api/usage.md");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * Claude Code 用 Skill(document-manager)のZIPをダウンロードする(APIキー管理画面から取得する想定)。
 * 中身は接続情報を含まないクライアント・手順書のみのため、ロールを問わずログイン済みなら取得できる
 */
app.get(BASE_URL_PATH + 'api/claude-skill.zip', requireAuth, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const zip = ClaudeSkill.getSkillZip();
		if (zip == null) {
			res.status(404).json({error: "Skillのファイルがこのサーバーに含まれていません"});
			return;
		}
		res.setHeader("Content-Type", "application/zip");
		res.setHeader("Content-Disposition", `attachment; filename="${ClaudeSkill.SKILL_ZIP_FILENAME}"`);
		res.setHeader("Content-Length", zip.length);
		res.status(200).end(zip);
	} catch (err) {
		logger.error(err, "::api/claude-skill.zip");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * APIキー一覧 (自分が発行したものだけ。平文キーは含まない)
 */
app.get(BASE_URL_PATH + 'api/apikeys', requireAuth, requireSession, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const keys = (await ApiKeys.listApiKeys(req.authData.user_identifier)).map((row) => ({
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
app.post(BASE_URL_PATH + 'api/apikeys', requireAuth, requireSession, async (req, res) => {
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
			res.status(400).json({error: "expiryOption must be one of today/30d/90d/365d"});
			return;
		}
		const created = await ApiKeys.createApiKey(label, role, expiryOption, req.authData.user_identifier);
		res.status(200).json(created);
	} catch (err) {
		logger.error(err, "::api/apikeys:create");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * APIキー失効 (自分が発行したものだけ失効可能)
 */
app.delete(BASE_URL_PATH + 'api/apikeys/:id', requireAuth, requireSession, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const revoked = await ApiKeys.revokeApiKeyById(req.params.id, req.authData.user_identifier);
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
		const users = (await AllowedUsers.listAllowedUsers()).map((row) => ({
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
		await AllowedUsers.addAllowedUser(email, role, req.authData.user_identifier);
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
		const updated = await AllowedUsers.updateAllowedUserRole(req.params.email, role);
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
		const removed = await AllowedUsers.removeAllowedUser(req.params.email);
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
		res.status(200).json(await TagOrder.listTagOrder());
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
		const saved = await TagOrder.replaceTagOrder(req.body.tags, req.authData.user_identifier);
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
		res.status(200).json(await Projects.listProjects());
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
		res.status(200).json(await Projects.listArchivedProjects());
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
		const project = await Projects.createProject(req.body.name, req.authData.user_identifier);
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		await Projects.renameProject(req.params.id, req.body.name);
		broadcastProjectsChanged();
		res.status(200).json(await Projects.getProject(req.params.id));
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
		const archived = await Projects.archiveProject(req.params.id, req.authData.user_identifier);
		if (!archived) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(await Projects.getProject(req.params.id));
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
		const restored = await Projects.restoreProject(req.params.id);
		if (!restored) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(await Projects.getProject(req.params.id));
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
		const updated = await Projects.setProjectLocked(req.params.id, false);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		broadcastProjectsChanged();
		res.status(200).json(await Projects.getProject(req.params.id));
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
		const updated = await Projects.setProjectLocked(req.params.id, true);
		if (!updated) {
			res.status(404).json({error: "not found"});
			return;
		}
		broadcastProjectsChanged();
		res.status(200).json(await Projects.getProject(req.params.id));
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
		const deleted = await Projects.deleteProject(req.params.id);
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
		if (await Projects.getProject(req.params.id) == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(await Projects.getProjectTree(req.params.id));
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const folder = await Projects.createFolder(req.params.id, req.body.name, req.body.parentFolderId || null, req.authData.user_identifier);
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const updated = await Projects.renameFolder(req.params.id, req.params.folderId, req.body.name);
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const result = await Projects.deleteFolder(req.params.id, req.params.folderId);
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.documentId]);
		if (document == null) {
			res.status(404).json({error: "document not found"});
			return;
		}
		const placement = await Projects.placeDocument(req.params.id, req.params.documentId, req.body.folderId || null, req.authData.user_identifier);
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
		const project = await Projects.getProject(req.params.id);
		if (project == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		if (project.locked) {
			respondProjectLocked(res);
			return;
		}
		const document = await ds.get(SQL_SELECT_DOCUMENT_BY_ID, [req.params.documentId]);
		const removed = await Projects.removeDocument(req.params.id, req.params.documentId);
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
		const project = await Projects.getProject(req.params.id);
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
		await Projects.reorderDocuments(req.params.id, req.body.folderId || null, req.body.documentIds);
		broadcastProjectsChanged();
		res.status(200).json(await Projects.getProjectTree(req.params.id));
	} catch (err) {
		logger.error(err, "::api/projects/:id/reorder");
		res.status(500).json({error: "Internal Error"});
	}
});


/* _/_/_/ モックアップ(ビルド済みの静的サイト一式。docs/mockup.md) _/_/_/ */

// 配信する中身は利用者がアップロードしたものなので、拡張子から推測した型をそのまま使わない。
// この表に無いものは「保存してもらう」扱い(application/octet-stream + attachment)にする
const MOCKUP_CONTENT_TYPES = {
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
	".webm": "video/webm", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
	".pdf": "application/pdf"
};

// モックアップのJSを動かすため、スクリプトは止めない。代わりに sandbox でオリジンを落とす。
// こうするとページは origin: null になり、このアプリのAPIにもcookieにも手が届かない
// (実測で確認済み。docs/mockup.md 参照)。allow-scripts 以外は与えないため、
// 親ウィンドウの操作・フォーム送信・ポップアップもできない。
// 取得先(CDN)は制限しない。LLMが作るモックアップはほぼ必ず外部CDNを参照するため
const MOCKUP_VIEW_CSP = "sandbox allow-scripts";

const mockupsEnabled = () => MockupStorage.isEnabled();
const requireMockups = (req, res, next) => {
	if (!mockupsEnabled()) {
		res.status(503).json({error: "モックアップ機能はローカル保存の構成でのみ使えます(STORAGE_BACKEND=local)"});
		return;
	}
	next();
};

/**
 * 現役のモックアップの一覧。`q`で名前・メモ・本文を部分一致検索する。
 */
app.get(BASE_URL_PATH + 'api/mockups', requireAuth, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const items = await Mockups.listMockups({archived: false, q: String(req.query.q || "")});
		res.status(200).json(items);
	} catch (err) {
		logger.error(err, "::api/mockups:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * アーカイブ済み(＝置き換えられた旧版・手でアーカイブしたもの)のモックアップの一覧。
 *
 * 文書のアーカイブ(api/documents/archived)と同じく readwrite 以上に限っている。
 * readonly は「今そこにあるもの」だけを見るロールで、引退したものは見せない。
 * 画面側もこれに合わせ、アーカイブの入口は readwrite 以上にしか出さない。
 */
app.get(BASE_URL_PATH + 'api/mockups/archived', requireAuth, requireWrite, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const items = await Mockups.listMockups({archived: true, q: String(req.query.q || "")});
		res.status(200).json(items);
	} catch (err) {
		logger.error(err, "::api/mockups/archived:list");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * モックアップの登録。`mockupfile`にZIP、`previewfile`に一覧へ出す画像を添える。
 * `previousId`を付けると、その版を置き換えた新しい版として登録する(旧版はアーカイブされる)。
 */
app.post(BASE_URL_PATH + 'api/mockups', requireAuth, requireWrite, requireMockups, fileUpload({
	limits: {fileSize: MockupZip.LIMITS.maxTotalBytes},
	abortOnLimit: true,
	limitHandler: (req, res) => {
		res.status(413).json({error: "ファイルサイズが大きすぎます"});
	}
}), async (req, res) => {
	// 失敗したら書いたものを捨てる。捨ててよいのはこのリクエストで採番したIDのものだけ
	let mockupId = null;
	let written = [];
	let registered = false;
	try {
		setHTTPHeaders(res);
		const upload = req.files == null ? null : req.files.mockupfile;
		if (upload == null) {
			res.status(400).json({error: "mockupfile (ZIP) が必要です"});
			return;
		}
		const zipName = path.basename(fixUploadedFilenameEncoding(String(upload.name || "")));
		if (path.extname(zipName).toLowerCase() !== ".zip") {
			res.status(400).json({error: "ZIPファイルをアップロードしてください"});
			return;
		}
		if (upload.data.length < 4 || upload.data.readUInt32LE(0) !== 0x04034b50) {
			res.status(400).json({error: "ZIPとして読めません"});
			return;
		}

		// プレビュー画像(任意)。拡張子は画像に限る
		const previewUpload = req.files.previewfile ?? null;
		let previewName = null;
		if (previewUpload != null) {
			const ext = path.extname(path.basename(fixUploadedFilenameEncoding(String(previewUpload.name || "")))).toLowerCase();
			if (!IMAGE_EXTENSIONS.includes(ext)) {
				res.status(400).json({error: "プレビュー画像は svg / png / jpg / jpeg を指定してください"});
				return;
			}
			previewName = `preview${ext}`;
		}

		// 新しい版として登録する場合の確認(文書側と同じ考え方)
		const previousId = String(req.body?.previousId ?? "").trim() || null;
		if (previousId != null) {
			const previous = await Mockups.getMockup(previousId);
			if (previous == null) {
				res.status(404).json({error: "previousId で指定されたモックアップが見つかりません"});
				return;
			}
			const existingNext = await Mockups.getNextVersionId(previousId);
			if (existingNext != null) {
				res.status(409).json({error: "指定された版には既に新しい版があります。最新版を指定してください", nextId: existingNext});
				return;
			}
		}

		mockupId = `${currentYearMonth()}_${uuidv4()}`;
		MockupStorage.prepare(mockupId);

		// 展開。受け入れられない書庫なら、書いてしまった分を添えて例外になる
		let extracted;
		try {
			extracted = MockupZip.extract(upload.data, MockupStorage.siteDir(mockupId));
			written = extracted.files.map((file) => file.path);
		} catch (err) {
			written = Array.isArray(err.written) ? err.written : [];
			if (err instanceof MockupZip.MockupZipError) {
				res.status(400).json({error: err.message});
				return;
			}
			throw err;
		}

		MockupStorage.writeFile(mockupId, MockupStorage.ZIP_FILE, upload.data);
		if (previewName != null) MockupStorage.writeFile(mockupId, previewName, previewUpload.data);

		// 全文検索用のテキスト。HTMLから抜くだけで、ビルド済みのJSに埋もれた文言は拾えない
		const contentText = extractMockupText(mockupId, extracted.files);

		const {mockup, archivedPrevious} = await Mockups.createMockup({
			id: mockupId,
			name: String(req.body?.name ?? "").trim() || path.basename(zipName, path.extname(zipName)),
			zipFile: zipName,
			entryFile: extracted.entryFile,
			previewFile: previewName,
			fileCount: extracted.files.length,
			totalBytes: extracted.totalBytes,
			zipBytes: upload.data.length,
			contentText,
            uploadedBy: req.authData.user_identifier,
			previousId
		});
		registered = true;

		logger.info({audit: "mockup_upload", user: req.authData.user_identifier, mockupId, files: extracted.files.length}, "audit");
		res.status(200).json({...mockup, archivedPrevious});
	} catch (err) {
		logger.error(err, "::api/mockups:upload");
		if (mockupId != null && !registered) {
			try {
				MockupStorage.discard(mockupId, written);
				logger.info({mockupId}, "::api/mockups:upload:discard: 登録できなかったファイルを捨てました");
			} catch (discardErr) {
				logger.error({err: discardErr, mockupId}, "::api/mockups:upload:discard");
			}
		}
		if (!res.headersSent) res.status(500).json({error: "Internal Error"});
	}
});

/**
 * HTMLからテキストを抜く(全文検索用)。ビルド済みのJSに埋もれた文言は拾えない。
 */
const extractMockupText = (id, files) => {
	const parts = [];
	let total = 0;
	for (const file of files) {
		if (!/\.html?$/i.test(file.path)) continue;
		if (total >= CONTENT_TEXT_MAX_CHARS) break;
		try {
			const html = fs.readFileSync(path.join(MockupStorage.siteDir(id), file.path), "utf-8");
			const text = htmlToText(html, {wordwrap: false});
			parts.push(text);
			total += text.length;
		} catch {
			// 読めないファイルは飛ばす(モックアップとしては成立するため)
		}
	}
	return truncateContentText(parts.join("\n")).contentText;
};

app.get(BASE_URL_PATH + 'api/mockups/:id', requireAuth, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const mockup = await Mockups.getMockup(req.params.id);
		if (mockup == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json({...mockup, nextId: await Mockups.getNextVersionId(mockup.id)});
	} catch (err) {
		logger.error(err, "::api/mockups/:id");
		res.status(500).json({error: "Internal Error"});
	}
});

app.get(BASE_URL_PATH + 'api/mockups/:id/versions', requireAuth, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const versions = await Mockups.listVersions(req.params.id);
		if (versions == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json(versions);
	} catch (err) {
		logger.error(err, "::api/mockups/:id/versions");
		res.status(500).json({error: "Internal Error"});
	}
});

/** 一覧に出すプレビュー画像 */
app.get(BASE_URL_PATH + 'api/mockups/:id/preview', requireAuth, requireMockups, async (req, res) => {
	try {
		const mockup = await Mockups.getMockup(req.params.id);
		if (mockup == null || mockup.previewFile == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "プレビュー画像はありません"});
			return;
		}
		const buffer = MockupStorage.readFile(mockup.id, mockup.previewFile);
		if (buffer == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "プレビュー画像はありません"});
			return;
		}
		setHTTPHeaders(res);
		res.setHeader("Content-Type", CONTENT_TYPE_BY_EXTENSION[path.extname(mockup.previewFile).toLowerCase()] || "application/octet-stream");
		// 画像にスクリプトを仕込める形式(svg)があるため、ここでも実行を止めておく
		res.setHeader("Content-Security-Policy", ACTIVE_CONTENT_CSP);
		res.status(200).end(buffer);
	} catch (err) {
		logger.error(err, "::api/mockups/:id/preview");
		res.status(500).json({error: "Internal Error"});
	}
});

/** 原本のZIPをダウンロードする */
app.get(BASE_URL_PATH + 'api/mockups/:id/download', requireAuth, requireMockups, async (req, res) => {
	try {
		const mockup = await Mockups.getMockup(req.params.id);
		if (mockup == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "not found"});
			return;
		}
		const buffer = MockupStorage.readFile(mockup.id, MockupStorage.ZIP_FILE);
		if (buffer == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "原本が見つかりません"});
			return;
		}
		logger.info({audit: "mockup_download", user: req.authData.user_identifier, mockupId: mockup.id}, "audit");
		setHTTPHeaders(res);
		res.setHeader("Content-Type", "application/zip");
		res.setHeader("Content-Disposition", contentDisposition("attachment", mockup.zipFile));
		res.status(200).end(buffer);
	} catch (err) {
		logger.error(err, "::api/mockups/:id/download");
		res.status(500).json({error: "Internal Error"});
	}
});

/**
 * モックアップ本体の配信。別ウィンドウで開く前提。
 *
 * ここだけは**スクリプトを止めない**(モックアップの意味が無くなるため)。代わりに
 * sandbox でオリジンを落とし、このアプリのAPI・cookieに手が届かないようにする。
 *
 * ただしオリジンを落とすと、そのページからのCSS・JS・画像の要求は**クロスサイト扱い**になり、
 * SameSite=Lax のセッションcookieが送られてこない。素朴に requireAuth を置くと、
 * HTMLは開けるのに中の部品が全部401で遮断される(実測: ERR_BLOCKED_BY_ORB)。
 * そこで入口(ここは通常のページ遷移なのでcookieが届く)で短時間有効の引換券を発行し、
 * URLのパスに埋めて、その下で配信する。認証を外しているのではなく、認証できた人にだけ
 * 券を渡している。詳しくは lib/mockup-token.js。
 *
 * URLのパスは利用者が送ってくる値なので、展開時とは別にここでも置き場所の内側かを確かめる。
 */
app.get(BASE_URL_PATH + 'api/mockups/:id/view', requireAuth, requireMockups, async (req, res) => {
	try {
		const mockup = await Mockups.getMockup(req.params.id);
		if (mockup == null || mockup.entryFile == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "表示できる入口(index.html)がありません"});
			return;
		}
		const token = MockupToken.issue(mockup.id, req.authData?.user_identifier ?? "unknown");
		const entry = mockup.entryFile.split("/").map(encodeURIComponent).join("/");
		// 入口へ寄せる。以降の相対パスは引換券の下でブラウザが解決する
		res.redirect(`${BASE_URL_PATH}api/mockups/${encodeURIComponent(mockup.id)}/view/${token}/${entry}`);
	} catch (err) {
		logger.error(err, "::api/mockups/:id/view");
		res.status(500).json({error: "Internal Error"});
	}
});

// 引換券で守る配信。requireAuth を置かないのは上のコメントの通りで、cookieが届かないため。
// 券は「そのモックアップ1件・短時間だけ」有効で、偽造できない
app.get(BASE_URL_PATH + 'api/mockups/:id/view/:token/*', requireMockups, async (req, res) => {
	try {
		if (!MockupToken.verify(req.params.token, req.params.id)) {
			setHTTPHeaders(res);
			logger.warn({mockupId: req.params.id}, "::api/mockups/:id/view: 引換券が無効な要求を拒否しました");
			res.status(401).json({error: "表示の有効期限が切れています。もう一度開き直してください"});
			return;
		}
		const mockup = await Mockups.getMockup(req.params.id);
		if (mockup == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "not found"});
			return;
		}
		const target = MockupStorage.resolveSiteFile(mockup.id, req.params[0]);
		if (target == null) {
			setHTTPHeaders(res);
			res.status(404).json({error: "not found"});
			return;
		}
		const extension = path.extname(target).toLowerCase();
		const contentType = MOCKUP_CONTENT_TYPES[extension];

		setHTTPHeaders(res);
		res.setHeader("Content-Security-Policy", MOCKUP_VIEW_CSP);
		if (contentType == null) {
			// 表に無い種類は、ブラウザに解釈させず保存してもらう
			res.setHeader("Content-Type", "application/octet-stream");
			res.setHeader("Content-Disposition", contentDisposition("attachment", path.basename(target)));
		} else {
			res.setHeader("Content-Type", contentType);
		}
		res.status(200).end(fs.readFileSync(target));
	} catch (err) {
		logger.error(err, "::api/mockups/:id/view/:token/*");
		res.status(500).json({error: "Internal Error"});
	}
});

app.put(BASE_URL_PATH + 'api/mockups/:id/memo', requireAuth, requireWrite, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const memo = await Mockups.updateMemo(req.params.id, req.body?.memo);
		if (memo == null && (await Mockups.getMockup(req.params.id)) == null) {
			res.status(404).json({error: "not found"});
			return;
		}
		res.status(200).json({memo: memo ?? ""});
	} catch (err) {
		logger.error(err, "::api/mockups/:id/memo");
		res.status(500).json({error: "Internal Error"});
	}
});

app.put(BASE_URL_PATH + 'api/mockups/:id/name', requireAuth, requireWrite, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		const name = await Mockups.rename(req.params.id, req.body?.name);
		if (name == null) {
			res.status(400).json({error: "名前を指定してください"});
			return;
		}
		res.status(200).json({name});
	} catch (err) {
		logger.error(err, "::api/mockups/:id/name");
		res.status(500).json({error: "Internal Error"});
	}
});

app.delete(BASE_URL_PATH + 'api/mockups/:id', requireAuth, requireWrite, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!await Mockups.archiveMockup(req.params.id, req.authData.user_identifier)) {
			res.status(404).json({error: "not found"});
			return;
		}
		logger.info({audit: "mockup_archive", user: req.authData.user_identifier, mockupId: req.params.id}, "audit");
		res.status(204).end();
	} catch (err) {
		logger.error(err, "::api/mockups/:id:delete");
		res.status(500).json({error: "Internal Error"});
	}
});

app.post(BASE_URL_PATH + 'api/mockups/:id/restore', requireAuth, requireWrite, requireMockups, async (req, res) => {
	try {
		setHTTPHeaders(res);
		if (!await Mockups.restoreMockup(req.params.id)) {
			res.status(404).json({error: "not found"});
			return;
		}
		logger.info({audit: "mockup_restore", user: req.authData.user_identifier, mockupId: req.params.id}, "audit");
		res.status(200).json(await Mockups.getMockup(req.params.id));
	} catch (err) {
		logger.error(err, "::api/mockups/:id/restore");
		res.status(500).json({error: "Internal Error"});
	}
});


// 存在しないAPIパスへの応答。Expressの既定ではHTMLのエラーページが返り、APIとしての
// 約束(常にJSONの {error} を返す)から外れていた。エンドポイント名を推測して叩いたAIが
// 必ず通る場所なので、JSONに揃えたうえで利用ガイドの場所を案内する。
// 叩かれたパスは応答に含めない(AIが読む本文へ任意の文字列を混ぜ込ませないため)
app.use(BASE_URL_PATH + 'api/', (req, res) => {
	setHTTPHeaders(res);
	// 案内は認証を通った相手(正しいキーを持っている=このAPIを使う権利がある)にだけ返す
	const body = {error: "not found"};
	if (req.authData != null) body.guide = apiGuideHint(req);
	res.status(404).json(body);
});


// 最後の受け皿。ここへ来るのは、ルート内でcatchできなかった例外と、ボディの解析に失敗した
// リクエスト(壊れたJSON、壊れたmultipart)。
//
// Expressの既定のエラーハンドラはHTMLを返し、NODE_ENVがproductionでない場合は
// スタックトレースと絶対パスまで本文に載せる。Dockerfileでは NODE_ENV=production を
// 設定しているが、守りを環境変数ひとつに依存させたくない(別の起動方法をした瞬間に漏れる)。
// 明示的に差し替えて、どの環境でも中身を出さず、APIとして一貫したJSONを返す
app.use((err, req, res, next) => {
	logger.error(err, "::unhandledError");
	if (res.headersSent) {
		next(err);
		return;
	}
	setHTTPHeaders(res);
	const status = err != null ? (err.status || err.statusCode) : null;
	const isClientError = typeof status === "number" && status >= 400 && status < 500;
	// ボディが壊れているのは送ってきた側の問題なので400にする(500にすると障害と区別できない)
	const malformedBody = err instanceof SyntaxError
		|| /Malformed part header|Unexpected end of form|Boundary not found|Unsupported content type/i.test(String(err != null ? err.message : ""));
	if (isClientError || malformedBody) {
		res.status(isClientError ? status : 400).json({error: "リクエストを解釈できませんでした"});
		return;
	}
	res.status(500).json({error: "Internal Error"});
});


const main = async () => {
	// DBスキーマの用意。SQLiteはdb.jsのrequire時に作成済みでno-op、Postgresは
	// 接続後にここでスキーマDDLを冪等実行する(datastore.init参照)
	await ds.init();
	if (!AUTH_DISABLED) {
		oidcConfig = await initOidcClient();
	}
	server.listen(LISTEN_PORT);
	logger.info({LISTEN_PORT}, "server started on port");
	// 前回の起動時に強制終了等でバックグラウンド処理中(processing)のまま残った文書があれば
	// 未処理に戻す(プロセス内キューの情報は再起動で失われるため)。バックフィルより先に行うことで、
	// 未処理へ戻った文書もバックフィル/以後の索引付けで正しく再処理の対象になるようにする
	// 「無期限」を選べた頃に発行されたAPIキーがあれば、現在の上限(1年)へ切り詰める
	await ApiKeys.capUnlimitedKeys();
	await VectorSearch.recoverStaleProcessing();
	// DBの破損を検知する。壊れているのに気づかないまま使い続けるのを避けるため、起動のたびに
	// 一度だけ簡易確認して結果をログに残す(問題があればerrorレベル)。起動は止めない
	DbIntegrity.checkOnStartup();

	// 過去にアップロードされた(このベクトル検索機能の導入前からある)文書を差分バックフィルする。
	// サーバー起動をブロックしないよう非同期で流す。WEAVIATE_URL未設定時はisEnabled()の時点で
	// 弾き、全文書のcontent_textを読み出すクエリ自体を実行しない(単体SQLiteモードと同じ動作にする)
	if (VectorSearch.isEnabled()) {
		VectorSearch.backfillMissingDocuments(await ds.all(SQL_SELECT_ACTIVE_DOCUMENTS_FOR_INDEXING));
	}
	// 体裁つき表示(PDF変換)の接続確認。繋がらなくてもアプリは動く(概要プレビューのみになる)ため、
	// 起動を止めずにログだけ残す
	if (OfficeRender.isEnabled()) {
		// 接続確認で何が起きてもサーバーの起動は止めない。checkHealth内で例外が出ると
		// 未処理のPromise拒否になりプロセスが終了するため、ここで必ず受け止める
		OfficeRender.checkHealth().then((health) => {
			if (health != null) logger.info({libreOffice: health.libreOffice, maxBytes: health.maxBytes}, "体裁つき表示: 変換サービスに接続できました");
		}).catch((err) => logger.error(err, "::checkHealth"));
	}
};

// 直接 `node server.js` で起動されたときだけ main() を走らせる。
// テスト等から require された場合は app/server/main を使う側が起動を制御する
// (認証を有効にしたままOIDC初期化だけ省いてテストサーバを立てる等)
if (require.main === module) {
	main().catch((err) => {
		logger.error(err, "::main");
		process.exit(1);
	});
}

// safeNextPath はテストから直接検証する(オープンリダイレクトは表記の揺れで破られるため、
// 実際のブラウザの解釈と同じ規則で弾けているかを網羅的に確かめたい)
module.exports = {app, server, main, safeNextPath, isSafeEntryFileName, contentDisposition};
