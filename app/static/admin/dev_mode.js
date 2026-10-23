/*!
 * dev_mode.js : 開発モード(認証なしで入る)で動いていることを、どの画面でも分かるように出す
 * Copyright (c) 2026 EARCE.NET (code & design)
 * License: MIT License - see LICENSE
 * Source: https://github.com/EARCE9000/DesignTemplate (published on GitHub)
 *
 * 共通アーキテクチャ(認証 2.6)の決まり:
 *   - サーバーは webapi/check_access_token の応答に authDisabled(true / false)を入れる。認証ありのときも false を返す。
 *   - 画面は authDisabled が true のときだけ、次の 3 つを出す。消す設定は置かない。
 *       1. ロゴ(題字)の横のしるし「開発モード」(.dev_mode_badge)
 *       2. ヘッダーの色を紫に(.header.dev_mode)
 *       3. ブラウザのタブの題名の先頭に【開発モード】
 *   - 画面の側で、ホスト名などから開発かどうかを推測しない。
 *
 * 置き方(ヘッダー。しるしは題字の要素の外に、題字のすぐ後ろに置く。題字の文字にまぜない):
 *   <div class="header">
 *     <div class="header_title">{{システム名}}</div>
 *     <span class="dev_mode_badge" hidden title="…"><svg>…</svg>開発モード</span>
 *     <div class="header_actions"> … </div>
 *   </div>
 *
 * 使い方:
 *   <script src="./assets/dev_mode.js" data-check="./webapi/check_access_token"></script>
 *     … 読み込んだときに check_access_token を呼び、authDisabled を見て出す
 *   すでに check_access_token を呼んでいる画面は、data-check を付けずに、結果を渡す:
 *     DevMode.apply(response.authDisabled === true);
 */
(function () {
	"use strict";
	var PREFIX = "【開発モード】";

	function apply(on) {
		var header = document.querySelector(".header");
		var badge = document.querySelector(".dev_mode_badge");
		if (header) header.classList.toggle("dev_mode", !!on);
		if (badge) badge.hidden = !on;
		var title = document.title.indexOf(PREFIX) === 0 ? document.title.slice(PREFIX.length) : document.title;
		document.title = on ? PREFIX + title : title;
	}

	function check(url) {
		return fetch(url, {credentials: "same-origin", headers: {"Accept": "application/json"}})
			.then(function (res) { return res.ok ? res.json() : {}; })
			.then(function (data) { apply(data && data.authDisabled === true); return data; })
			.catch(function () { return null; });   // 確かめられなかったときは、何も出さない(ふだんの画面のまま)
	}

	window.DevMode = {apply: apply, check: check};

	var me = document.currentScript;
	var url = me && me.getAttribute("data-check");
	var demo = me && me.hasAttribute("data-demo") && /[?&]dev_mode=1\b/.test(location.search);   // テンプレートの見本だけ: ?dev_mode=1 で出す
	var run = function () { if (demo) apply(true); else if (url) check(url); };
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
	else run();
})();
