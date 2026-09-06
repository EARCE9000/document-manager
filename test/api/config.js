/*!
 * test-config.js : APIテストの共有設定(DATA_DIR/ポート/キーの読み込み)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// テスト用サーバと global-setup が共有する固定のDATA_DIR(毎回global-setupで作り直す)
const TEST_DATA_DIR = path.join(os.tmpdir(), "dm-api-test");
const PORT = Number(process.env.API_TEST_PORT || 18090);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const KEYS_FILE = path.join(__dirname, ".auth-keys.json");

// global-setup が書き出した平文APIキーを読む(spec から使用)
const loadKeys = () => JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));

module.exports = {TEST_DATA_DIR, PORT, BASE_URL, KEYS_FILE, loadKeys};
