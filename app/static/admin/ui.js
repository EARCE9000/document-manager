/*!
 * ui.js : どの画面でも使う部品(確認とエラーのモーダル、右下のポップアップ、コピーのボタン、通知の On/Off)
 * Copyright (c) 2026 EARCE.NET (code & design)
 * License: MIT License - see LICENSE
 * Source: https://github.com/EARCE9000/DesignTemplate (published on GitHub)
 *
 * 共通アーキテクチャ(画面 4 章・5 章・6 章)の決まりを、そのまま部品にした物。ほかのスクリプト(admin.js、account.js)の土台。
 *
 *   UI.confirm({title, body, ok, danger}) → Promise<boolean>
 *       確認のモーダル。左にキャンセル、右に実行(2 つは左右の端に離れる)。最初に選ばれているのはキャンセル。
 *       body は HTML(利用者が付けた文字は UI.esc で包む)。Esc・枠の外・キャンセルで閉じる(false)。
 *   UI.error({title, body, detail}) → Promise
 *       エラーのモーダル。題名に、丸に × の印と「エラー」。detail は API が返した文面(文字として出す)。
 *   UI.toast({who, what, target, href, viaApiKey})
 *       右下のポップアップ。1 件につき 1 枚。約 6 秒で消え、マウスを乗せている間は残る。押すと href を開く。
 *       文字は、すべて文字として入れる(HTML として解釈しない)。通知が Off のときは出さない。
 *   UI.copy(button, text)
 *       押したらボタンの文字を「コピーしました」に変え、少しして戻す。
 *   UI.notifyEnabled() / UI.setNotify(on)
 *       通知の On/Off。そのブラウザに保存する。ヘッダーのベルのボタン([data-toggle="notify"])で切り替わる。
 *   UI.esc(text) / UI.when(iso)
 */
