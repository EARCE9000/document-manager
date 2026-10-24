/*!
 * admin.js : 管理機能の画面(利用者 / セッション / 監査ログ / サーバー)を描く共通のスクリプト
 * Copyright (c) 2026 EARCE.NET (code & design)
 * License: MIT License - see LICENSE
 * Source: https://github.com/EARCE9000/DesignTemplate (published on GitHub)
 *
 * 管理の情報は、どのサービスでも同じ形の WebAPI で返す(共通アーキテクチャ 構成 6.4)。
 * サービスはデータを返すだけで、見せ方はこのスクリプトが受け持つ。タブごとに、次の要素を置く:
 *   <div class="admin_users"    data-base="./webapi/admin/users"    data-login="./"></div>
 *   <div class="admin_sessions" data-base="./webapi/admin/sessions" data-login="./"></div>
 *   <div class="admin_audit"    data-base="./webapi/admin/audit"    data-login="./"></div>
 *   <div class="admin_server"   data-base="./webapi/server-status"  data-login="./"></div>
 *   <script src="./assets/admin.js"></script>
 *   data-base  … そのタブの WebAPI の頭
 *   data-login … 401 のときに移る先(認証の資料: 画面の中の認証切れは、必ずログインの画面へ戻す)
 * 見本(テンプレート)では、data-base の代わりに data-sample="<JSON を埋めた script の id>" を付ける。
 *
 * 置き方の決まり:
 *   - 管理の画面は、ほかの画面とは別のページにする(components.css などはページ全体に効くので、既存の画面の中に埋め込まない)。
 *   - 管理者でない人には、このページを出さない(サービスが先に権限を確かめ、このスクリプトを読み込まない)。
 *     取りこぼして 403 が返ったときは、ページの上に 1 つだけ知らせを出す。
 *   - タブの中の物は、そのタブを開いたときに読む。JS でタブを切り替えたら AdminUI.refresh() を呼ぶ。
 *   - 確認のモーダルは AdminUI.confirm({title, body, ok, danger}) で、独自のタブからも使える。
 *
 * 各タブの WebAPI の形は、それぞれの描き方の上に書いてある。
 * サービスごとの足し方: 知らない項目は読み飛ばす。サーバーのタブは、下の「サーバー」の説明のとおり足せる。
 * サービス独自のタブは、この 4 つの後ろに、サービスが自分で作る。
 *
 * ---- サーバー ----
 * 共通アーキテクチャ(構成 6.2・6.3 / 画面 8.1・8.2)で決めた WebAPI の応答を読んで、次を描く。
 * セキュリティの点検(部品の脆弱性、設定の抜け)のときに、この画面だけで判断できる情報量にする。
 * 上に、管理者が変更できる設定。下に、確認するだけの表示を並べる。
 *   設定(管理者が変更可)。上に、このサーバー全体の共通の設定。下に、サービスが機能に応じて足す物
 *         1. API の回数の上限(共通。PUT {base}/rate-limit {authenticated | anonymous: 回数}、既定に戻すのは DELETE {base}/rate-limit/{kind})
 *         2. 機能の On/Off(editable の機能は、その場で切り替え。PUT {base}/features/{key} {enabled})
 *         3. サービスが足した設定の節(class="admin_server_extra" を付けて、この要素の中に書いた物)
 *   書き出し: いちばん上の欄から、画面の中身を Markdown でコピー / ダウンロード(「部品表の全部も入れる」で、部品表の全部も)。
 *           サービスの名前は data-service(無ければ status.service、無ければ題名)
 *   確認(表示だけ)
 *         4. このサーバー(版・ビルド・リビジョン・ビルド日時・起動日時・稼働時間・DB の種類と、DB のファイル)
 *         5. 接続の確認(接続先ごとに、状態・応答時間・最終成功・補足)
 *         6. セキュリティ設定(認証の方式、セッションの寿命、APIキーの最長の期限 など)
 *         7. 稼働中の部品の版(本体・DB・つながっている相手の、製品と版と土台。本体は V8・カーネル・CPU・メモリまで)
 *         8. 直接使っているライブラリと、部品表(名前で探す。入れ子に入った別の版も)
 *
 * 使い方(サービスの画面):
 *   <div class="admin_server" data-base="./webapi/server-status" data-login="./"></div>
 *   <script src="./assets/admin.js"></script>
 *   data-base  … 共通の WebAPI の頭。{base}、{base}/components、{base}/packages?q= を呼ぶ
 *   data-login … 401 のときに移る先(認証の資料: 画面の中の認証切れは、必ずログインの画面へ戻す)
 *
 * 見本(テンプレート)では、WebAPI の代わりに、ページに埋めた JSON を読む:
 *   <div class="admin_server" data-sample="admin_server_sample"></div>
 *   <script type="application/json" id="admin_server_sample">{"status": …, "components": …, "packages": …}</script>
 *
 * サービスごとの足し方(カスタム化):
 *   - status.rateLimit: {windowMinutes, disabled, authenticated: {limit, source, env, min, max, updatedBy, updatedAt}, anonymous: {…}}
 *     … API の回数の上限(共通)。source は setting(この画面で変更)/ env(環境変数)/ default(既定)
 *   - status.extra: [{label, value}] … 「このサーバー」に項目を足す
 *   - status.security: [{label, value, state, note}] … セキュリティ設定の行。state は ok / warn / bad / 省略
 *   - status.features: [{key, name, enabled, editable, note}] … 機能の On/Off。editable が true なら、ここで切り替えられる
 *   - components[] にサービス独自の相手を足してよい(key は重ならない名前)。
 *     details: [{label, value}] を付けると、補足の欄にそのまま出す。知らない項目は読み飛ばす
 *   - サービスの設定の節(機能の切り替え、上限の変更など)は、class="admin_server_extra" を付けて、この要素の中に書く。
 *     描くときに残し、設定の並び(機能の On/Off の下)に差し込む。確認の表示の後ろに足したい物は、この要素の外に書く
 */
