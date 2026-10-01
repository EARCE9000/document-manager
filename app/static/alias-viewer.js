/*!
 * alias-viewer.js : 共有リンクで開いた文書を、新しい版が出たら知らせる
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Aliasは「いまの版」を指すが、**開いたままのページは古い版のまま**になる。
 * 読んでいる最中に差し替えると驚くので、**勝手には切り替えない**。
 * 上に帯を出して、押されたときだけ入れ替える。
 *
 * 文書の中身は信用できない入力なので、iframeから allow-scripts を外している
 * (配信側もCSPで止めている)。このファイルが外部スクリプトなのは、このページ自身を
 * script-src 'self' で配信しているため。
 *
 * ただし .drawio と .mmd は**専用のビューアで描く**ため、そこだけはスクリプトを許す。
 * ビューアのページ自身が script-src 'self' のCSPで配信されており、図に仕込まれたものは
 * 動かない(本体の画面が同じことをしている)。
 */

const DRAWIO_EXTS = ["drawio"];
const MERMAID_EXTS = ["mmd", "mermaid"];
const extOf = (name) => String(name || "").split(".").pop().toLowerCase();

/** その文書を、どのページでどう出すか */
const frameFor = (document_) => {
	const ext = extOf(document_.entryFile);
	const id = encodeURIComponent(document_.id);
	if (DRAWIO_EXTS.includes(ext)) {
		return {src: `./drawio-viewer.html?id=${id}`, sandbox: "allow-scripts allow-same-origin allow-popups"};
	}
	if (MERMAID_EXTS.includes(ext)) {
		return {src: `./mermaid-viewer.html?id=${id}`, sandbox: "allow-scripts allow-same-origin allow-popups"};
	}
	// それ以外(テキスト・HTML)は中身をそのまま出す。スクリプトは動かさない
	return {src: `./api/documents/${id}/file`, sandbox: "allow-same-origin"};
};

const params = new URLSearchParams(window.location.search);
const alias = params.get("alias") || "";

const content = document.getElementById("content");
const status = document.getElementById("status");
const updateBar = document.getElementById("updateBar");
const updateMessage = document.getElementById("updateMessage");
const reloadButton = document.getElementById("reloadButton");
const dismissButton = document.getElementById("dismissButton");

// いま出している版。これと指す先が食い違ったら、新しい版が出たということ
let shownDocumentId = null;

const setStatus = (text, failed) => {
	status.textContent = text;
	status.classList.toggle("failed", failed === true);
	status.hidden = text === "";
};

// 共有リンクの正規のURL。このページ自身のURLがアドレスバーに出るので、それを
// そのまま人に渡されることがある。渡された側が未ログインでも行き止まりにならないよう、
// ログインを挟んでここへ戻す(そこから改めてこのページへ回される)
const CANONICAL_PATH = new URL(`./api/documents/alias/${encodeURIComponent(alias)}/viewer`, window.location.href).pathname;

const goToLogin = () => {
	window.location.replace(`./login?next=${encodeURIComponent(CANONICAL_PATH)}`);
};

/**
 * Aliasの指す先を引く。
 *
 * 401(未ログイン・期限切れ)と404(無いAlias)は**別物として扱う**。
 * まとめて「見つかりません」にすると、ログインすれば見られる人を追い返してしまう
 */
const resolveAlias = async () => {
	const res = await fetch(`./api/documents/alias/${encodeURIComponent(alias)}`);
	return {status: res.status, document: res.status === 200 ? await res.json() : null};
};

const show = (document_) => {
	shownDocumentId = document_.id;
	updateBar.hidden = true;
	const frame = frameFor(document_);
	content.setAttribute("sandbox", frame.sandbox);
	content.src = frame.src;
	window.document.title = `${document_.entryFile} - Document Manager`;
	setStatus("");
};

const announce = (document_) => {
	// いつ・誰が上げたかまで出す。押すかどうかの判断材料になる
	const when = new Date(document_.modified).toLocaleString("ja-JP");
	const who = document_.uploadedBy ? ` ${document_.uploadedBy}` : "";
	updateMessage.textContent = `新しい版があります(${when}${who})。`;
	updateBar.hidden = false;
};

const checkForUpdate = async () => {
	if (shownDocumentId == null) return;
	// ここでの失敗は黙って見送る。読んでいる最中に通信の都合で警告を出しても何もできない
	const result = await resolveAlias().catch(() => null);
	if (result?.document == null || result.document.id === shownDocumentId) return;
	announce(result.document);
};

reloadButton.addEventListener("click", async () => {
	const result = await resolveAlias().catch(() => null);
	// 読んでいる間にログインの期限が切れることがある。そのときは読み直させる
	if (result?.status === 401) {
		goToLogin();
		return;
	}
	if (result?.document == null) {
		setStatus("最新を読み込めませんでした。開き直してください。", true);
		return;
	}
	show(result.document);
});

// 「あとで」も選べるようにする。帯が消せないと、読んでいる間ずっと場所を取る
dismissButton.addEventListener("click", () => { updateBar.hidden = true; });

const start = async () => {
	if (alias === "") {
		setStatus("共有リンクが指定されていません。", true);
		return;
	}
	const current = await resolveAlias().catch(() => null);
	if (current == null) {
		setStatus("サーバーに接続できませんでした。時間をおいて開き直してください。", true);
		return;
	}
	if (current.status === 401) {
		goToLogin();
		return;
	}
	if (current.document == null) {
		setStatus("この共有リンクは見つかりませんでした。", true);
		return;
	}
	show(current.document);

	// 他の人が新しい版を上げたら知らせる。
	// 受け取るのは「何か変わった」だけなので、そのたびに指す先を引き直して確かめる
	const events = new EventSource("./api/documents/events");
	events.addEventListener("documents-changed", () => { checkForUpdate(); });

	// SSEが切れたまま気づかない場合に備えて、画面に戻ってきたときにも確かめる
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") checkForUpdate();
	});
};

start();
