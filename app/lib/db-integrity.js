/*!
 * db-integrity.js : SQLiteデータベースの破損を検知する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 目的は「壊れているのに気づかないまま使い続ける」状態をなくすこと。
 * SQLiteの破損は、書き込みが通り続けたまま一部のページだけが読めなくなる形で進むことがあり、
 * 画面上は正常に見えるのに特定の文書だけ消えている、という気づきにくい壊れ方をする。
 *
 * 起動後に一度自動で確認し、管理者はいつでも画面/APIから再確認できる。
 *
 * ---- quick_check と integrity_check ----
 * `integrity_check` は索引と表の整合まで含めて全ページを検査する。確実だがDBが大きいと遅い。
 * `quick_check` は索引の整合検査を省く。ページの読み出しとセル構造の検査は行うため、
 * 「読めなくなっている」類の破損は捕まえられる。
 * better-sqlite3 は同期APIのため、検査中はサーバーの他の処理が止まる。起動時の自動確認は
 * quick_check を使い、所要時間をログに残す。全件の厳密な検査は管理者が明示的に選べるようにする。
 *
 * Postgresバックエンドでは何もしない(整合性の担保はマネージドDB側の責務)。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));
const ds = require("./datastore.js");

const MODES = {
	quick: {pragma: "quick_check", label: "簡易(索引の整合検査を省く)"},
	full: {pragma: "integrity_check", label: "厳密(索引と表の整合まで検査)"}
};

/**
 * 破損の有無を確認する。
 *
 * @param {"quick"|"full"} mode
 * @param {object|null} handle 検査対象の接続。省略時はアプリのDB。
 *   壊れたファイルに対して本当に検知できるかを試験するために差し替えられるようにしている
 *   (アプリのDBを意図的に壊すことはできないため)
 * @returns {Promise<{backend: string, supported: boolean, mode?: string, modeLabel?: string,
 *                    healthy?: boolean, problems?: string[], durationMs?: number, checkedAt: string}>}
 */
module.exports.check = async (mode = "quick", handle = null) => {
	const checkedAt = new Date().toISOString();
	if (handle == null && ds.backend !== "sqlite") {
		return {backend: ds.backend, supported: false, checkedAt};
	}
	const {pragma, label} = MODES[mode] || MODES.quick;
	const db = handle != null ? handle : require("./db.js");
	const startedAt = Date.now();
	// 正常時は "ok" の1行だけが返る。
	// 重度に壊れている場合は行を返す代わりに例外を投げる(database disk image is malformed)。
	// これは「検査に失敗した」のではなく「壊れていることが分かった」なので、
	// 例外で終わらせず問題として報告する(そうしないと500になり、最も知りたい状態が伝わらない)
	let rows;
	try {
		rows = db.pragma(pragma);
	} catch (err) {
		const durationMs = Date.now() - startedAt;
		const message = err instanceof Error ? err.message : String(err);
		logger.error({err, mode, durationMs}, "DBの整合性確認が例外で終了しました(破損の可能性が高い)");
		return {
			backend: ds.backend,
			supported: true,
			mode: mode in MODES ? mode : "quick",
			modeLabel: label,
			healthy: false,
			problems: [message],
			problemCount: 1,
			// 検査そのものが通らなかったことを区別できるようにする(復旧の判断に使う)
			checkFailed: true,
			durationMs,
			checkedAt
		};
	}
	const durationMs = Date.now() - startedAt;
	// pragmaの戻りは実装により文字列の配列/オブジェクトの配列のどちらにもなるため両方を受ける
	const problems = rows
		.map((row) => String(typeof row === "object" && row !== null ? Object.values(row)[0] ?? "" : row))
		.filter((value) => value !== "" && value !== "ok");
	return {
		backend: ds.backend,
		supported: true,
		mode: mode in MODES ? mode : "quick",
		modeLabel: label,
		healthy: problems.length === 0,
		// 破損の詳細は行数が多くなりうるため、先頭だけ返す(全文はサーバーのログに出る)
		problems: problems.slice(0, 20),
		problemCount: problems.length,
		durationMs,
		checkedAt
	};
};

/**
 * 起動後に一度だけ自動で確認し、結果をログに残す。
 * サーバーの起動は止めない(壊れていても、読めている範囲は使えるほうがよい。
 * 起動を止めると復旧作業のために画面も使えなくなる)。
 */
module.exports.checkOnStartup = async () => {
	try {
		const result = await module.exports.check("quick");
		if (!result.supported) return result;
		if (result.healthy) {
			logger.info({durationMs: result.durationMs, mode: result.mode}, "DBの整合性を確認しました(問題なし)");
		} else {
			logger.error(
				{problemCount: result.problemCount, problems: result.problems, durationMs: result.durationMs},
				"DBの整合性に問題が見つかりました。バックアップからの復旧を検討してください"
			);
		}
		return result;
	} catch (err) {
		logger.error(err, "::checkOnStartup");
		return null;
	}
};

module.exports.MODES = Object.keys(MODES);
