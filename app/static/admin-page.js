/*!
 * admin-page.js : 管理の画面(admin.html)の Document Manager の部分
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * - 開いたときに、ログインしているか・管理者かを確かめる。管理者なら admin/admin.js(共通の 4 つのタブ)を読み込む
 * - タブの切り替えを ?tab= に残す(再読み込み・リンクで同じタブを開ける)
 * - 独自のタブ(データベース・変換サービス・Miro 連携)を描く。開いたときに初めて読む(開いていないタブのために問い合わせない)
 * - Miro の許可の画面から戻ってきたとき(?miro=connected / ?miro=error&reason=…)、Miro 連携のタブで結果を知らせる
 *
 * 部品(ボタン・表・バッジ・モーダル)はデザインテンプレートの components.css のものを使う。
 */
(function () {
	"use strict";

	// ---------------------------------------------------------------- 道具

	const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]));
	const when = (iso) => {
		if (!iso) return "―";
		const d = new Date(iso);
		if (isNaN(d.getTime())) return String(iso);
		const p = (n) => (n < 10 ? "0" : "") + n;
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};
	const bytes = (n) => {
		if (typeof n !== "number" || !isFinite(n)) return "―";
		const units = ["B", "KB", "MB", "GB", "TB"];
		let i = 0;
		while (n >= 1024 && i < units.length - 1) {
			n /= 1024;
			i += 1;
		}
		return `${i ? n.toFixed(1) : n} ${units[i]}`;
	};
	const runtimeText = (rt) => (rt == null ? "この相手は返しません(相手を更新すると出る)"
		: [rt.node && `Node.js ${rt.node}`, rt.openssl && `OpenSSL ${rt.openssl}`, rt.os, rt.arch].filter(Boolean).join(" / "));
	const badge = (kind, text) => `<span class="status_badge ${kind}">${esc(text)}</span>`;
	const info = (items) => `<div class="info_grid">${items.map(([label, value]) =>
		`<div><div class="info_label">${esc(label)}</div><div class="info_value">${value}</div></div>`).join("")}</div>`;
	const table = (head, rows, empty) => `<div class="data_table_wrap"><table class="data_table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`
		+ `<tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="runtime_text">${esc(empty || "なし")}</td></tr>`}</tbody></table></div>`;
	const note = (html) => `<div class="admin_text">${html}</div>`;
	const loading = (text) => `<div class="admin_text runtime_text">${esc(text)}</div>`;

	/** ログインの画面へ。戻り先に、いま開いている管理の画面を渡す */
	const loginUrl = () => `./login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;

	/** WebAPI を呼ぶ。401 はログインの画面へ戻す(画面の中の認証切れは、必ずログインの画面へ)。失敗は Error(message は理由) */
	const api = async (path, {method = "GET", body} = {}) => {
		const res = await fetch(path, {
			method,
			credentials: "same-origin",
			headers: body === undefined ? {Accept: "application/json"} : {"Content-Type": "application/json", Accept: "application/json"},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (res.status === 401) {
			window.location.href = loginUrl();
			throw new Error("ログインし直してください");
		}
		const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {status: res.status, data});
		return data;
	};

	// 共通のスクリプト(admin/admin.js)が読み込まれたら、その部品(AdminUI)を使う。読み込むのは、管理者だと確かめた後
	let adminUiLoaded;
	const adminUiReady = new Promise((resolve) => { adminUiLoaded = resolve; });

	/** 確認のモーダル(共通のスクリプトの AdminUI.confirm。左にキャンセル、右に実行)。押すまで待つ */
	const confirmModal = async (options) => {
		await adminUiReady;
		return window.AdminUI.confirm(options);
	};
	const flash = (box, ok, text) => {
		box.innerHTML = `<div class="${ok ? "msg_success" : "msg_error"} admin_flash">${esc(text)}</div>`;
	};

	// ---------------------------------------------------------------- データベース

	const dbIntegrityResult = document.getElementById("dbIntegrityResult");
	const reconcileResult = document.getElementById("reconcileResult");

	const renderIntegrity = (result, label) => {
		if (result == null) {
			dbIntegrityResult.innerHTML = `<div class="result_meta">${badge("unknown", "未確認")}<span>まだ確認していない。上のボタンで実行する。</span></div>`;
			return;
		}
		if (result.supported === false) {
			dbIntegrityResult.innerHTML = `<div class="result_meta">${badge("unknown", "対象外")}<span>${esc(result.backend || "")} では、整合性の担保はデータベースの側の責務。</span></div>`;
			return;
		}
		const state = result.healthy ? badge("completed", "問題なし") : badge("failed", result.checkFailed ? "検査できない(破損の可能性)" : "問題あり");
		dbIntegrityResult.innerHTML = `<div class="result_meta">${state}<span>${esc(label || "")}</span></div>`
			+ info([
				["確認の方法", esc(result.modeLabel || result.mode || "―")],
				["確認の日時", esc(when(result.checkedAt))],
				["掛かった時間", `${esc(result.durationMs ?? "―")} ミリ秒`],
				["問題の件数", esc(result.problemCount ?? 0)]
			])
			+ (Array.isArray(result.problems) && result.problems.length > 0
				? table(["見つかった問題(先頭だけ。全部はサーバーのログ)"], result.problems.map((p) => `<tr class="row_failed"><td class="version_text">${esc(p)}</td></tr>`))
					+ note("バックアップからの復旧を検討する。")
				: "");
	};

	const loadDatabaseTab = async () => {
		dbIntegrityResult.innerHTML = loading("読み込み中…");
		try {
			const status = await api("./api/server-status");
			renderIntegrity(status.integrity, status.integrity ? "前回の確認の結果" : "");
		} catch (err) {
			dbIntegrityResult.innerHTML = `<div class="msg_error admin_flash">取得失敗: ${esc(err.message)}</div>`;
		}
	};

	const runIntegrity = async (mode) => {
		dbIntegrityResult.innerHTML = loading("確認中。終わるまで、ほかの操作は応答しない…");
		try {
			renderIntegrity(await api(`./api/db-integrity?mode=${encodeURIComponent(mode)}`), "いま確認した結果");
		} catch (err) {
			dbIntegrityResult.innerHTML = `<div class="msg_error admin_flash">確認失敗: ${esc(err.message)}</div>`;
		}
	};
	document.getElementById("dbIntegrityQuickButton").addEventListener("click", () => runIntegrity("quick"));
	document.getElementById("dbIntegrityFullButton").addEventListener("click", async () => {
		// 厳密な検査は同期的に走り、その間サーバー全体が止まる。実行の前に必ず知らせる
		const yes = await confirmModal({title: "厳密な確認", ok: "確認する", danger: true,
			body: "索引と表の整合まで検査する。<b>検査の間は、サーバーのほかの処理が止まる</b>(データが多いほど長く掛かる)。業務時間の外での実行を勧める。"});
		if (yes) runIntegrity("full");
	});

	const renderReconcile = (result) => {
		if (result.supported === false) {
			reconcileResult.innerHTML = `<div class="result_meta">${badge("unknown", "対象外")}<span>この置き場(${esc(result.backend || "")})では使えない。ローカルの置き場だけ。</span></div>`;
			return;
		}
		// 置き場に届いていない疑いがあるときは、食い違いとして扱わない
		if (result.unavailable) {
			reconcileResult.innerHTML = `<div class="result_meta">${badge("failed", "照合を中止")}<span>${esc(result.reason || "")}</span></div>`;
			return;
		}
		const orphans = result.orphanFiles || [];
		const missing = result.missingFiles || [];
		const summary = orphans.length + missing.length === 0 ? badge("completed", "食い違いなし") : badge("failed", `食い違い ${orphans.length + missing.length} 件`);
		reconcileResult.innerHTML = `<div class="result_meta">${summary}</div>`
			+ info([
				["DB の文書", `${esc(result.documentCount ?? "―")} 件`],
				["実ファイルの数", `${esc(result.directoryCount ?? "―")} 件`],
				["照合の日時", esc(when(result.scannedAt))]
			])
			+ (result.truncated ? note(`件数が多いため、先頭 ${esc(result.maxEntries)} 件までを調べた。`) : "")
			+ `<div class="panel_section_title admin_sub">実ファイルだけある(${orphans.length} 件)</div>`
			+ table(["ファイル名", "更新の日時", "大きさ", "操作"], orphans.map((item) => `<tr>`
				+ `<td title="${esc(item.id)}">${esc(item.entryFile || `(特定できない: ${(item.files || []).join(", ")})`)}</td>`
				+ `<td style="white-space:nowrap">${esc(item.modifiedAt ? when(item.modifiedAt) : "―")}</td><td>${esc(bytes(item.sizeBytes))}</td>`
				+ `<td>${item.restorable ? `<button type="button" class="search_btn reconcileRestoreButton" data-id="${esc(item.id)}">登録し直す</button>` : ""}</td></tr>`), "ない")
			+ `<div class="panel_section_title admin_sub">DB にあるのにファイルが無い(${missing.length} 件)</div>`
			+ note("記録は残したままにする。置き場の状態を確かめる。")
			+ table(["ファイル名", "状態"], missing.map((item) => `<tr><td title="${esc(item.id)}">${esc(item.entryFile)}</td><td>${item.archived ? "アーカイブ済み" : "現役"}</td></tr>`), "ない");

		reconcileResult.querySelectorAll(".reconcileRestoreButton").forEach((button) => {
			button.addEventListener("click", async () => {
				const yes = await confirmModal({title: "登録し直す", ok: "登録し直す",
					body: "この文書を、アーカイブ済みとして登録し直す。<b>タグ・メモ・版のつなぎは戻らない</b>(ファイルから作り直せないため)。"});
				if (!yes) return;
				button.disabled = true;
				button.textContent = "実行中…";
				try {
					await api("./api/storage-reconcile/restore", {method: "POST", body: {id: button.dataset.id}});
				} catch (err) {
					await confirmModal({title: "登録し直せなかった", ok: "閉じる", body: esc(err.message)});
				}
				runReconcile();
			});
		});
	};
	const runReconcile = async () => {
		reconcileResult.innerHTML = loading("照合中…");
		try {
			renderReconcile(await api("./api/storage-reconcile"));
		} catch (err) {
			reconcileResult.innerHTML = `<div class="msg_error admin_flash">照合失敗: ${esc(err.message)}</div>`;
		}
	};
	document.getElementById("reconcileScanButton").addEventListener("click", () => runReconcile());

	// ---------------------------------------------------------------- 変換サービス

	const convertHealthResult = document.getElementById("convertHealthResult");
	const convertFailedWrap = document.getElementById("convertFailedWrap");
	const pdfHealthResult = document.getElementById("pdfHealthResult");

	// 「未設定」と「落ちている」は別物なので、表示でも分ける
	const renderHealth = (box, health, {envName, notSetText, downText, rows}) => {
		if (!health.enabled) {
			box.innerHTML = `<div class="result_meta">${badge("unknown", "Not set")}<span>${esc(notSetText)}(${esc(envName)} が未設定)</span></div>`;
			return;
		}
		if (!health.reachable) {
			box.innerHTML = `<div class="result_meta">${badge("failed", "Error")}<span>${esc(downText)}</span></div>`;
			return;
		}
		box.innerHTML = `<div class="result_meta">${badge("completed", "Connected")}<span>確認の日時 ${esc(when(health.checkedAt))}</span></div>` + info(rows(health));
	};

	const loadConvertFailed = async () => {
		convertFailedWrap.innerHTML = loading("読み込み中…");
		try {
			const documents = await api("./api/documents?renderStatus=failed");
			convertFailedWrap.innerHTML = table(["ファイル名", "登録の日時", "理由", "操作"], documents.map((doc) => `<tr>`
				+ `<td title="${esc(doc.entryFile)}">${esc(doc.entryFile)}</td><td style="white-space:nowrap">${esc(when(doc.modified))}</td>`
				+ `<td>${esc(doc.renderError || "―")}</td>`
				+ `<td><button type="button" class="search_btn convertRetryButton" data-id="${esc(doc.id)}">やり直す</button></td></tr>`), "変換に失敗している文書はない");
			convertFailedWrap.querySelectorAll(".convertRetryButton").forEach((button) => {
				button.addEventListener("click", async () => {
					button.disabled = true;
					button.textContent = "実行中…";
					await api(`./api/documents/${encodeURIComponent(button.dataset.id)}/render/retry`, {method: "POST"}).catch(() => {});
					// 成否にかかわらず一覧を取り直す(成功していれば行が消える)
					loadConvertFailed();
				});
			});
		} catch (err) {
			convertFailedWrap.innerHTML = `<div class="msg_error admin_flash">取得失敗: ${esc(err.message)}</div>`;
		}
	};

	const loadConvertTab = async () => {
		convertHealthResult.innerHTML = loading("確認中…");
		pdfHealthResult.innerHTML = loading("確認中…");
		loadConvertFailed();
		const [office, pdf] = await Promise.allSettled([api("./api/office-render/health"), api("./api/html-pdf/health")]);
		if (office.status === "fulfilled") {
			renderHealth(convertHealthResult, office.value, {
				envName: "OFFICE_RENDER_URL",
				notSetText: "変換サービスを使わない構成。Office の文書は概要のプレビューだけで扱う",
				downText: "設定はあるが、応答がない。変換サービスのコンテナが動いているか確かめる。この間に登録された Office の文書は、下の一覧に失敗として残る",
				rows: (h) => [["LibreOffice", `<span class="version_text">${esc(h.libreOffice || "―")}</span>`], ["土台", esc(runtimeText(h.runtime))],
					["受け付ける上限", esc(bytes(h.maxBytes))], ["変換の打ち切り", `${esc(h.timeoutSeconds ?? "―")} 秒`]]
			});
		} else {
			convertHealthResult.innerHTML = `<div class="msg_error admin_flash">取得失敗: ${esc(office.reason.message)}</div>`;
		}
		if (pdf.status === "fulfilled") {
			renderHealth(pdfHealthResult, pdf.value, {
				envName: "HTML_PDF_URL",
				notSetText: "変換サービスを使わない構成。「PDF でダウンロード」は画面に出ない",
				downText: "設定はあるが、応答がない。変換サービス(pdf-converter)のコンテナが動いているか確かめる。この間は「PDF でダウンロード」が失敗する",
				rows: (h) => [["Chromium", `<span class="version_text">${esc(h.chromium || "―")}</span>`], ["土台", esc(runtimeText(h.runtime))],
					["受け付ける上限", esc(bytes(h.maxBytes))], ["変換の打ち切り", `${esc(h.timeoutSeconds ?? "―")} 秒`],
					["draw.io", `<span id="pdfHealthDrawio">${(h.formats || []).includes("drawio") ? "対応"
						: "未対応(イメージが古いか、DRAWIO_DISABLED で止めている。draw.io の文書で「PDF でダウンロード」を押すとエラーになる)"}</span>`]]
			});
		} else {
			pdfHealthResult.innerHTML = `<div class="msg_error admin_flash">取得失敗: ${esc(pdf.reason.message)}</div>`;
		}
	};
	document.getElementById("convertHealthRefreshButton").addEventListener("click", (ev) => {
		ev.preventDefault();
		loadConvertTab();
	});

	// ---------------------------------------------------------------- Miro 連携

	const miroConnectionResult = document.getElementById("miroConnectionResult");
	const miroFlash = document.getElementById("miroFlash");
	// 許可の画面から戻ってきたときの結果(?miro=connected / ?miro=error&reason=…)
	const MIRO_ERROR_REASONS = {
		denied: "Miro で許可されなかったため、連携しなかった。",
		state: "連携の手続きの途中で期限が切れたか、別のブラウザで開かれた。もう一度「Miro と連携」からやり直す。",
		code: "Miro から必要な情報が返らなかった。もう一度やり直す。",
		exchange: "Miro と連携できなかった。Miro のアプリに登録した戻り先の URL が、下に出しているものと同じか確かめる。"
	};
	const showMiroFlash = (ok, message) => {
		miroFlash.hidden = false;
		miroFlash.className = ok ? "msg_success admin_flash" : "msg_error admin_flash";
		miroFlash.textContent = message;
	};
	const code = (text) => `<span class="version_text">${esc(text)}</span>`;

	const renderMiroBoards = (boards, currentId) => {
		const list = document.getElementById("miroBoardList");
		list.innerHTML = table(["ボード", "操作"], boards.map((board) => `<tr><td>${esc(board.name || "(名前なし)")}</td><td>${board.id === currentId
			? badge("completed", "貼り先")
			: `<button type="button" class="search_btn" data-board-id="${esc(board.id)}">このボードにする</button>`}</td></tr>`),
		"ボードが見つからない(連携したチームのボードだけが出る)");
		list.querySelectorAll("button[data-board-id]").forEach((button) => {
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					await api("./api/miro/settings", {method: "PUT", body: {boardId: button.dataset.boardId}});
					loadMiroTab();
				} catch (err) {
					showMiroFlash(false, err.message || "ボードを設定できなかった");
					button.disabled = false;
				}
			});
		});
	};

	const searchMiroBoards = async (currentId) => {
		const list = document.getElementById("miroBoardList");
		const query = document.getElementById("miroBoardSearchInput").value.trim();
		list.innerHTML = loading("探している…");
		try {
			const body = await api(`./api/miro/boards${query ? `?q=${encodeURIComponent(query)}` : ""}`);
			renderMiroBoards(body.boards || [], currentId);
		} catch (err) {
			list.innerHTML = `<div class="msg_error admin_flash">${esc(err.message || "ボードの一覧を取得できなかった")}</div>`;
			if (err.data?.needsReconnect) loadMiroTab();
		}
	};

	/** アプリの値の節。環境変数で決まっていれば表示だけ、そうでなければ入力・変更・消去ができる */
	const renderMiroCredentials = (status) => {
		const creds = status.credentials || {};
		const title = "<div class=\"panel_section_title\">Miro のアプリ</div>";
		if (creds.source === "env") {
			return title + note(`環境変数(MIRO_CLIENT_ID / MIRO_CLIENT_SECRET)で設定している。画面からは変えられない。クライアントID: ${code(creds.clientId || "")}`);
		}
		const form = `<div class="admin_form" id="miroCredentialForm"${creds.source === "settings" ? " hidden" : ""}>`
			+ "<div class=\"form_row\"><div class=\"form_field\"><div class=\"form_label\">クライアントID</div><div class=\"form_value\">"
			+ `<input type="text" class="search_input" id="miroClientIdInput" autocomplete="off" inputmode="numeric" value="${esc(creds.clientId || "")}"></div></div></div>`
			+ "<div class=\"form_row\"><div class=\"form_field\"><div class=\"form_label\">クライアントシークレット</div><div class=\"form_value\">"
			+ "<input type=\"password\" class=\"search_input\" id=\"miroClientSecretInput\" autocomplete=\"new-password\" placeholder=\"貼り付け(保存の後は表示しない)\"></div></div></div>"
			+ "<div class=\"admin_actions\"><button type=\"button\" id=\"miroCredentialSaveButton\" class=\"search_btn\">保存</button></div>"
			+ "</div>";
		if (creds.source === "settings") {
			return title + note(`管理の画面で設定済み(${esc(creds.updatedBy || "―")}、${esc(when(creds.updatedAt))})。クライアントID: ${code(creds.clientId || "")}。シークレットは表示しない。`)
				+ "<div class=\"admin_actions\"><button type=\"button\" id=\"miroCredentialEditButton\" class=\"search_btn\">値を変える</button>"
				+ "<button type=\"button\" id=\"miroCredentialClearButton\" class=\"search_btn\">値を消す</button></div>" + form;
		}
		return title + note("まだ設定していない。Miro の開発者ハブでアプリを作り、その値を入れる。")
			+ "<ol class=\"admin_steps\">"
			+ "<li>Miro の右上のアイコン →「開発者ハブ」→「作成アプリ」→「新しいアプリを作成する」(開発者チームを選び、「ユーザー認証トークンの有効期限を失効させる」にチェック)</li>"
			+ `<li>アプリの設定で「OAuth2.0 用のリダイレクト URI」に ${code(status.redirectUri || "")} を足し、「アクセス権限」で boards:read と boards:write にチェック</li>`
			+ "<li>「アプリの認証情報」のクライアントIDとシークレットを、下に貼って保存(クラウドで動かすときは、秘密の情報の保管庫から環境変数 MIRO_CLIENT_ID / MIRO_CLIENT_SECRET で渡す方法もある)</li>"
			+ "</ol>" + form;
	};

	const bindMiroCredentialForm = () => {
		const save = document.getElementById("miroCredentialSaveButton");
		if (save != null) {
			save.addEventListener("click", async () => {
				save.disabled = true;
				const clientId = document.getElementById("miroClientIdInput").value;
				const clientSecret = document.getElementById("miroClientSecretInput").value;
				// 入れた値は、保存できてもできなくても画面に残さない
				document.getElementById("miroClientSecretInput").value = "";
				try {
					await api("./api/miro/credentials", {method: "PUT", body: {clientId, clientSecret}});
					showMiroFlash(true, "Miro のアプリの値を保存した。続けて「Miro と連携」を押す。");
					loadMiroTab();
				} catch (err) {
					showMiroFlash(false, err.message || "保存できなかった");
					save.disabled = false;
				}
			});
		}
		const edit = document.getElementById("miroCredentialEditButton");
		if (edit != null) {
			edit.addEventListener("click", () => {
				document.getElementById("miroCredentialForm").hidden = false;
				edit.disabled = true;
			});
		}
		const clear = document.getElementById("miroCredentialClearButton");
		if (clear != null) {
			clear.addEventListener("click", async () => {
				const yes = await confirmModal({title: "Miro のアプリの値を消す", ok: "消す", danger: true,
					body: "Miro との連携も解除する。ボードに出してある資料は Miro に残る。"});
				if (!yes) return;
				await api("./api/miro/credentials", {method: "DELETE"}).catch(() => {});
				miroFlash.hidden = true;
				loadMiroTab();
			});
		}
	};

	const renderMiroStatus = (status) => {
		const credentials = renderMiroCredentials(status);
		const redirect = note(`Miro のアプリ(開発者ハブ)に登録する戻り先: ${code(status.redirectUri || "")}`);
		if (!status.configured) {
			miroConnectionResult.innerHTML = `<div class="result_meta">${badge("unknown", "Not set")}<span>アプリの値が未設定</span></div>` + credentials;
			bindMiroCredentialForm();
			return;
		}
		if (!status.connected) {
			miroConnectionResult.innerHTML = `<div class="result_meta">${badge("unknown", "未連携")}</div>`
				+ note("「Miro と連携」を押すと Miro の許可の画面へ移る。<b>資料を出すチーム</b>を選んで許可する。このアカウントの権限で、選んだボードへ資料を出し入れする。")
				+ "<div class=\"admin_actions\"><a class=\"entry_button admin_button_link\" id=\"miroConnectButton\" href=\"./api/miro/connect\">Miro と連携</a></div>"
				+ redirect + credentials;
			bindMiroCredentialForm();
			return;
		}
		const board = status.board;
		miroConnectionResult.innerHTML = `<div class="result_meta">${status.usable ? badge("completed", "Connected") : badge("failed", "連携し直しが必要")}</div>`
			+ (status.usable ? "" : note(esc(status.lastError || "連携を読み取れない。連携し直す。")))
			+ info([
				["チーム", esc(status.team?.name || status.team?.id || "―")],
				["Miro のアカウント", esc(status.miroUser?.name || "―")],
				["連携した人", `${esc(status.connectedBy || "―")}(${esc(when(status.connectedAt))})`],
				["権限", esc((status.scopes || []).join(", ") || "―")],
				["貼り先のボード", `<span id="miroBoardName">${board
					? esc(board.name || board.id) + (board.url ? ` <a href="${esc(board.url)}" target="_blank" rel="noopener noreferrer">Miro で開く</a>` : "")
					: badge("failed", "未選択") + "(下から選ぶ)"}</span>`]
			])
			+ "<div class=\"panel_section_title\">貼り先のボード</div>"
			+ note("連携したチームのボードから選ぶ。資料はこのボード 1 枚に並べる。")
			+ "<div class=\"filter_panel\"><div class=\"search_form\"><span class=\"filter_label\">ボードの名前</span>"
			+ "<input type=\"search\" class=\"search_input\" id=\"miroBoardSearchInput\" placeholder=\"名前で絞り込む\" autocomplete=\"off\">"
			+ "<button type=\"button\" id=\"miroBoardSearchButton\" class=\"search_btn\">ボードを探す</button></div></div>"
			+ "<div id=\"miroBoardList\"></div>"
			+ "<div class=\"admin_actions\"><a class=\"search_btn admin_button_link\" id=\"miroReconnectButton\" href=\"./api/miro/connect\">連携し直す</a>"
			+ "<button type=\"button\" id=\"miroDisconnectButton\" class=\"search_btn\">連携を解除</button></div>"
			+ redirect + credentials;
		bindMiroCredentialForm();
		const search = () => searchMiroBoards(board?.id);
		document.getElementById("miroBoardSearchButton").addEventListener("click", search);
		document.getElementById("miroBoardSearchInput").addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") search();
		});
		document.getElementById("miroDisconnectButton").addEventListener("click", async () => {
			const yes = await confirmModal({title: "Miro との連携の解除", ok: "解除する", danger: true,
				body: "ボードに出してある資料は Miro に残るが、新しい版の反映や出し入れはできなくなる。"});
			if (!yes) return;
			await api("./api/miro/connection", {method: "DELETE"}).catch(() => {});
			miroFlash.hidden = true;
			loadMiroTab();
		});
		if (status.usable) search();
	};

	const loadMiroTab = async () => {
		miroConnectionResult.innerHTML = loading("確認中…");
		try {
			renderMiroStatus(await api("./api/miro/status"));
		} catch (err) {
			miroConnectionResult.innerHTML = `<div class="msg_error admin_flash">取得失敗: ${esc(err.message)}</div>`;
		}
	};

	// ---------------------------------------------------------------- タブ・入口

	// 独自のタブは、開いたときに初めて読む(データベースの照合のような重い物は、ボタンで始める)
	const TAB_LOADERS = {database: loadDatabaseTab, convert: loadConvertTab, miro: loadMiroTab};
	const loaded = new Set();
	const openTab = (key) => {
		if (TAB_LOADERS[key] && !loaded.has(key)) {
			loaded.add(key);
			TAB_LOADERS[key]();
		}
	};
	const radios = Array.from(document.querySelectorAll("input[name=admin_tab]"));
	radios.forEach((radio) => radio.addEventListener("change", () => {
		if (!radio.checked) return;
		// 再読み込み・リンクで同じタブを開けるように、URL に残す
		const params = new URLSearchParams(window.location.search);
		params.set("tab", radio.value);
		window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
		openTab(radio.value);
	}));

	const start = async () => {
		const gate = document.getElementById("adminGate");
		let auth;
		try {
			const res = await fetch("./api/check_access_token", {credentials: "same-origin"});
			if (res.status === 401) {
				window.location.href = loginUrl();
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			auth = await res.json();
		} catch (err) {
			gate.hidden = false;
			gate.textContent = `ログインの状態を確かめられなかった(${err.message})。少し待って、開き直す。`;
			return;
		}
		document.getElementById("adminUser").textContent = auth.user_identifier || "";
		if (!auth.isAdmin) {
			gate.hidden = false;
			gate.innerHTML = "管理の画面は、管理者だけが使える。<a href=\"./\">文書一覧へ戻る</a>";
			return;
		}

		// Miro の許可の画面から戻ってきた: Miro 連携のタブを開いて、結果を知らせる。
		// 再読み込みで同じ知らせが出続けないよう、URL からは消す
		const params = new URLSearchParams(window.location.search);
		const miroResult = params.get("miro");
		const miroReason = params.get("reason");
		if (miroResult != null) {
			params.delete("miro");
			params.delete("reason");
			params.set("tab", "miro");
			window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
		}
		const initial = radios.find((radio) => radio.value === params.get("tab")) || radios[0];
		initial.checked = true;
		document.getElementById("adminBody").hidden = false;

		// 認証が切れたら、この画面へ戻ってこられるように、ログインの画面に戻り先を渡す
		document.querySelectorAll("[data-login]").forEach((node) => node.setAttribute("data-login", loginUrl()));
		const script = document.createElement("script");
		script.src = "./admin/admin.js";
		script.addEventListener("load", () => {
			adminUiLoaded();
			// 共通のタブは、見えているタブだけを読む。?tab= でタブを JS から選んだので、選んだ後に読み直させる
			// (ラジオを JS で選んだだけでは change が起きない)
			window.AdminUI.refresh();
		});
		document.body.appendChild(script);

		openTab(initial.value);
		if (miroResult === "connected") showMiroFlash(true, "Miro と連携した。資料を出すボードを選ぶ。");
		else if (miroResult != null) showMiroFlash(false, MIRO_ERROR_REASONS[miroReason] || "Miro と連携できなかった。");
	};
	start();
})();