(function () {
	"use strict";

	var STATE = {
		checking: ["processing", "Checking"],
		running: ["completed", "Running"],
		reachable: ["completed", "Connected"],
		unreachable: ["failed", "Error"],
		unconfigured: ["unknown", "Not set"]
	};
	var LEVEL = {ok: ["completed", "OK"], warn: ["pending", "Warning"], bad: ["failed", "Critical"]};
	// 土台の 1 行目。左から順に、あるものだけを出す
	var RUNTIME_KEYS = [["node", "Node.js"], ["python", "Python"], ["php", "PHP"], ["java", "Java"], ["openssl", "OpenSSL"], ["os", ""], ["arch", ""]];
	// 土台の 2 行目(本体は、ここまで出す)
	var RUNTIME_MORE = [["v8", "V8"], ["uv", "libuv"], ["kernel", "カーネル"], ["cpus", "CPU"]];

	function esc(value) {
		return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
			return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c];
		});
	}
	function ver(value) {
		// 版は略さず、そのままの文字で出す。取れない版は「分からない」
		return value == null || value === "" ? "<span class=\"null_val\">不明</span>" : "<span class=\"version_text\">" + esc(value) + "</span>";
	}
	function when(iso) {
		if (!iso) return "―";
		var d = new Date(iso);
		if (isNaN(d.getTime())) return esc(iso);
		var p = function (n) { return (n < 10 ? "0" : "") + n; };
		return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
	}
	function uptime(seconds) {
		if (seconds == null) return "―";
		var d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
		return (d ? d + " 日 " : "") + (d || h ? h + " 時間 " : "") + m + " 分";
	}
	function bytes(n) {
		if (n == null) return "―";
		var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
		while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
		return (i ? n.toFixed(1) : n) + " " + units[i];
	}
	function badge(pair) {
		return "<span class=\"status_badge " + pair[0] + "\">" + pair[1] + "</span>";
	}
	function stateOf(c) {
		if (c == null) return "checking";
		if (c.configured === false) return "unconfigured";
		if (c.reachable === false) return "unreachable";
		return c.key === "app" ? "running" : "reachable";
	}
	function table(head, rows, empty) {
		return "<div class=\"data_table_wrap\"><table class=\"data_table\"><thead><tr>" + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") +
			"</tr></thead><tbody>" + (rows.join("") || "<tr><td colspan=\"" + head.length + "\" class=\"runtime_text\">" + (empty || "なし") + "</td></tr>") + "</tbody></table></div>";
	}
	function runtimeCell(c) {
		var rt = c.runtime;
		if (rt === null) return "<span class=\"runtime_text\">(この相手は未対応。相手の更新で表示)</span>";
		if (!rt) return "―";
		var first = [];
		RUNTIME_KEYS.forEach(function (k) {
			if (rt[k[0]] != null) first.push((k[1] ? esc(k[1]) + " " : "") + "<span class=\"version_text\">" + esc(rt[k[0]]) + "</span>");
		});
		var lines = [first.join("<span class=\"runtime_sep\">/</span>")];
		var more = [];
		RUNTIME_MORE.forEach(function (k) {
			if (rt[k[0]] != null) more.push(esc(k[1]) + " <span class=\"version_text\">" + esc(rt[k[0]]) + (k[0] === "cpus" ? " コア" : "") + "</span>");
		});
		if (more.length) lines.push(more.join("<span class=\"runtime_sep\">/</span>"));
		if (rt.memory) lines.push("メモリ 使用 " + esc(bytes(rt.memory.rssBytes)) + (rt.memory.totalBytes ? "(サーバー全体 " + esc(bytes(rt.memory.totalBytes)) + ")" : ""));
		return "<span class=\"runtime_text\">" + lines.join("<br>") + "</span>";
	}
	function detailsText(c) {
		var rows = [];
		if (c.apiVersion != null) rows.push("API " + ver(c.apiVersion));
		(c.modules || []).forEach(function (m) {
			rows.push("モジュール " + esc(m.name) + (m.model ? "(" + esc(m.model) + ")" : "") + (m.version ? " " + ver(m.version) : ""));
		});
		(c.details || []).forEach(function (d) { rows.push(esc(d.label) + ": " + esc(d.value)); });
		return rows.join("<br>");
	}

	// 403(管理者でない)は、タブごとに出さず、ページの上に 1 つだけ出す。
	// 管理者でない人には、そもそもこの画面を出さない(サービスが先に権限を確かめる)のが本筋。これは、その取りこぼしの受け皿
	var forbiddenShown = false;
	function notifyForbidden() {
		if (forbiddenShown) return;
		forbiddenShown = true;
		var host = document.querySelector(".tab_set") || document.querySelector("[class^=admin_]");
		if (!host) return;
		var box = document.createElement("div");
		box.className = "msg_error";
		box.style.margin = "8px 14px";
		box.textContent = "この画面は管理者だけが使える(403)。管理者の権限が要る場合は、管理者に依頼。";
		host.parentNode.insertBefore(box, host);
	}

	function AdminServer(root) {
		this.root = root;
		this.base = root.getAttribute("data-base");
		this.login = root.getAttribute("data-login") || "./";
		var sampleId = root.getAttribute("data-sample");
		this.sample = null;
		if (sampleId) {
			var node = document.getElementById(sampleId);
			this.sample = node ? JSON.parse(node.textContent) : null;
		}
		this.searchTimer = null;
		this.deps = [];
	}

	AdminServer.prototype.get = function (path) {
		var self = this;
		if (this.sample) {
			// 見本: WebAPI の代わりに、埋めた JSON を返す(相手への問い合わせに時間が掛かる様子も、少しだけ見せる)
			return new Promise(function (resolve) {
				setTimeout(function () {
					if (path === "") return resolve(self.sample.status);
					if (path === "/components") return resolve(self.sample.components);
					var q = decodeURIComponent((path.split("q=")[1] || "")).toLowerCase();
					var list = self.sample.packages.packages.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
					resolve({source: self.sample.packages.source, total: self.sample.packages.packages.length, count: list.length, packages: list});
				}, path === "/components" ? 600 : 50);
			});
		}
		return fetch(this.base + path, {credentials: "same-origin", headers: {"Accept": "application/json"}}).then(function (res) {
			if (res.status === 401) {
				// 認証切れは、必ずログインの画面へ戻す(403 や 5xx では移らない)
				window.location.href = self.login;
				throw new Error("unauthenticated");
			}
			if (res.status === 403) { notifyForbidden(); throw new Error("権限なし"); }
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		});
	};

	AdminServer.prototype.render = function () {
		var REF = "<svg class=\"inline_icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" +
			"<polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>";
		// サービスが書いた設定の節(class="admin_server_extra")は、残して、設定の並びの最後に差し込む
		var extras = [];
		for (var i = 0; i < this.root.children.length; i += 1) {
			if (this.root.children[i].classList.contains("admin_server_extra")) extras.push(this.root.children[i]);
		}
		// 上に、管理者が変更できる設定(機能の On/Off、サービスの設定の節)。下に、確認するだけの表示
		this.root.innerHTML =
			"<div class=\"export_bar\"><span class=\"runtime_text\">この画面の中身を Markdown で書き出す(LLM での点検や、報告に使う)</span>" +
			"<label class=\"runtime_text\"><input type=\"checkbox\" data-part=\"mdall\"> 部品表の全部も入れる</label>" +
			"<button type=\"button\" class=\"search_btn\" data-act=\"mdcopy\">Markdown でコピー</button>" +
			"<button type=\"button\" class=\"search_btn\" data-act=\"mddownload\">Markdown でダウンロード</button></div>" +
			"<div class=\"panel_group\">設定(管理者が変更可)<span class=\"panel_section_action\"><a href=\"#\" data-act=\"reload\" style=\"font-size:9pt;color:#187FF5;text-decoration:none;\">" + REF + "再確認</a></span></div>" +
			"<div class=\"panel_section_title\">API の回数の上限<span class=\"panel_section_action runtime_text\" data-part=\"rlwindow\"></span></div>" +
			"<div data-part=\"ratelimit\"></div>" +
			"<div class=\"panel_section_title\">機能の On/Off</div>" +
			"<div data-part=\"features\"></div>" +
			"<div data-part=\"extras\"></div>" +
			"<div class=\"panel_group\">確認(表示だけ)</div>" +
			"<div class=\"panel_section_title\">このサーバー</div>" +
			"<div class=\"info_grid\" data-part=\"status\"></div>" +
			"<div data-part=\"dbfiles\"></div>" +
			"<div class=\"panel_section_title\">接続の確認<span class=\"panel_section_action runtime_text\" data-part=\"checked\"></span></div>" +
			"<div data-part=\"connections\"></div>" +
			"<div class=\"panel_section_title\">セキュリティ設定</div><div data-part=\"security\"></div>" +
			"<div class=\"panel_section_title\">稼働中の部品の版</div><div data-part=\"components\"></div>" +
			"<div class=\"panel_section_title\">ライブラリ(部品表)<span class=\"panel_section_action runtime_text\" data-part=\"pkgcount\"></span></div>" +
			"<div class=\"filter_panel\"><div class=\"search_form\"><span class=\"filter_label\">部品の名前</span>" +
			"<input type=\"search\" class=\"search_input\" data-part=\"q\" placeholder=\"例) openssl、express\" autocomplete=\"off\"></div></div>" +
			"<div data-part=\"packages\"></div>";
		var slot = this.part("extras");
		extras.forEach(function (node) { slot.appendChild(node); });
		var self = this;
		this.root.querySelector("[data-act=reload]").addEventListener("click", function (e) { e.preventDefault(); self.load(); });
		this.root.querySelector("[data-act=mdcopy]").addEventListener("click", function (e) { self.exportMarkdown("copy", e.target); });
		this.root.querySelector("[data-act=mddownload]").addEventListener("click", function (e) { self.exportMarkdown("download", e.target); });
		this.root.querySelector("[data-part=q]").addEventListener("input", function (e) {
			clearTimeout(self.searchTimer);
			var q = e.target.value.trim();
			self.searchTimer = setTimeout(function () { self.loadPackages(q); }, 300);
		});
	};

	AdminServer.prototype.part = function (name) { return this.root.querySelector("[data-part=" + name + "]"); };

	AdminServer.prototype.fail = function (names, err) {
		var self = this;
		names.forEach(function (n) { self.part(n).innerHTML = "<div class=\"msg_error\">取得失敗: " + esc(err.message) + "</div>"; });
	};

	AdminServer.prototype.load = function () {
		var self = this;
		// 本体の情報を先に出す。相手への問い合わせの結果は、あとから出す(全部がそろうまで待たせない)
		this.get("").then(function (s) { self.showStatus(s); }, function (err) { self.fail(["status"], err); });
		this.showComponents(null);
		this.get("/components").then(function (c) { self.showComponents(c); }, function (err) { self.fail(["connections", "components"], err); });
	};

	AdminServer.prototype.showStatus = function (s) {
		this.lastStatus = s;
		var items = [
			["版", ver(s.version)], ["ビルド", s.build ? ver(s.build) : "―"], ["リビジョン", s.revision ? ver(s.revision) : "―"],
			["ビルド日時", esc(when(s.builtAt))], ["起動日時", esc(when(s.startedAt))], ["稼働時間", esc(uptime(s.uptimeSeconds))],
			["データベース", esc(s.database && s.database.backend ? s.database.backend : "―")]
		];
		(s.extra || []).forEach(function (e) { items.push([esc(e.label), esc(e.value)]); });
		this.part("status").innerHTML = items.map(function (i) {
			return "<div><div class=\"info_label\">" + i[0] + "</div><div class=\"info_value\">" + i[1] + "</div></div>";
		}).join("");

		var files = s.database && s.database.files;
		this.part("dbfiles").innerHTML = files && files.length ? table(["DB のファイル", "大きさ", ""], files.map(function (f) {
			return "<tr><td class=\"version_text\">" + esc(f.name) + "</td><td>" + esc(bytes(f.sizeBytes)) + "</td><td>" + (f.current ? "<b>使用中</b>" : "旧版(切り戻し用に保管)") + "</td></tr>";
		})) : "";

		this.showRateLimit(s.rateLimit);

		this.part("security").innerHTML = table(["項目", "現在の値", "状態", "補足"], (s.security || []).map(function (r) {
			return "<tr" + (r.state === "bad" ? " class=\"row_failed\"" : "") + "><td>" + esc(r.label) + "</td><td>" + esc(r.value) + "</td><td>" +
				(LEVEL[r.state] ? badge(LEVEL[r.state]) : "") + "</td><td class=\"runtime_text\">" + esc(r.note || "") + "</td></tr>";
		}), "セキュリティ設定の返却なし");

		// 切り替えられる機能(editable)はスイッチ、構成で決まる機能は On / Off の表示だけ
		var features = s.features || [];
		this.part("features").innerHTML = table(["機能", "状態", "補足"], features.map(function (f, i) {
			var state = f.editable
				? "<label class=\"toggle_switch\"><input type=\"checkbox\" data-feature=\"" + i + "\"" + (f.enabled ? " checked" : "") + ">" +
				  "<span class=\"toggle_track\"></span><span class=\"toggle_label\"><span class=\"toggle_on\">On</span><span class=\"toggle_off\">Off</span></span></label>"
				: (f.enabled ? badge(["completed", "On"]) : badge(["unknown", "Off"]));
			return "<tr><td>" + esc(f.name) + "</td><td>" + state + "</td><td class=\"runtime_text\" data-feature-note=\"" + i + "\">" +
				esc(f.note || "") + (f.editable ? "" : (f.note ? "。" : "") + "構成で決まる(ここでは変更不可)") + "</td></tr>";
		}), "機能の切り替えなし");
		var self = this;
		var boxes = this.part("features").querySelectorAll("input[data-feature]");
		for (var b = 0; b < boxes.length; b += 1) {
			boxes[b].addEventListener("change", function (e) { self.setFeature(features[Number(e.target.getAttribute("data-feature"))], e.target); });
		}
	};

	// ---------------------------------------------------------------- Markdown で書き出す
	// 画面に出している物だけを、節ごとの見出しと表にする。版は略さない。出さない物(接続文字列・キー・パス)は、もともと WebAPI が返さない。
	// 管理の WebAPI は APIキーでは呼べない(版の情報は弱点を探す手がかりになる)ので、LLM には、この書き出しを人が渡す
	function mdCell(value) {
		if (value == null || value === "") return "―";
		return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	}
	function mdTable(head, rows) {
		if (!rows.length) return "(なし)\n";
		return "| " + head.join(" | ") + " |\n| " + head.map(function () { return "---"; }).join(" | ") + " |\n" +
			rows.map(function (r) { return "| " + r.map(mdCell).join(" | ") + " |"; }).join("\n") + "\n";
	}
	function mdRuntime(rt) {
		if (rt === null) return "(この相手は返さない)";
		if (!rt) return "";
		var parts = [];
		[["node", "Node.js"], ["python", "Python"], ["php", "PHP"], ["java", "Java"], ["v8", "V8"], ["uv", "libuv"], ["openssl", "OpenSSL"],
			["os", "OS"], ["kernel", "カーネル"], ["arch", "CPU の種類"], ["cpus", "CPU の数"]].forEach(function (k) {
			if (rt[k[0]] != null) parts.push(k[1] + " " + rt[k[0]]);
		});
		if (rt.memory) parts.push("メモリ 使用 " + bytes(rt.memory.rssBytes) + (rt.memory.totalBytes ? " / 全体 " + bytes(rt.memory.totalBytes) : ""));
		return parts.join(" / ");
	}
	var STATE_TEXT = {running: "Running", reachable: "Connected", unreachable: "Error", unconfigured: "Not set", checking: "Checking"};
	var LEVEL_TEXT = {ok: "OK", warn: "Warning", bad: "Critical"};

	AdminServer.prototype.markdown = function (packages) {
		var s = this.lastStatus || {}, c = this.lastComponents || {components: []};
		var service = this.root.getAttribute("data-service") || s.service || document.title.replace(/^【開発モード】/, "").split("|")[0].trim();
		var out = [];
		out.push("# " + service + " サーバーの状態");
		out.push("");
		out.push("- 書き出した日時: " + when(new Date().toISOString()));
		out.push("- 部品を調べた日時(checkedAt): " + when(c.checkedAt));
		out.push("- 版: " + (s.version || "不明") + (s.build ? "(ビルド " + s.build + ")" : "") + (s.revision ? "(リビジョン " + s.revision + ")" : ""));
		out.push("- 形: 共通アーキテクチャの管理の画面(server-status / components / packages)。版は略さず、そのままの文字");
		out.push("- 取り扱い: 管理者だけが見られる情報。部品の版は弱点を探す手がかりになるので、渡す先に注意");
		out.push("");
		out.push("## このサーバー");
		out.push("");
		var info = [["版", s.version], ["ビルド", s.build], ["リビジョン", s.revision], ["ビルド日時", s.builtAt ? when(s.builtAt) : null],
			["起動日時", s.startedAt ? when(s.startedAt) : null], ["稼働時間", s.uptimeSeconds != null ? uptime(s.uptimeSeconds) : null],
			["データベース", s.database && s.database.backend]];
		(s.extra || []).forEach(function (e) { info.push([e.label, e.value]); });
		out.push(mdTable(["項目", "値"], info));
		var files = s.database && s.database.files;
		if (files && files.length) {
			out.push("### DB のファイル");
			out.push("");
			out.push(mdTable(["ファイル", "大きさ", "使い方"], files.map(function (f) { return [f.name, bytes(f.sizeBytes), f.current ? "使用中" : "旧版(切り戻し用)"]; })));
		}
		out.push("## 設定");
		out.push("");
		var rl = s.rateLimit;
		out.push("### API の回数の上限" + (rl && rl.windowMinutes ? "(" + rl.windowMinutes + " 分あたり)" : ""));
		out.push("");
		if (rl) {
			if (rl.disabled) out.push("**いまは回数の上限を切っている(RATE_LIMIT_DISABLED)。**\n");
			var src = function (item) {
				if (item.source === "setting") return "画面で変更(" + (item.updatedBy || "不明") + "・" + when(item.updatedAt) + ")";
				if (item.source === "env") return "環境変数 " + (item.env || "");
				return "既定の値";
			};
			out.push(mdTable(["対象", "上限", "範囲", "出どころ"], RATE_KINDS.filter(function (k) { return rl[k[0]]; }).map(function (k) {
				var item = rl[k[0]];
				return [k[1], item.limit + " 回", item.min != null ? item.min + " 〜 " + item.max : null, src(item)];
			})));
		} else {
			out.push("(返却なし)\n");
		}
		out.push("### 機能の On/Off");
		out.push("");
		out.push(mdTable(["機能", "状態", "画面で変更", "補足"], (s.features || []).map(function (f) {
			return [f.name, f.enabled ? "On" : "Off", f.editable ? "可" : "不可(構成で決まる)", f.note];
		})));
		out.push("## 接続の確認");
		out.push("");
		out.push(mdTable(["接続先", "状態", "応答時間", "最終成功", "理由"], (c.components || []).filter(function (x) { return x.key !== "app"; }).map(function (x) {
			var st = stateOf(x);
			return [x.name, STATE_TEXT[st], st === "unconfigured" ? null : (x.latencyMs != null ? x.latencyMs + " ms" : null), x.lastSuccessAt ? when(x.lastSuccessAt) : null,
				st === "unconfigured" ? "この機能は未使用" : x.error];
		})));
		out.push("## セキュリティ設定");
		out.push("");
		out.push(mdTable(["項目", "現在の値", "状態", "補足"], (s.security || []).map(function (r) {
			return [r.label, r.value, LEVEL_TEXT[r.state] || null, r.note];
		})));
		out.push("## 稼働中の部品の版");
		out.push("");
		out.push(mdTable(["部品", "状態", "製品", "版", "API の版", "土台", "補足"], (c.components || []).map(function (x) {
			var details = (x.modules || []).map(function (m) { return "モジュール " + m.name + (m.model ? "(" + m.model + ")" : "") + (m.version ? " " + m.version : ""); })
				.concat((x.details || []).map(function (d) { return d.label + ": " + d.value; }));
			return [x.name, STATE_TEXT[stateOf(x)], x.product, x.configured === false ? null : (x.version == null ? "不明" : x.version), x.apiVersion,
				mdRuntime(x.runtime), details.join(" / ")];
		})));
		out.push("## 直接使っているライブラリ");
		out.push("");
		out.push((c.packageCount != null ? "入っている部品は全部で " + c.packageCount + " 個(" + (c.packageSource || "") + ")。\n\n" : "") +
			mdTable(["部品", "版"], (c.dependencies || []).map(function (d) { return [d.name, d.version]; })));
		if (packages) {
			out.push("## 部品表(全部 " + packages.packages.length + " 個。" + (packages.source || "") + ")");
			out.push("");
			out.push(mdTable(["部品", "版", "直接", "場所"], packages.packages.map(function (p) { return [p.name, p.version, p.direct ? "直接" : "", p.path]; })));
		}
		return {text: out.join("\n"), service: service};
	};

	AdminServer.prototype.exportMarkdown = function (how, button) {
		var self = this;
		if (!this.lastStatus || !this.lastComponents) {
			(window.UI ? UI.error({body: "まだ読み込み中。読み終えてから、もう一度。"}) : null);
			return;
		}
		var all = this.part("mdall").checked;
		var packages = all ? this.get("/packages?q=") : Promise.resolve(null);
		packages.then(function (p) {
			var md = self.markdown(p);
			if (how === "copy") {
				if (window.UI) { UI.copy(button, md.text); return; }
				navigator.clipboard.writeText(md.text);
				return;
			}
			var d = new Date(), pad = function (n) { return (n < 10 ? "0" : "") + n; };
			var name = md.service.replace(/[\\/:*?"<>|\s]+/g, "_") + "-server-status-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".md";
			var url = URL.createObjectURL(new Blob([md.text], {type: "text/markdown;charset=utf-8"}));
			var a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
		}, function (err) {
			if (window.UI) UI.error({body: "部品表を読めなかった。", detail: err.message});
		});
	};

	// API の回数の上限(このサーバー全体の設定)。値ごとに、いまの上限・出どころ・変える欄
	var RATE_KINDS = [["authenticated", "ログインした人・APIキー(利用者ごと)"], ["anonymous", "ログインしていない呼び出し(IP ごと)"]];
	AdminServer.prototype.showRateLimit = function (rl) {
		var self = this;
		var box = this.part("ratelimit");
		this.part("rlwindow").textContent = rl && rl.windowMinutes ? rl.windowMinutes + " 分あたりの回数" : "";
		if (!rl) { box.innerHTML = "<div class=\"runtime_text\" style=\"padding:4px 14px\">回数の上限の返却なし</div>"; return; }
		var src = function (item) {
			if (item.source === "setting") return "この画面で変更(" + esc(item.updatedBy || "不明") + "・" + esc(when(item.updatedAt)) + ")";
			if (item.source === "env") return "環境変数 " + esc(item.env || "");
			return "既定の値" + (item.env ? "(環境変数 " + esc(item.env) + " で変更可)" : "");
		};
		box.innerHTML = (rl.disabled ? "<div class=\"msg_error\" style=\"margin:4px 14px\">いまは回数の上限を切っている(RATE_LIMIT_DISABLED。テスト用)。保存した値は、切るのをやめたときに使う</div>" : "") +
			table(["対象", "上限", "出どころ", "操作"], RATE_KINDS.filter(function (k) { return rl[k[0]]; }).map(function (k) {
				var item = rl[k[0]];
				return "<tr><td>" + esc(k[1]) + "</td>" +
					"<td style=\"white-space:nowrap\"><input type=\"number\" class=\"search_input\" style=\"width:8em\" data-rate=\"" + k[0] + "\"" +
					(item.min != null ? " min=\"" + esc(item.min) + "\"" : "") + (item.max != null ? " max=\"" + esc(item.max) + "\"" : "") +
					" value=\"" + esc(item.limit) + "\"> 回" + (item.min != null ? "<div class=\"runtime_text\">" + esc(item.min) + " 〜 " + esc(item.max) + "</div>" : "") + "</td>" +
					"<td class=\"runtime_text\" data-rate-note=\"" + k[0] + "\">" + src(item) + "</td>" +
					"<td style=\"white-space:nowrap\"><button type=\"button\" class=\"search_btn\" data-rate-save=\"" + k[0] + "\">保存</button>" +
					(item.source === "setting" ? " <button type=\"button\" class=\"search_btn\" data-rate-reset=\"" + k[0] + "\">既定に戻す</button>" : "") + "</td></tr>";
			}));
		var buttons = box.querySelectorAll("[data-rate-save]");
		for (var i = 0; i < buttons.length; i += 1) {
			buttons[i].addEventListener("click", function (e) { self.saveRateLimit(e.target.getAttribute("data-rate-save")); });
		}
		var resets = box.querySelectorAll("[data-rate-reset]");
		for (var j = 0; j < resets.length; j += 1) {
			resets[j].addEventListener("click", function (e) { self.resetRateLimit(e.target.getAttribute("data-rate-reset")); });
		}
	};

	// この画面で変えた値を消して、環境変数(無ければ既定)の値に戻す
	AdminServer.prototype.resetRateLimit = function (kind) {
		var self = this;
		var note = this.root.querySelector("[data-rate-note=\"" + kind + "\"]");
		confirmModal({title: "回数の上限を戻す", ok: "戻す", body: "この画面で変えた上限を消して、環境変数(無ければ既定)の値に戻す。"}).then(function (yes) {
			if (!yes) return;
			if (self.sample) { note.textContent = "見本のため保存しない(既定に戻す)"; return; }
			fetch(self.base + "/rate-limit/" + encodeURIComponent(kind), {method: "DELETE", credentials: "same-origin", headers: {"Accept": "application/json"}}).then(function (res) {
				if (res.status === 401) { window.location.href = self.login; throw new Error("unauthenticated"); }
				if (res.status === 403) { notifyForbidden(); throw new Error("権限なし"); }
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.json();
			}).then(function (rl) { self.showRateLimit(rl); }, function (err) {
				note.innerHTML = "<span class=\"msg_error\" style=\"display:inline-block;padding:2px 8px\">戻せなかった: " + esc(err.message) + "</span>";
			});
		});
	};

	AdminServer.prototype.saveRateLimit = function (kind) {
		var self = this;
		var input = this.root.querySelector("[data-rate=\"" + kind + "\"]");
		var note = this.root.querySelector("[data-rate-note=\"" + kind + "\"]");
		var value = Number(input.value);
		if (this.sample) { note.textContent = "見本のため保存しない(" + value + " 回)"; return; }
		var body = {};
		body[kind] = value;
		fetch(this.base + "/rate-limit", {
			method: "PUT", credentials: "same-origin",
			headers: {"Content-Type": "application/json", "Accept": "application/json"},
			body: JSON.stringify(body)
		}).then(function (res) {
			if (res.status === 401) { window.location.href = self.login; throw new Error("unauthenticated"); }
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		}).then(function (rl) { self.showRateLimit(rl); }, function (err) {
			note.innerHTML = "<span class=\"msg_error\" style=\"display:inline-block;padding:2px 8px\">保存失敗: " + esc(err.message) + "</span>";
		});
	};

	AdminServer.prototype.setFeature = function (feature, input) {
		var self = this;
		var note = this.root.querySelector("[data-feature-note=\"" + input.getAttribute("data-feature") + "\"]");
		var enabled = input.checked;
		if (this.sample) {
			note.textContent = (feature.note ? feature.note + "。" : "") + "見本のため保存しない";
			return;
		}
		input.disabled = true;
		fetch(this.base + "/features/" + encodeURIComponent(feature.key), {
			method: "PUT", credentials: "same-origin",
			headers: {"Content-Type": "application/json", "Accept": "application/json"},
			body: JSON.stringify({enabled: enabled})
		}).then(function (res) {
			if (res.status === 401) { window.location.href = self.login; throw new Error("unauthenticated"); }
			if (!res.ok) throw new Error("HTTP " + res.status);
			feature.enabled = enabled;
			note.textContent = (feature.note ? feature.note + "。" : "") + "保存済み(" + when(new Date().toISOString()) + ")";
		}).catch(function (err) {
			input.checked = !enabled;     // 保存できなかったら、元に戻す
			note.innerHTML = "<span class=\"msg_error\" style=\"display:inline-block;padding:2px 8px\">保存失敗: " + esc(err.message) + "</span>";
		}).then(function () { input.disabled = false; });
	};

	AdminServer.prototype.showComponents = function (data) {
		if (data) this.lastComponents = data;
		var list = data ? data.components : [{key: "app", name: "本体"}];
		this.part("checked").textContent = data ? "確認日時 " + when(data.checkedAt) : "Checking…";
		this.part("connections").innerHTML = table(["接続先", "状態", "応答時間", "最終成功", "補足"],
			data ? list.filter(function (c) { return c.key !== "app"; }).map(function (c) {
				var st = stateOf(c);
				return "<tr" + (st === "unreachable" ? " class=\"row_failed\"" : "") + "><td>" + esc(c.name) + "</td><td>" + badge(STATE[st]) + "</td>" +
					"<td style=\"white-space:nowrap\">" + (st === "unconfigured" ? "―" : c.latencyMs != null ? esc(c.latencyMs) + " ms" : c.reachable === false ? "時間切れ" : "―") + "</td>" +
					"<td style=\"white-space:nowrap\">" + esc(when(c.lastSuccessAt)) + "</td>" +
					"<td>" + (st === "unconfigured" ? "この機能は未使用" : esc(c.error || "")) + "</td></tr>";
			}) : ["<tr><td colspan=\"5\">" + badge(STATE.checking) + "</td></tr>"]);
		this.part("components").innerHTML = table(["部品", "状態", "製品と版", "土台・詳細"], list.map(function (c) {
			var st = stateOf(data ? c : null);
			if (!data) return "<tr><td>" + esc(c.name) + "</td><td>" + badge(STATE[st]) + "</td><td></td><td></td></tr>";
			var product = st === "unconfigured" ? "―" : (c.product ? esc(c.product) + " " : "") + ver(c.version);
			var extra = detailsText(c);
			return "<tr><td>" + esc(c.name) + "</td><td>" + badge(STATE[st]) + "</td>" +
				"<td>" + product + (extra ? "<div class=\"runtime_text\">" + extra + "</div>" : "") + "</td>" +
				"<td>" + (st === "unconfigured" ? "―" : st === "unreachable" ? "<span class=\"runtime_text\">" + esc(c.error || "応答なし") + "</span>" : runtimeCell(c)) + "</td></tr>";
		}));
		if (data) {
			this.part("pkgcount").textContent = data.packageCount != null ? "入っている部品 " + data.packageCount + " 個(" + (data.packageSource || "") + ")" : "";
			this.deps = data.dependencies || [];
			this.loadPackages(this.part("q").value.trim());
		}
	};

	AdminServer.prototype.loadPackages = function (q) {
		var self = this;
		var box = this.part("packages");
		if (q === "") {
			// 探す言葉が無ければ、直接使っているライブラリを出す
			box.innerHTML = "<div class=\"result_meta\" style=\"border:0\">直接使用のライブラリ " + this.deps.length + " 個。名前の入力で、部品表の全体から検索(入れ子に入った別の版も表示)。</div>" +
				"<div style=\"max-width:560px\">" + table(["部品", "版"], this.deps.map(function (d) { return "<tr><td class=\"version_text\">" + esc(d.name) + "</td><td>" + ver(d.version) + "</td></tr>"; })) + "</div>";
			return;
		}
		this.get("/packages?q=" + encodeURIComponent(q)).then(function (r) {
			if (self.part("q").value.trim() !== q) return;
			box.innerHTML = "<div class=\"result_meta\" style=\"border:0\">「" + esc(q) + "」を含む部品 " + r.count + " 個(全 " + r.total + " 個中)</div>" +
				table(["部品", "版", "直接", "場所"], r.packages.map(function (p) {
					return "<tr><td class=\"version_text\">" + esc(p.name) + "</td><td>" + ver(p.version) + "</td><td>" + (p.direct ? "直接" : "") + "</td><td class=\"version_text\">" + esc(p.path || "") + "</td></tr>";
				}), "「" + esc(q) + "」を含む部品なし");
		}, function (err) { self.fail(["packages"], err); });
	};

	// ======================================================================
	// 共通の道具(利用者・セッション・監査ログ)
	// ======================================================================

	var ICON = {
		edit: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z\"/></svg>",
		trash: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/></svg>",
		refresh: "<svg class=\"inline_icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>"
	};
	var DEFAULT_ROLES = [{value: "admin", label: "管理者"}, {value: "readwrite", label: "編集可"}, {value: "readonly", label: "閲覧のみ"}];
	var ROLE_BADGE = {admin: "processing", readwrite: "completed", readonly: "unknown"};

	function roleLabel(roles, value) {
		for (var i = 0; i < roles.length; i += 1) if (roles[i].value === value) return roles[i].label;
		return value == null ? "台帳に無い" : value;
	}
	function unknown(value, format) {
		// 記録していない値は、空欄にせず「不明」と出す
		return value == null || value === "" ? "<span class=\"null_val\">不明</span>" : (format ? format(value) : esc(value));
	}
	function linkReload(label) {
		return "<a href=\"#\" data-act=\"reload\" style=\"font-size:9pt;color:#187FF5;text-decoration:none;\">" + ICON.refresh + esc(label) + "</a>";
	}

	// 見本と本物の WebAPI の切り替え、401 のときのログインの画面への移動、エラーの文
	function Api(root) {
		this.root = root;
		this.base = root.getAttribute("data-base");
		this.login = root.getAttribute("data-login") || "./";
		var sampleId = root.getAttribute("data-sample");
		var node = sampleId ? document.getElementById(sampleId) : null;
		this.sample = node ? JSON.parse(node.textContent) : null;
	}
	Api.prototype.request = function (method, path, body, sampleAnswer) {
		var self = this;
		if (this.sample) {
			return new Promise(function (resolve) { setTimeout(function () { resolve(sampleAnswer ? sampleAnswer() : null); }, 80); });
		}
		var opts = {method: method, credentials: "same-origin", headers: {"Accept": "application/json"}};
		if (body !== undefined) {
			opts.headers["Content-Type"] = "application/json";
			opts.body = JSON.stringify(body);
		}
		return fetch(this.base + path, opts).then(function (res) {
			if (res.status === 401) {
				// 認証切れは、必ずログインの画面へ戻す(403 や 5xx では移らない)
				window.location.href = self.login;
				throw new Error("unauthenticated");
			}
			if (res.status === 403) { notifyForbidden(); throw new Error("権限なし"); }
			return res.json().catch(function () { return {}; }).then(function (data) {
				if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
				return data;
			});
		});
	};

	// 確認のモーダル。左にキャンセル、右に実行。押すまで待つ(true / false)
	function confirmModal(opts) {
		if (window.UI && window.UI.confirm) return window.UI.confirm(opts);   // ui.js があれば、そちら(Esc で閉じる、キーボードの移動を中に閉じる)
		return new Promise(function (resolve) {
			var wrap = document.createElement("div");
			wrap.innerHTML = "<input type=\"checkbox\" class=\"modal_toggle\" hidden checked>" +
				"<div class=\"modal_overlay\"><div class=\"modal_backdrop\"></div><div class=\"modal_box\">" +
				"<div class=\"modal_title" + (opts.danger ? " danger" : "") + "\">" + esc(opts.title) + "</div>" +
				"<div class=\"modal_body\">" + opts.body + "</div>" +
				"<div class=\"modal_actions\"><button type=\"button\" class=\"cancel_button\" style=\"width:auto\" data-ans=\"no\">キャンセル</button>" +
				"<button type=\"button\" class=\"" + (opts.danger ? "caution_button" : "entry_button") + "\" style=\"width:auto\" data-ans=\"yes\">" + esc(opts.ok) + "</button></div>" +
				"</div></div>";
			document.body.appendChild(wrap);
			var done = function (answer) { document.body.removeChild(wrap); resolve(answer); };
			wrap.querySelector("[data-ans=yes]").addEventListener("click", function () { done(true); });
			wrap.querySelector("[data-ans=no]").addEventListener("click", function () { done(false); });
			wrap.querySelector(".modal_backdrop").addEventListener("click", function () { done(false); });
			wrap.querySelector("[data-ans=no]").focus();
		});
	}
	function flash(box, html, ok) {
		box.innerHTML = "<div class=\"" + (ok ? "msg_success" : "msg_error") + "\" style=\"margin:8px 14px\">" + html + "</div>";
	}

	// ======================================================================
	// 利用者(台帳)
	//   GET    {base}            → {users: [{email, role, addedBy, addedAt, lastLoginAt}], roles: [{value, label}], self}
	//   POST   {base}            ← {email, role}
	//   PUT    {base}/{email}    ← {role}
	//   DELETE {base}/{email}
	//   最後の管理者を外す・下げるのは、サーバーが 409 で断る
	// ======================================================================

	function AdminUsers(root) { Api.call(this, root); this.data = null; }
	AdminUsers.prototype = Object.create(Api.prototype);

	AdminUsers.prototype.render = function () {
		var self = this;
		this.root.innerHTML =
			"<form class=\"filter_panel\" data-part=\"add\"><div class=\"search_form\">" +
			"<span class=\"filter_label\">メールアドレス</span><input type=\"email\" class=\"search_input\" data-part=\"email\" placeholder=\"user@example.com\" required>" +
			"<span class=\"filter_label\">権限</span><select class=\"search_input\" style=\"min-width:8em\" data-part=\"role\"></select>" +
			"<button type=\"submit\" class=\"search_btn\">＋ 追加</button></div></form>" +
			"<div data-part=\"msg\"></div>" +
			"<div class=\"result_meta\"><span data-part=\"count\"></span><span style=\"margin-left:auto\">" + linkReload("読み直す") + "</span></div>" +
			"<div data-part=\"list\"></div>";
		this.root.querySelector("[data-act=reload]").addEventListener("click", function (e) { e.preventDefault(); self.load(); });
		this.root.querySelector("[data-part=add]").addEventListener("submit", function (e) { e.preventDefault(); self.add(); });
	};

	AdminUsers.prototype.load = function () {
		var self = this;
		this.request("GET", "", undefined, function () { return self.sample; }).then(function (d) { self.show(d); }, function (err) {
			flash(self.part("list"), "取得失敗: " + esc(err.message));
		});
	};
	AdminUsers.prototype.part = function (n) { return this.root.querySelector("[data-part=" + n + "]"); };

	AdminUsers.prototype.show = function (d) {
		var self = this;
		this.data = d;
		var roles = d.roles || DEFAULT_ROLES;
		this.part("role").innerHTML = roles.map(function (r) {
			return "<option value=\"" + esc(r.value) + "\"" + (r.value === "readwrite" ? " selected" : "") + ">" + esc(r.label) + "</option>";
		}).join("");
		var users = d.users || [];
		var admins = users.filter(function (u) { return u.role === "admin"; }).length;
		this.part("count").textContent = users.length + " 人(管理者 " + admins + " 人)";
		this.part("list").innerHTML = table(["メールアドレス", "権限", "追加日時", "追加した人", "最終ログイン", "操作"], users.map(function (u, i) {
			var me = u.email === d.self;
			return "<tr><td>" + esc(u.email) + (me ? " <span class=\"status_badge processing\">自分</span>" : "") + "</td>" +
				"<td data-role-cell=\"" + i + "\"><span class=\"status_badge " + (ROLE_BADGE[u.role] || "unknown") + "\">" + esc(roleLabel(roles, u.role)) + "</span></td>" +
				"<td style=\"white-space:nowrap\">" + esc(when(u.addedAt)) + "</td><td>" + unknown(u.addedBy) + "</td>" +
				"<td style=\"white-space:nowrap\">" + unknown(u.lastLoginAt, function (v) { return esc(when(v)); }) + "</td>" +
				"<td class=\"row_actions\"><a href=\"#\" class=\"icon_button\" title=\"権限を変える\" aria-label=\"権限を変える\" data-edit=\"" + i + "\">" + ICON.edit + "</a>" +
				(me ? "" : "<a href=\"#\" class=\"icon_button danger\" title=\"削除\" aria-label=\"削除\" data-del=\"" + i + "\">" + ICON.trash + "</a>") + "</td></tr>";
		}), "台帳に利用者なし(登録まで、誰もログイン不可)");
		this.root.querySelectorAll("[data-edit]").forEach(function (a) {
			a.addEventListener("click", function (e) { e.preventDefault(); self.edit(users[Number(a.getAttribute("data-edit"))], Number(a.getAttribute("data-edit"))); });
		});
		this.root.querySelectorAll("[data-del]").forEach(function (a) {
			a.addEventListener("click", function (e) { e.preventDefault(); self.remove(users[Number(a.getAttribute("data-del"))]); });
		});
	};

	AdminUsers.prototype.add = function () {
		var self = this;
		var email = this.part("email").value.trim(), role = this.part("role").value;
		if (!email) return;
		this.request("POST", "", {email: email, role: role}, function () {
			self.sample.users.push({email: email, role: role, addedBy: self.sample.self, addedAt: new Date().toISOString(), lastLoginAt: null});
			return {};
		}).then(function () {
			self.part("email").value = "";
			flash(self.part("msg"), "「" + esc(email) + "」を追加" + (self.sample ? "(見本のため保存しない)" : ""), true);
			self.load();
		}, function (err) { flash(self.part("msg"), "追加失敗: " + esc(err.message)); });
	};

	AdminUsers.prototype.edit = function (user, i) {
		var self = this;
		var roles = this.data.roles || DEFAULT_ROLES;
		var cell = this.root.querySelector("[data-role-cell=\"" + i + "\"]");
		cell.innerHTML = "<select class=\"search_input\" style=\"min-width:7em\">" + roles.map(function (r) {
			return "<option value=\"" + esc(r.value) + "\"" + (r.value === user.role ? " selected" : "") + ">" + esc(r.label) + "</option>";
		}).join("") + "</select> <button type=\"button\" class=\"search_btn\" data-ok>保存</button> <button type=\"button\" class=\"search_btn\" data-cancel>やめる</button>";
		cell.querySelector("[data-cancel]").addEventListener("click", function () { self.show(self.data); });
		cell.querySelector("[data-ok]").addEventListener("click", function () {
			var role = cell.querySelector("select").value;
			var lowerSelf = user.email === self.data.self && user.role === "admin" && role !== "admin";
			var go = lowerSelf ? confirmModal({title: "自分の権限の変更", danger: true, ok: "変更する",
				body: "自分を管理者から外す。<b>この画面は、変更の後は使えない。</b>"}) : Promise.resolve(true);
			go.then(function (yes) {
				if (!yes) return;
				self.request("PUT", "/" + encodeURIComponent(user.email), {role: role}, function () { user.role = role; return {}; }).then(function () {
					flash(self.part("msg"), "「" + esc(user.email) + "」の権限を「" + esc(roleLabel(roles, role)) + "」に変更" + (self.sample ? "(見本のため保存しない)" : ""), true);
					self.load();
				}, function (err) { flash(self.part("msg"), "変更失敗: " + esc(err.message)); self.show(self.data); });
			});
		});
	};

	AdminUsers.prototype.remove = function (user) {
		var self = this;
		confirmModal({title: "利用者の削除", danger: true, ok: "削除する",
			body: "「" + esc(user.email) + "」を台帳から削除。この利用者は、次からログイン不可。ログイン中のセッションも停止。"}).then(function (yes) {
			if (!yes) return;
			self.request("DELETE", "/" + encodeURIComponent(user.email), undefined, function () {
				self.sample.users = self.sample.users.filter(function (u) { return u !== user; });
				return {};
			}).then(function () {
				flash(self.part("msg"), "「" + esc(user.email) + "」を削除" + (self.sample ? "(見本のため保存しない)" : ""), true);
				self.load();
			}, function (err) { flash(self.part("msg"), "削除失敗: " + esc(err.message)); });
		});
	};

	// ======================================================================
	// セッション(利用者ごとのカード)
	//   GET  {base}          → {users: [{user, role, isSelf, sessions: [{id, loginAt, lastSeenAt, ip, userAgent, expiresAt, current}],
	//                                    apiKeys: [{label, role, createdAt, expiresAt, lastUsedAt, lastClient, clientVersion, clientOutdated}]}],
	//                          skillClientVersion}(lastClient 以降と skillClientVersion は Document Manager が足した物。無ければ出さない)
	//   GET  {base}/history  → [{id, at, by, targetUser, sessions, apiKeys, sessionDetails: [{loginAt, lastSeenAt, ip, userAgent}](任意)}]
	//   POST {base}/revoke   ← {user}  → {user, sessions, apiKeys, revokedAt, keptCurrentSession}
	// ======================================================================

	function AdminSessions(root) { Api.call(this, root); }
	AdminSessions.prototype = Object.create(Api.prototype);
	AdminSessions.prototype.part = AdminUsers.prototype.part;

	AdminSessions.prototype.render = function () {
		var self = this;
		this.root.innerHTML =
			"<div data-part=\"msg\"></div>" +
			"<div class=\"result_meta\"><span data-part=\"count\"></span><span style=\"margin-left:auto\">" + linkReload("読み直す") + "</span></div>" +
			"<div class=\"session_list\" data-part=\"list\"></div>" +
			"<div class=\"panel_section_title\">切断の履歴</div><div data-part=\"history\"></div>";
		this.root.querySelector("[data-act=reload]").addEventListener("click", function (e) { e.preventDefault(); self.load(); });
	};

	AdminSessions.prototype.load = function () {
		var self = this;
		this.request("GET", "", undefined, function () { return {users: self.sample.users}; }).then(function (d) { self.show(d); }, function (err) {
			flash(self.part("list"), "取得失敗: " + esc(err.message));
		});
		this.request("GET", "/history", undefined, function () { return self.sample.history; }).then(function (h) { self.showHistory(h); }, function (err) {
			flash(self.part("history"), "取得失敗: " + esc(err.message));
		});
	};

	AdminSessions.prototype.show = function (d) {
		var self = this;
		var users = (d.users || []).slice().sort(function (a, b) {
			var last = function (u) { return u.sessions.reduce(function (m, s) { return s.lastSeenAt > m ? s.lastSeenAt : m; }, "") || ""; };
			return last(b) < last(a) ? -1 : last(b) > last(a) ? 1 : 0;
		});
		this.part("count").textContent = "セッションか APIキーを持つ利用者 " + users.length + " 人(最終アクセスの新しい順)" +
			(d.skillClientVersion ? "。配っている Skill の版 " + d.skillClientVersion : "");
		// 最後に使ったクライアント。同梱の Skill なら版を出し、配っている版より古ければ印を付ける
		var clientOf = function (k) {
			if (k.clientVersion) {
				return "・Skill " + esc(k.clientVersion) + (k.clientOutdated
					? " <span class=\"status_badge stale\" title=\"配っている版は " + esc(d.skillClientVersion || "") + "。利用者に Skill の入れ替えを頼む\">古い</span>"
					: "");
			}
			if (k.lastClient) {
				var shortName = k.lastClient.length > 40 ? k.lastClient.slice(0, 40) + "…" : k.lastClient;
				return "・<span title=\"" + esc(k.lastClient) + "\">" + esc(shortName) + "</span>";
			}
			return "";
		};
		this.part("list").innerHTML = users.map(function (u, i) {
			var sessions = u.sessions.length ? "<div class=\"data_table_wrap\"><table class=\"session_table\"><thead><tr><th></th><th>ログイン</th><th>最終アクセス</th><th>接続元 IP</th><th>ブラウザ等</th><th>期限</th></tr></thead><tbody>" +
				u.sessions.map(function (s) {
					return "<tr><td>" + (s.current ? "<span class=\"status_badge processing\" title=\"いま操作しているこの画面。自分を切断しても残る\">この画面</span>" : "") + "</td>" +
						"<td>" + unknown(s.loginAt, function (v) { return esc(when(v)); }) + "</td><td>" + unknown(s.lastSeenAt, function (v) { return esc(when(v)); }) + "</td>" +
						"<td>" + unknown(s.ip) + "</td><td class=\"session_ua\">" + unknown(s.userAgent) + "</td><td>" + esc(when(s.expiresAt)) + "</td></tr>";
				}).join("") + "</tbody></table></div>"
				: "<div class=\"session_keys\">ログイン中のセッションなし(APIキーだけで使用)。</div>";
			var keys = u.apiKeys.length ? u.apiKeys.map(function (k) {
				return esc(k.label) + "(" + esc(roleLabel(DEFAULT_ROLES, k.role)) + "・最終利用 " + (k.lastUsedAt ? esc(when(k.lastUsedAt)) : "なし") + clientOf(k) + ")";
			}).join("、") : "なし";
			return "<div class=\"session_card\"><div class=\"session_head\"><span class=\"session_user\">" + esc(u.user) + "</span>" +
				(u.isSelf ? " <span class=\"status_badge processing\">自分</span>" : "") +
				"<span class=\"session_meta\">" + esc(u.role == null ? "台帳に無い" : roleLabel(DEFAULT_ROLES, u.role)) + "　セッション " + u.sessions.length + " 件 / APIキー " + u.apiKeys.length + " 件</span>" +
				"<button type=\"button\" class=\"caution_button session_revoke\" data-revoke=\"" + i + "\">切断する</button></div>" + sessions +
				"<div class=\"session_keys\">APIキー " + u.apiKeys.length + " 件: " + keys + "</div></div>";
		}).join("") || "<div class=\"runtime_text\" style=\"padding:8px 14px\">ログイン中の利用者も、有効な APIキーもなし</div>";
		this.root.querySelectorAll("[data-revoke]").forEach(function (b) {
			b.addEventListener("click", function () { self.revoke(users[Number(b.getAttribute("data-revoke"))]); });
		});
	};

	AdminSessions.prototype.showHistory = function (h) {
		// sessionDetails(任意): 切ったセッションの、ログイン・最終アクセス・接続元 IP・ブラウザ等。どこから入られていたかを、後から追う手がかり
		this.part("history").innerHTML = table(["日時", "切断した利用者", "切断した人", "止めた物", "切ったセッションの手がかり"], (h || []).map(function (r) {
			var details = (r.sessionDetails || []).map(function (d) {
				return unknown(d.ip) + "・" + unknown(d.userAgent) + "<br><span class=\"runtime_text\">ログイン " + unknown(d.loginAt, function (v) { return esc(when(v)); }) +
					" / 最終アクセス " + unknown(d.lastSeenAt, function (v) { return esc(when(v)); }) + "</span>";
			}).join("<hr style=\"border:0;border-top:1px solid #eee;margin:4px 0\">");
			return "<tr><td style=\"white-space:nowrap\">" + esc(when(r.at)) + "</td><td>" + esc(r.targetUser) + "</td><td>" + esc(r.by) + "</td>" +
				"<td style=\"white-space:nowrap\">セッション " + unknown(r.sessions) + "、APIキー " + unknown(r.apiKeys) + "</td>" +
				"<td class=\"session_ua\">" + (details || "―") + "</td></tr>";
		}), "切断の履歴なし");
	};

	AdminSessions.prototype.revoke = function (u) {
		var self = this;
		confirmModal({title: "利用者の切断", danger: true, ok: "切断する",
			body: "「" + esc(u.user) + "」を切断。ログイン中のセッション " + u.sessions.length + " 件と、APIキー " + u.apiKeys.length + " 件が停止。" +
				"<b>APIキーは元に戻せない。</b>" + (u.isSelf ? "<br>自分の切断。いま操作しているこの画面のセッションだけは残る。" : "")}).then(function (yes) {
			if (!yes) return;
			self.request("POST", "/revoke", {user: u.user}, function () {
				self.sample.history.unshift({at: new Date().toISOString(), by: self.sample.self, targetUser: u.user, sessions: u.sessions.length, apiKeys: u.apiKeys.length});
				self.sample.users = self.sample.users.filter(function (x) { return x !== u; });
				return {user: u.user, sessions: u.sessions.length, apiKeys: u.apiKeys.length};
			}).then(function (r) {
				flash(self.part("msg"), "「" + esc(r.user) + "」を切断(セッション " + esc(r.sessions) + " 件、APIキー " + esc(r.apiKeys) + " 件)" + (self.sample ? "。見本のため保存しない" : ""), true);
				self.load();
			}, function (err) { flash(self.part("msg"), "切断失敗: " + esc(err.message)); });
		});
	};

	// ======================================================================
	// 監査ログ(全員ぶん)
	//   GET {base}?range=1d|7d|30d&user=&action=&target=&before=   (range は、いまから遡る 24 時間・7 日・30 日)
	//     → {entries: [{id, at, user, action, target, result, via, keyRole, ip}], actions: [{value, label}], limit, nextBefore}
	//   result は success / denied / failed、via は screen / apikey。nextBefore があれば、その続きがある
	// ======================================================================

	var RESULT = {success: ["completed", "Success"], denied: ["failed", "Denied"], failed: ["failed", "Error"]};
	var RANGES = [["1d", "直近24時間"], ["7d", "直近7日間"], ["30d", "直近30日間"]];   // どれも、いまから遡る期間

	function AdminAudit(root) { Api.call(this, root); this.range = "7d"; this.entries = []; this.actions = []; }
	AdminAudit.prototype = Object.create(Api.prototype);
	AdminAudit.prototype.part = AdminUsers.prototype.part;

	AdminAudit.prototype.render = function () {
		var self = this;
		this.root.innerHTML =
			"<form class=\"filter_panel\" data-part=\"filter\">" +
			"<div class=\"filter_group\"><span class=\"filter_label\">期間</span>" + RANGES.map(function (r) {
				return "<a href=\"#\" class=\"range_btn" + (r[0] === self.range ? " active" : "") + "\" data-range=\"" + r[0] + "\">" + esc(r[1]) + "</a>";
			}).join("") + "</div>" +
			"<div class=\"search_form\"><span class=\"filter_label\">利用者</span><input type=\"text\" class=\"search_input\" data-part=\"user\" placeholder=\"メールアドレスの一部\">" +
			"<span class=\"filter_label\">操作</span><select class=\"search_input\" style=\"min-width:9em\" data-part=\"action\"><option value=\"\">全部</option></select>" +
			"<span class=\"filter_label\">対象</span><input type=\"text\" class=\"search_input\" data-part=\"target\" placeholder=\"ID や名前の一部\">" +
			"<button type=\"submit\" class=\"search_btn\">検索</button></div></form>" +
			"<div class=\"result_meta\"><span data-part=\"count\"></span></div>" +
			"<div data-part=\"list\"></div><div data-part=\"more\" style=\"padding:8px 14px\"></div>";
		this.root.querySelectorAll("[data-range]").forEach(function (a) {
			a.addEventListener("click", function (e) {
				e.preventDefault();
				self.range = a.getAttribute("data-range");
				self.root.querySelectorAll("[data-range]").forEach(function (x) { x.classList.toggle("active", x === a); });
				self.load(false);
			});
		});
		this.part("filter").addEventListener("submit", function (e) { e.preventDefault(); self.load(false); });
	};

	AdminAudit.prototype.query = function (before) {
		var q = ["range=" + this.range];
		var self = this;
		["user", "action", "target"].forEach(function (n) { var v = self.part(n).value.trim(); if (v) q.push(n + "=" + encodeURIComponent(v)); });
		if (before) q.push("before=" + encodeURIComponent(before));
		return "?" + q.join("&");
	};

	AdminAudit.prototype.sampleAnswer = function () {
		// 見本: 絞り込みだけを、手元で行う
		var self = this, s = this.sample;
		var user = this.part("user").value.trim().toLowerCase(), action = this.part("action").value, target = this.part("target").value.trim().toLowerCase();
		var list = s.entries.filter(function (e) {
			return (!user || e.user.toLowerCase().indexOf(user) >= 0) && (!action || e.action === action) && (!target || String(e.target || "").toLowerCase().indexOf(target) >= 0);
		});
		return {entries: list, actions: s.actions, limit: s.limit, nextBefore: null, range: self.range};
	};

	AdminAudit.prototype.load = function (more) {
		var self = this;
		var before = more ? this.nextBefore : null;
		this.request("GET", this.query(before), undefined, function () { return self.sampleAnswer(); }).then(function (d) {
			if (!more) self.entries = [];
			self.entries = self.entries.concat(d.entries || []);
			self.nextBefore = d.nextBefore || null;
			if (d.actions && !self.actions.length) {
				self.actions = d.actions;
				self.part("action").innerHTML = "<option value=\"\">全部</option>" + d.actions.map(function (a) {
					return "<option value=\"" + esc(a.value) + "\">" + esc(a.label) + "</option>";
				}).join("");
			}
			self.show(d.limit);
		}, function (err) { flash(self.part("list"), "取得失敗: " + esc(err.message)); });
	};

	AdminAudit.prototype.show = function (limit) {
		var self = this;
		var label = function (v) { for (var i = 0; i < self.actions.length; i += 1) if (self.actions[i].value === v) return self.actions[i].label; return v; };
		this.part("count").textContent = this.entries.length + " 件(新しい順" + (limit ? "。1 回に " + limit + " 件まで" : "") + ")";
		this.part("list").innerHTML = table(["日時", "利用者", "操作", "対象", "結果", "経路", "IP"], this.entries.map(function (e) {
			var r = RESULT[e.result] || ["unknown", e.result || "不明"];
			return "<tr" + (e.result && e.result !== "success" ? " class=\"row_failed\"" : "") + "><td style=\"white-space:nowrap\">" + esc(when(e.at)) + "</td>" +
				"<td>" + esc(e.user) + "</td><td>" + esc(label(e.action)) + "</td><td>" + (e.target == null || e.target === "" ? "―" : esc(e.target)) + "</td><td>" + badge(r) + "</td>" +
				"<td>" + (e.via === "apikey" ? "APIキー" + (e.keyRole ? "(" + esc(e.keyRole) + ")" : "") : "画面") + "</td><td>" + unknown(e.ip) + "</td></tr>";
		}), "該当する記録なし");
		var moreBox = this.part("more");
		moreBox.innerHTML = this.nextBefore ? "<button type=\"button\" class=\"search_btn\">さらに読む</button>" : "";
		if (this.nextBefore) moreBox.querySelector("button").addEventListener("click", function () { self.load(true); });
	};

	// タブ(tab_set)の中にある物は、そのタブが見えたときに初めて読む(サーバーのタブの、相手への問い合わせを、見ないときに走らせない)。
	// タブの外の物は、すぐ読む。data-load="eager" を付けると、タブの中でもすぐ読む
	var KINDS = [["admin_users", AdminUsers], ["admin_sessions", AdminSessions], ["admin_audit", AdminAudit], ["admin_server", AdminServer]];
	var pending = [];
	function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
	function loadVisible() {
		pending = pending.filter(function (a) {
			if (!visible(a.root)) return true;
			a.load();
			return false;
		});
	}
	function start() {
		KINDS.forEach(function (k) {
			var nodes = document.querySelectorAll("." + k[0]);
			for (var i = 0; i < nodes.length; i += 1) {
				var a = new k[1](nodes[i]);
				a.render();
				if (nodes[i].getAttribute("data-load") === "eager" || !nodes[i].closest(".tab_panel")) a.load();
				else pending.push(a);
			}
		});
		loadVisible();
		document.addEventListener("change", function (e) { if (e.target.classList && e.target.classList.contains("tab_toggle")) loadVisible(); });
	}

	// サービスの独自のタブや、JS でタブを切り替える画面から使う部品
	window.AdminUI = {
		confirm: confirmModal,   // AdminUI.confirm({title, body(HTML), ok, danger}) → Promise<boolean>。左にキャンセル、右に実行
		esc: esc,
		when: when,
		refresh: loadVisible     // JS でタブを切り替えたあとに呼ぶと、見えるようになったタブを読む
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
