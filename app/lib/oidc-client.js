/*!
 * oidc-client.js : OIDC Discovery + openid-client Configuration 初期化
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * OIDC_ISSUER の Discoveryドキュメント(/.well-known/openid-configuration)を
 * 起動時に一度だけ取得してエンドポイントを解決する。EntraID / Cognito /
 * Synology SSO Server など、標準的なOIDC Discovery + JWKSを公開している
 * プロバイダであれば、プロバイダ固有のコード無しで対応できる。
 *
 * ログイン状態自体はexpress-sessionのセッション(req.session.user)で管理し、
 * プロバイダが発行するaccess_token/refresh_tokenのTTLには依存しない
 * (短命なaccess_tokenでもブラウザ側のログイン状態を安定して維持するため)。
 * そのため、ここではDiscovery結果(Configuration)を返すのみで、トークンの
 * 保存・更新は行わない。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const client = require("openid-client");

const OIDC_ISSUER = process.env.OIDC_ISSUER || "";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || "";
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || "";
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";

module.exports = async () => {
	if (OIDC_ISSUER === "") {
		throw new Error("OIDC_ISSUER is not set");
	}
	if (OIDC_CLIENT_ID === "" || OIDC_REDIRECT_URI === "") {
		throw new Error("OIDC_CLIENT_ID / OIDC_REDIRECT_URI is not set");
	}

	logger.info({OIDC_ISSUER}, "fetching OIDC discovery document");
	const config = await client.discovery(
		new URL(OIDC_ISSUER),
		OIDC_CLIENT_ID,
		OIDC_CLIENT_SECRET !== "" ? OIDC_CLIENT_SECRET : undefined
	);
	logger.info({OIDC_CLIENT_ID, OIDC_REDIRECT_URI}, "oidc client initialized");
	return config;
};
