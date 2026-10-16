/*!
 * serve.js : APIテスト用のサーバ起動エントリ(認証有効・OIDC省略)+ テスト用データのseed
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * server.js を require して app/server を取得し、認証は有効なまま(AUTH_DISABLEDを設定しない)、
 * OIDC初期化(ブラウザログイン用)だけ省いて listen する。APIキー認証と
 * requireAuth/requireWrite/requireAdmin はOIDCに依存しないため、これで認可のテストができる。
 *
 * DBの seed(許可ユーザー・APIキー)は、DBを所有するこのプロセス内で行う。別プロセス(globalSetup)から
 * 同じSQLiteファイルを触るとWindowsでファイルロック衝突(EPERM)を起こすため、あえて一本化している。
 * 生成した平文キーは .auth-keys.json に書き出し、各specがそれを読む。DATA_DIR/LISTEN_PORT等は
 * playwright.config.js の webServer.env から渡る。
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const {KEYS_FILE} = require("./config.js");

const DATA_DIR = process.env.DATA_DIR;
const port = Number(process.env.LISTEN_PORT || 18090);

// このプロセスがDBを開く前に、前回のテストDBを消してまっさらから始める
// (直前の実行のサーバは既に停止しておりロックは無い想定。念のため失敗は無視する)
try {
	fs.rmSync(DATA_DIR, {recursive: true, force: true});
} catch {}
fs.mkdirSync(DATA_DIR, {recursive: true});

// 体裁つき表示(PDF変換)のテスト用スタブ。server.jsのrequireより前に起動し、
// 接続先を環境変数で渡す(office-render.jsはrequire時に設定を読むため)
const converterStub = require("./converter-stub.js");
const stubPort = Number(process.env.CONVERTER_STUB_PORT || 18096);
process.env.OFFICE_RENDER_URL = process.env.OFFICE_RENDER_URL || `http://127.0.0.1:${stubPort}`;
// 「PDFでダウンロード」(HTML→PDF)の変換サービスも同じ作りのスタブで代える。Office用とは
// 別の口にしてある(片方の失敗・遅延の設定が、もう片方のテストへ漏れないように)。
// PDF_STUB_DISABLED=1 で立てると、変換サービスが無い環境の振る舞いを確かめられる
const pdfStubPort = Number(process.env.PDF_STUB_PORT || stubPort + 10);
if (process.env.PDF_STUB_DISABLED !== "1") {
	process.env.HTML_PDF_URL = process.env.HTML_PDF_URL || `http://127.0.0.1:${pdfStubPort}`;
}
// Miro 連携も、Miro の代わり(miro-stub.js)へつなぐ。アプリの値(クライアントID・シークレット)は
// 環境変数では渡さず、テストが管理画面のAPIで保存する(未設定の状態から確かめられるように)。
// 環境変数で渡す形は、単体テスト(test/miro-connection.test.js)で確かめる
const miroStub = require("./miro-stub.js");
const miroStubPort = Number(process.env.MIRO_STUB_PORT || stubPort + 20);
process.env.MIRO_API_URL = process.env.MIRO_API_URL || `http://127.0.0.1:${miroStubPort}`;
process.env.MIRO_AUTH_URL = process.env.MIRO_AUTH_URL || `http://127.0.0.1:${miroStubPort}`;
// テストでは待たない: 一時的な失敗のやり直しは短く、変更の反映はすぐ、定期の反映は止める(テストから呼ぶ)
process.env.MIRO_RETRY_DELAYS_MS = process.env.MIRO_RETRY_DELAYS_MS || "20,40";
process.env.MIRO_SYNC_DEBOUNCE_SECONDS = process.env.MIRO_SYNC_DEBOUNCE_SECONDS || "0.2";
process.env.MIRO_SYNC_INTERVAL_MINUTES = process.env.MIRO_SYNC_INTERVAL_MINUTES || "0";
// 「サーバーに新しいクライアントがある」状態を作り、更新のお知らせを検証できるようにする
// (同梱のクライアントと同じ版のままでは、お知らせが出る経路を通れないため)
process.env.SKILL_CLIENT_VERSION = process.env.SKILL_CLIENT_VERSION || "9.9.9";
// 「サーバーが更新された」通知を検証できるようにする(ローカルにはVERSION.jsonが無く、
// ビルドが決まらないとこの経路を通れないため)
process.env.SERVER_BUILD = process.env.SERVER_BUILD || "20260925_000000";
// レート制限を切る。テスト一式は正規の利用者1人として数えられるため、本数が増えると
// 上限に届き、**無関係なテストが429で落ちる**(実際に起きた。落ちるのは後ろのテストなので
// 原因が分かりにくい)。本番の上限を緩めるのではなく、ここで切る
process.env.RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED || "true";

// require時にdb.jsがDATA_DIR上にSQLiteを作成する
const ds = require("../../app/lib/datastore.js");
const AllowedUsers = require("../../app/lib/allowed-users.js");
const ApiKeys = require("../../app/lib/api-keys.js");
const {server} = require("../../app/server.js");

(async () => {
	await ds.init(); // sqliteはno-op、postgresはスキーマ作成

	// Postgresは共有DBのため、前回のテストデータをクリアして毎回まっさらから始める
	// (sqliteは一時DATA_DIRを毎回作り直しているため不要)
	if (ds.backend === "postgres") {
		const tables = [
			"document_tags", "project_documents", "project_folders", "projects",
			"audit_log", "api_keys", "allowed_users", "tag_order", "vector_search_settings",
			"documents", "sessions", "session_revocations"
		];
		for (const table of tables) {
			await ds.run(`DELETE FROM ${table}`);
		}
	}

	// テスト用の許可ユーザーとAPIキーを用意する。
	// APIキーの発行者は許可ユーザーである必要がある(resolveAuthがisAllowedを確認するため)。
	// APIキーのロールはreadonly/readwriteのみ(admin不可)なので、requireAdminルートは
	// readwriteキーでも403になる(=requireAdminが効いていることの検証になる)。
	const owner = "apitest@example.com";
	await AllowedUsers.addAllowedUser(owner, "admin", "serve");
	const readonly = await ApiKeys.createApiKey("test-readonly", "readonly", "30d", owner);
	const readwrite = await ApiKeys.createApiKey("test-readwrite", "readwrite", "30d", owner);
	const expired = await ApiKeys.createApiKey("test-expired", "readonly", "30d", owner);
	await ds.run("UPDATE api_keys SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", expired.id]);

	// ブラウザE2E(*.e2e.js)用に、OIDCを経由せず管理者(owner)のログイン済みセッションを1つ作る。
	// server.jsと同じsessionsテーブル(createSessionStore)へ直接書き込み、express-sessionが
	// 検証できる署名済みcookie(connect.sid = "s:<sid>.<hmac>")を組み立ててキーファイルへ書き出す。
	// これによりブラウザ側はcookieを注入するだけで、認証を有効にしたまま(=APIキーが実際に機能する
	// 状態で)UIを操作できる。APIテスト(*.spec.js)はこのcookieを使わないため影響しない
	// sessionsテーブルはserver.jsのrequire時(sqlite)/ds.init()(postgres)で作成済み。
	// session-store.jsのset()と同じ形(sid/JSON化したセッション/失効epoch ms)で1行入れるだけでよく、
	// express-session本体(app/node_modules)への依存を避けられる
	const sid = crypto.randomBytes(24).toString("hex");
	// 寿命はserver.jsと同じ既定に合わせる(テストが数分で終わるので値自体は何でもよいが、
	// 別の数字を書いておくと「アプリの既定はこれ」と誤解される)
	const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_HOURS || 16) * 60 * 60 * 1000;
	const sessionExpiresAt = Date.now() + sessionMaxAgeMs;
	const sessionData = {
		cookie: {originalMaxAge: sessionMaxAgeMs, expires: new Date(sessionExpiresAt).toISOString(), httpOnly: true, path: "/", sameSite: "lax"},
		user: {identifier: owner}
	};
	await ds.run("INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)", [sid, JSON.stringify(sessionData), sessionExpiresAt]);
	// express-session(cookie-signature)と同じ署名(HMAC-SHA256/base64/末尾=除去)を再現する
	const sessionSecret = process.env.SESSION_SECRET || "test-secret";
	const sessionSig = crypto.createHmac("sha256", sessionSecret).update(sid).digest("base64").replace(/=+$/, "");
	const sessionCookie = `s:${sid}.${sessionSig}`;

	// ---- セッションの切断(session-revoke.spec.js / session-revoke.e2e.js)用の利用者 ----
	// 切断は取り消せず、対象のAPIキーも巻き込む。上の owner を切ると他のテストが全部
	// 落ちるので、**切ってよい相手を別に用意する**。ログインの手がかり(時刻・IP・UA)も
	// 入れておく(上の owner のセッションは、この機能を入れる前の形のまま残してある)
	const mintSession = async (user, {ip, userAgent, minutesAgo}) => {
		const mintedSid = crypto.randomBytes(24).toString("hex");
		const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
		const data = {
			cookie: {originalMaxAge: sessionMaxAgeMs, expires: new Date(sessionExpiresAt).toISOString(), httpOnly: true, path: "/", sameSite: "lax"},
			user: {identifier: user},
			loginAt: at,
			lastSeenAt: at,
			ip,
			userAgent
		};
		await ds.run("INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)", [mintedSid, JSON.stringify(data), sessionExpiresAt]);
		const sig = crypto.createHmac("sha256", sessionSecret).update(mintedSid).digest("base64").replace(/=+$/, "");
		return `s:${mintedSid}.${sig}`;
	};
	const makeTarget = async (user, role, sessionCount) => {
		await AllowedUsers.addAllowedUser(user, role, "serve");
		const cookies = [];
		for (let i = 0; i < sessionCount; i += 1) {
			cookies.push(await mintSession(user, {ip: `203.0.113.${10 + i}`, userAgent: `TestBrowser/${i + 1}.0`, minutesAgo: 60 + i}));
		}
		const key = await ApiKeys.createApiKey(`key-of-${user.split("@")[0]}`, role === "admin" ? "readwrite" : role, "30d", user);
		return {user, cookies, apiKey: key.apiKey};
	};
	const revokeTargets = {
		// 一般の利用者(セッション2つ + APIキー)
		victim: await makeTarget("victim@example.com", "readwrite", 2),
		// 自分自身を切る管理者(セッション2つ + APIキー)
		admin2: await makeTarget("admin2@example.com", "admin", 2),
		// ログインはしておらず、APIキーだけを持っている利用者
		keyOnly: await makeTarget("keyonly@example.com", "readonly", 0),
		// 巻き添えにならないことを見るための利用者
		bystander: await makeTarget("bystander@example.com", "readwrite", 1),
		// 画面のテスト用
		e2eVictim: await makeTarget("e2e-victim@example.com", "readwrite", 1)
	};

	fs.writeFileSync(KEYS_FILE, JSON.stringify({
		owner,
		readonly: readonly.apiKey,
		readwrite: readwrite.apiKey,
		expired: expired.apiKey,
		invalid: "dm_thisisnotarealkey",
		sessionCookieName: "connect.sid",
		sessionCookie,
		revokeTargets
	}, null, 2));

	await converterStub.start(stubPort);
	console.log(`converter stub listening on ${stubPort}`);
	// 本物へ繋ぐ結合テスト(HTML_PDF_URLを外から渡す)では、スタブは立てるだけで使われない
	await converterStub.start(pdfStubPort);
	console.log(`pdf-converter stub listening on ${pdfStubPort}`);
	await miroStub.start(miroStubPort);
	console.log(`miro stub listening on ${miroStubPort}`);

	server.listen(port, () => {
		console.log(`api test server listening on ${port}`);
	});
})().catch((err) => {
	console.error("api test server failed to start:", err);
	process.exit(1);
});
