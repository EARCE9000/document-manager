/*!
 * app-settings.js : 管理画面から変えられる設定(機能のOn/Off)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * ---- 考え方 ----
 * 環境変数は「その環境の**既定値**」で、DBに行があればそちらを優先する。
 * ベクトル検索のチャンク設定(lib/vector-search.js)と同じ扱いにしている。
 *
 * こうすると、
 *   - コンテナを建て直さずに管理画面から切り替えられる
 *   - 複数インスタンス構成でも、DBを見るので全台に効く
 *   - 環境変数で「この環境の初期状態」を決められる(何も設定しなければ既定はOff)
 *
 * 値はキャッシュせず毎回読む。設定の変更はめったに起きない一方、キャッシュすると
 * 複数インスタンスで食い違い、「片方だけ機能が出ている」という分かりにくい状態になるため。
 */

const path = require("path");
const ds = require("./datastore.js");
const logger = require("./logger.js")(path.basename(__filename));

const SQL_GET = `SELECT key, value, updated_by, updated_at FROM app_settings WHERE key = ?`;
const SQL_UPSERT = `
	INSERT INTO app_settings (key, value, updated_by, updated_at)
	VALUES (@key, @value, @updated_by, @updated_at)
	ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`;
const SQL_DELETE = `DELETE FROM app_settings WHERE key = ?`;

/** 環境変数・DBともに同じ書き方を受け付ける(1/true/on を真とみなす) */
const toBoolean = (value) => /^(1|true|on)$/i.test(String(value ?? "").trim());

/**
 * 真偽値の設定を読む。
 * @param {string} key
 * @param {boolean} envDefault 環境変数から決まる既定値
 * @returns {{enabled: boolean, fromSetting: boolean, envDefault: boolean, updatedBy: ?string, updatedAt: ?string}}
 */
module.exports.getBoolean = async (key, envDefault) => {
	let row = null;
	try {
		row = await ds.get(SQL_GET, [key]);
	} catch (err) {
		// 設定が読めないだけで機能全体を落とさない(移行直後など表が無い場合も既定値で動く)
		logger.warn({err, key}, "::app-settings: 設定を読めませんでした。既定値を使います");
	}
	if (row == null) {
		return {enabled: envDefault, fromSetting: false, envDefault, updatedBy: null, updatedAt: null};
	}
	return {
		enabled: toBoolean(row.value),
		fromSetting: true,
		envDefault,
		updatedBy: row.updated_by ?? null,
		updatedAt: row.updated_at ?? null
	};
};

/** 真偽値の設定を書く(誰がいつ変えたかも残す) */
module.exports.setBoolean = async (key, enabled, updatedBy) => {
	await ds.run(SQL_UPSERT, {
		key,
		value: enabled ? "true" : "false",
		updated_by: updatedBy ?? null,
		updated_at: new Date().toISOString()
	});
	logger.info({audit: "app_setting_changed", key, enabled, user: updatedBy}, "audit");
};

/** 設定を消して、環境変数の既定値に戻す */
module.exports.clear = async (key, updatedBy) => {
	await ds.run(SQL_DELETE, [key]);
	logger.info({audit: "app_setting_cleared", key, user: updatedBy}, "audit");
};

module.exports.toBoolean = toBoolean;

/** 設定のキー(文字列を散らさないためここにまとめる) */
module.exports.KEYS = {
	MOCKUPS_ENABLED: "mockups.enabled"
};
