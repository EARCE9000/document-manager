/*!
 * pg-ssl.js : PostgreSQL へ TLS でつなぐときの設定(DATABASE_SSL・DATABASE_SSL_CA)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * DATABASE_SSL の値:
 *   (未設定) / false … TLS を使わない(同じ台・同じネットワークの中の PostgreSQL 向け)
 *   verify           … TLS で暗号化し、相手の証明書(発行元とホスト名)を確かめる。
 *                      発行元の証明書は DATABASE_SSL_CA(PEM のファイル)。無ければ Node が持つ既定の一覧で確かめる。
 *                      RDS は既定の一覧に無い発行元なので、RDS の証明書の束を DATABASE_SSL_CA に渡す
 *                      (イメージの /app/certs/rds-global-bundle.pem に入れてある)
 *   true             … TLS で暗号化するが、相手の証明書を確かめない(以前からの動き)。
 *                      通り道に割り込まれても気づけないので、起動のときに警告を出す
 *
 * 知らない値は、黙って TLS 無しにせず、起動を止める(打ち間違いで暗号化が外れないように)。
 * 接続文字列(DATABASE_URL)に sslmode を書くと、pg はそちらを優先する。ここの設定を効かせるときは書かない。
 */

const fs = require("node:fs");

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ssl: false|object, warning: string|null}} pg の Pool に渡す ssl と、起動のときに出す警告
 */
const pgSslConfig = (env = process.env) => {
	const mode = String(env.DATABASE_SSL ?? "").trim().toLowerCase();
	const caFile = String(env.DATABASE_SSL_CA ?? "").trim();
	if (mode === "" || mode === "false") {
		return {ssl: false, warning: caFile ? "DATABASE_SSL_CA が指定されていますが、DATABASE_SSL が未設定なので TLS を使いません" : null};
	}
	if (mode === "true") {
		return {
			ssl: {rejectUnauthorized: false},
			warning: "DATABASE_SSL=true は、TLS で暗号化しますが相手の証明書を確かめません。DATABASE_SSL=verify(と DATABASE_SSL_CA)にしてください"
		};
	}
	if (mode === "verify") {
		if (!caFile) return {ssl: {rejectUnauthorized: true}, warning: null};
		let ca;
		try {
			ca = fs.readFileSync(caFile, "utf8");
		} catch (err) {
			throw new Error(`DATABASE_SSL_CA のファイルを読めません: ${caFile} (${err.code || err.message})`);
		}
		if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
			throw new Error(`DATABASE_SSL_CA のファイルに証明書(PEM)が入っていません: ${caFile}`);
		}
		return {ssl: {rejectUnauthorized: true, ca}, warning: null};
	}
	throw new Error(`DATABASE_SSL の値が分かりません: ${env.DATABASE_SSL}(verify / true / false のどれか)`);
};

module.exports = {pgSslConfig};
