/*!
 * logger.js : 共通ロガー (標準出力のみ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 */

const pino = require("pino");

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

/**
 * @param {string} name ログの name フィールド (通常はモジュールのファイル名)
 */
module.exports = (name) => pino({name, level: LOG_LEVEL});