(function () {
	"use strict";

	var ICON_X = "<svg class=\"state_icon error\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" +
		"<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"15\" y1=\"9\" x2=\"9\" y2=\"15\"/><line x1=\"9\" y1=\"9\" x2=\"15\" y2=\"15\"/></svg>";
	var ICON_CLOSE = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" +
		"<line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg>";
	var NOTIFY_KEY = "ui.notify";
	var openStack = [];   // 開いているモーダル(重なっていれば、いちばん上だけがキーを受ける)

	function esc(value) {
		return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
			return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c];
		});
	}
	function when(iso) {
		if (!iso) return "―";
		var d = new Date(iso);
		if (isNaN(d.getTime())) return esc(iso);
		var p = function (n) { return (n < 10 ? "0" : "") + n; };
		return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
	}

	// ---------------------------------------------------------------- モーダル(確認・エラー・中身を入れる箱)
	// キーボード: Esc で閉じる。Tab の移動はモーダルの中に閉じる。閉じたら、開く前にいた所へ戻る
	function openModal(opts) {
		var back = document.activeElement;
		var wrap = document.createElement("div");
		wrap.innerHTML = "<input type=\"checkbox\" class=\"modal_toggle\" hidden checked>" +
			"<div class=\"modal_overlay\"><div class=\"modal_backdrop\"></div>" +
			"<div class=\"modal_box" + (opts.wide ? " modal_wide" : "") + "\" role=\"dialog\" aria-modal=\"true\">" +
			"<div class=\"modal_title" + (opts.danger ? " danger" : "") + "\"><span>" + opts.titleHtml + "</span>" +
			"<button type=\"button\" class=\"modal_close\" title=\"閉じる\" aria-label=\"閉じる\" data-close>" + ICON_CLOSE + "</button></div>" +
			"<div class=\"modal_body\">" + opts.body + "</div>" +
			(opts.actions ? "<div class=\"modal_actions\">" + opts.actions + "</div>" : "") +
			"</div></div>";
		document.body.appendChild(wrap);
		var box = wrap.querySelector(".modal_box");
		openStack.push(wrap);
		var closed = false;
		var close = function (answer) {
			if (closed) return;
			closed = true;
			openStack.splice(openStack.indexOf(wrap), 1);
			document.removeEventListener("keydown", onKey, true);
			document.body.removeChild(wrap);
			if (back && back.focus) back.focus();
			if (opts.onClose) opts.onClose(answer);
		};
		var onKey = function (e) {
			if (openStack[openStack.length - 1] !== wrap) return;
			if (e.key === "Escape") { e.preventDefault(); close(false); return; }
			if (e.key !== "Tab") return;
			var items = [].slice.call(box.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])"))
				.filter(function (el) { return !el.disabled && el.offsetParent !== null; });
			if (!items.length) return;
			var first = items[0], last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		};
		document.addEventListener("keydown", onKey, true);
		wrap.querySelector(".modal_backdrop").addEventListener("click", function () { close(false); });
		wrap.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { close(false); }); });
		var focus = wrap.querySelector(opts.focus || "[data-ans=no], [data-ans=ok], [data-close]");
		if (focus) focus.focus();
		return {box: box, close: close};
	}

	function confirm(opts) {
		return new Promise(function (resolve) {
			var m = openModal({
				titleHtml: esc(opts.title), danger: opts.danger, body: opts.body,
				actions: "<button type=\"button\" class=\"cancel_button\" data-ans=\"no\">キャンセル</button>" +
					"<button type=\"button\" class=\"" + (opts.danger ? "caution_button" : "entry_button") + "\" data-ans=\"yes\">" + esc(opts.ok || "実行") + "</button>",
				focus: "[data-ans=no]",   // うっかり Enter を押しても、実行しない
				onClose: function (answer) { resolve(answer === true); }
			});
			m.box.querySelector("[data-ans=yes]").addEventListener("click", function () { m.close(true); });
			m.box.querySelector("[data-ans=no]").addEventListener("click", function () { m.close(false); });
		});
	}

	function error(opts) {
		return new Promise(function (resolve) {
			var m = openModal({
				titleHtml: ICON_X + esc(opts.title || "エラー"), danger: true,
				body: (opts.body || "") + (opts.detail ? "<pre class=\"modal_detail\">" + esc(opts.detail) + "</pre>" : ""),
				actions: "<button type=\"button\" class=\"entry_button\" data-ans=\"ok\">閉じる</button>",
				onClose: function () { resolve(); }
			});
			m.box.querySelector("[data-ans=ok]").addEventListener("click", function () { m.close(true); });
		});
	}

	// ---------------------------------------------------------------- 右下のポップアップ
	function notifyEnabled() {
		try { return localStorage.getItem(NOTIFY_KEY) !== "off"; } catch (e) { return true; }
	}
	function setNotify(on) {
		try { localStorage.setItem(NOTIFY_KEY, on ? "on" : "off"); } catch (e) { /* 保存できなくても、その画面の中では効く */ }
		document.querySelectorAll("[data-toggle=notify]").forEach(function (b) {
			b.classList.toggle("is_off", !on);
			b.setAttribute("title", "通知: " + (on ? "On(押すと Off)" : "Off(押すと On)"));
			b.setAttribute("aria-pressed", on ? "true" : "false");
		});
	}
	function stack() {
		var s = document.querySelector(".toast_stack");
		if (!s) {
			s = document.createElement("div");
			s.className = "toast_stack";
			s.setAttribute("aria-live", "polite");
			document.body.appendChild(s);
		}
		return s;
	}
	function toast(t) {
		if (!notifyEnabled()) return null;
		var el = document.createElement(t.href ? "a" : "div");
		el.className = "toast";
		if (t.href) el.href = t.href;
		var head = document.createElement("div");
		head.className = "toast_head";
		head.textContent = (t.who || "だれか") + (t.viaApiKey ? "(APIキー経由)" : "");
		var body = document.createElement("div");
		body.className = "toast_body";
		body.textContent = (t.target ? "「" + t.target + "」を" : "") + (t.what || "操作");
		el.appendChild(head);
		el.appendChild(body);
		if (t.viaApiKey) el.classList.add("via_api_key");
		stack().appendChild(el);
		var timer = null;
		var start = function () { timer = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, t.ms || 6000); };
		el.addEventListener("mouseenter", function () { clearTimeout(timer); });
		el.addEventListener("mouseleave", start);
		start();
		return el;
	}

	// ---------------------------------------------------------------- コピー
	function copy(button, text) {
		var label = button.getAttribute("data-label") || button.textContent;
		button.setAttribute("data-label", label);
		var done = function (ok) {
			button.textContent = ok ? "コピーしました" : "コピーできなかった";
			setTimeout(function () { button.textContent = label; }, 1600);
		};
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
			return;
		}
		// http の開発環境など、clipboard が使えないとき
		var area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		var ok = false;
		try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
		document.body.removeChild(area);
		done(ok);
	}

	window.UI = {confirm: confirm, error: error, toast: toast, copy: copy, modal: openModal,
		notifyEnabled: notifyEnabled, setNotify: setNotify, esc: esc, when: when};

	var start = function () {
		setNotify(notifyEnabled());
		document.addEventListener("click", function (e) {
			var b = e.target.closest && e.target.closest("[data-toggle=notify]");
			if (!b) return;
			e.preventDefault();
			setNotify(!notifyEnabled());
		});
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
