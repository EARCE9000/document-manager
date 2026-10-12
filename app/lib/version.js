/*!
 * version.js : 画面などに出す版の表記
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 版はビルドした日時(JST)で、**YYYYMMDD.HHMM** と書く。Dockerイメージのタグも同じ値
 * (.github/workflows/docker-publish.yml が決め、VERSION.json に焼き込む)。
 *
 * 以前は画面に日付(YYYYMMDD)だけを出していた。同じ日に何度も出すと全部同じ表記になり、
 * いま動いているのがどれなのか分からなかった。
 *
 * 以前の形(YYYYMMDD_HHMMSS)で作られたイメージも残っているので、そちらも同じ表記に読み替える。
 */

/**
 * ビルドの値を、画面に出す版の表記へ直す。
 * @param {string|null|undefined} build VERSION.json の VERSION
 * @returns {string|null} 読めない値はそのまま返す(何が入っているかを隠さない)。空なら null
 */
const displayVersion = (build) => {
	const value = String(build ?? "").trim();
	// "0" は Dockerfile の既定値(CIを通さずに作ったイメージ)。版が無いのと同じ
	if (value === "" || value === "0") return null;
	const matched = value.match(/^(\d{8})[._](\d{4})(?:\d{2})?$/);
	return matched ? `${matched[1]}.${matched[2]}` : value;
};

module.exports = {displayVersion};
