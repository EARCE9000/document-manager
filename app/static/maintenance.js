/*!
 * maintenance.js : メンテナンス中の画面(画面の資料の maintenance_screen。共通アーキテクチャ「構成」の sqlite_vacuum)
 * Copyright(c) 2026 EARCE.NET
 * MIT Licensed
 *
 * 管理者がデータベースのファイルを詰めている(VACUUM)間、サーバーは API を 503 {code: "maintenance"} で断る。
 * このファイルは fetch を包み、その応答を見たら画面全体を「メンテナンス中」で覆う(閉じるボタンは置かない。何も使えないため)。
 * api/maintenance(認証なし)を 3 秒ごとに見て、終わったら画面ごと読み直す。
 * 管理の画面で VACUUM を始めたときは、Maintenance.show() ですぐに出す。
 *
 * 画面(index.html・admin.html)のほかのスクリプトより前に読み込む(最初の確かめの応答から見るため)。
 * 見た目はここで足す(管理の画面は CSP で style-src に 'unsafe-inline' を許している)。
 */
(function () {
	"use strict";

	var POLL_MS = 3000;
	var shown = false;

	var STYLE = [
		"#maintenanceOverlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(20, 22, 26, 0.55); }",
		"#maintenanceOverlay .maintenanceBox { background: #fff; color: #24292f; border-radius: 10px; border-top: 6px solid #ee7800; box-shadow: 0 6px 28px rgba(0, 0, 0, 0.25); padding: 28px 32px; max-width: 460px; width: calc(100% - 32px); box-sizing: border-box; font-family: -apple-system, \"Segoe UI\", \"Hiragino Kaku Gothic ProN\", Meiryo, sans-serif; }",
		"#maintenanceOverlay .maintenanceTitle { font-size: 1.2em; font-weight: bold; margin: 0 0 12px; }",
		"#maintenanceOverlay .maintenanceBody { font-size: 0.95em; line-height: 1.7; white-space: pre-line; margin: 0; }"
	].join("\n");

	function show() {
		if (shown) return;
		shown = true;
		var style = document.createElement("style");
		style.textContent = STYLE;
		document.head.appendChild(style);
		var overlay = document.createElement("div");
		overlay.id = "maintenanceOverlay";
		overlay.setAttribute("role", "alertdialog");
		overlay.setAttribute("aria-modal", "true");
		overlay.setAttribute("aria-labelledby", "maintenanceTitle");
		var box = document.createElement("div");
		box.className = "maintenanceBox";
		var title = document.createElement("div");
		title.className = "maintenanceTitle";
		title.id = "maintenanceTitle";
		title.textContent = "メンテナンス中";
		var body = document.createElement("p");
		body.className = "maintenanceBody";
		body.textContent = "データベースのメンテナンス中です\n※数分かかることがあります。\n\n完了すると自動で画面を読み直します。";
		box.appendChild(title);
		box.appendChild(body);
		overlay.appendChild(box);
		var mount = function () { document.body.appendChild(overlay); };
		if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
		// 下の画面に入力の場所が残らないようにする
		if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
		var poll = function () {
			nativeFetch("./api/maintenance", {cache: "no-store"}).then(function (res) {
				return res.ok ? res.json() : null;
			}).then(function (data) {
				if (data && data.maintenance === false) {
					window.location.reload();
					return;
				}
				setTimeout(poll, POLL_MS);
			}, function () {
				// 届かないときは、続けて待つ
				setTimeout(poll, POLL_MS);
			});
		};
		setTimeout(poll, 1500);
	}

	// 503 の応答がメンテナンス中か(本文は読み終えない。clone で読む)
	function isMaintenance(res) {
		if (res.status !== 503) return Promise.resolve(false);
		return res.clone().json().then(function (data) {
			return Boolean(data && data.code === "maintenance");
		}, function () { return false; });
	}

	var nativeFetch = window.fetch.bind(window);
	window.fetch = function () {
		return nativeFetch.apply(null, arguments).then(function (res) {
			return isMaintenance(res).then(function (yes) {
				if (yes) show();
				return res;
			});
		});
	};

	window.Maintenance = {show: show, isShown: function () { return shown; }};
})();
