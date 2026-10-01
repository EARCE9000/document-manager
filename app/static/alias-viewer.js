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

// このページのURLは、下でアドレスバーごと共有リンクのURLに差し替える。
// そうすると相対URLの基準も一緒に動いてしまうので、**動かす前に**アプリのルートを
// 控えておき、以後のURLはすべてここから組み立てる(リバースプロキシ配下でも、
// 実際に開かれているURLを基準に解決される)
const ROOT = new URL("./", window.location.href);
const urlOf = (path) => new URL(path, ROOT).href;

const params = new URLSearchParams(window.location.search);
const alias = params.get("alias") || "";

// 共有リンクの正規のURL。配布用として案内しているのはこの形
const CANONICAL_PATH = new URL(`api/documents/alias/${encodeURIComponent(alias)}/viewer`, ROOT).pathname;

// **アドレスバーに共有リンクのURLを出す。**
// 開いた先のアドレスバーを見て、それを人に貼る人がいる。このページのURL
// (alias-viewer.html?alias=...)を貼られても版をまたいで通じはするが、案内している形と
// 食い違うし、このページの名前を変えたときに過去に貼られたリンクが切れる。
// 開き直すとサーバーがまたこのページへ回してくれるので、差し替えても困らない
if (alias !== "") window.history.replaceState(null, "", CANONICAL_PATH);

/** その文書を、どのページでどう出すか */
const frameFor = (document_) => {
	const ext = extOf(document_.entryFile);
	const id = encodeURIComponent(document_.id);
	if (DRAWIO_EXTS.includes(ext)) {
		return {src: urlOf(`drawio-viewer.html?id=${id}`), sandbox: "allow-scripts allow-same-origin allow-popups"};
	}
	if (MERMAID_EXTS.includes(ext)) {
		return {src: urlOf(`mermaid-viewer.html?id=${id}`), sandbox: "allow-scripts allow-same-origin allow-popups"};
	}
	// それ以外(テキスト・HTML)は中身をそのまま出す。スクリプトは動かさない
	return {src: urlOf(`api/documents/${id}/file`), sandbox: "allow-same-origin"};
};

const content = document.getElementById("content");
const status = document.getElementById("status");
const updateBar = document.getElementById("updateBar");
const updateMessage = document.getElementById("updateMessage");
const reloadButton = document.getElementById("reloadButton");
const dismissButton = document.getElementById("dismissButton");
const authBar = document.getElementById("authBar");
const authLoginButton = document.getElementById("authLoginButton");

// いま出している版。これと指す先が食い違ったら、新しい版が出たということ
let shownDocumentId = null;

const setStatus = (text, failed) => {
	status.textContent = text;
	status.classList.toggle("failed", failed === true);
	status.hidden = text === "";
};

// 未ログイン・期限切れのときは、ログインを挟んで共有リンクへ戻す
// (そこから改めてこのページへ回される)
const goToLogin = () => {
	window.location.replace(urlOf(`login?next=${encodeURIComponent(CANONICAL_PATH)}`));
};

/**
 * Aliasの指す先を引く。
 *
 * 401(未ログイン・期限切れ)と404(無いAlias)は**別物として扱う**。
 * まとめて「見つかりません」にすると、ログインすれば見られる人を追い返してしまう
 */
const resolveAlias = async () => {
	const res = await fetch(urlOf(`api/documents/alias/${encodeURIComponent(alias)}`));
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

/**
 * 読んでいる途中でログインの期限が切れたときの知らせ。
 *
 * **画面は奪わない。** 文書は既に出ており、そのまま読み終えられる。いきなり
 * ログイン画面へ飛ばすと読んでいた位置を失うので、帯で知らせて、押されたときだけ送る。
 * 版の知らせはもう当てにならない(確かめる手段が無い)ので、出ていれば引っ込める
 */
const announceAuthExpired = () => {
	if (!authBar.hidden) return;
	updateBar.hidden = true;
	authBar.hidden = false;
};

const checkForUpdate = async () => {
	if (shownDocumentId == null) return;
	// ここでの失敗は黙って見送る。読んでいる最中に通信の都合で警告を出しても何もできない
	const result = await resolveAlias().catch(() => null);
	if (result?.status === 401) {
		announceAuthExpired();
		return;
	}
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

// ここは利用者が自分で押している。読んでいた位置を失う覚悟の上なので、そのまま送る
authLoginButton.addEventListener("click", () => { goToLogin(); });

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
	const events = new EventSource(urlOf("api/documents/events"));
	events.addEventListener("documents-changed", () => { checkForUpdate(); });

	// 繋ぎ直せないときは、期限切れかどうかを確かめる。
	// EventSourceは繋ぎ直しのたびにerrorを投げるので、確かめるのは一度に一つだけにする
	// (通信が落ちているだけのときは何も言わない。401を見たときだけ知らせる)
	let probing = false;
	events.addEventListener("error", async () => {
		if (probing || !authBar.hidden) return;
		probing = true;
		try {
			const result = await resolveAlias().catch(() => null);
			if (result?.status === 401) announceAuthExpired();
		} finally {
			probing = false;
		}
	});

	// SSEが切れたまま気づかない場合に備えて、画面に戻ってきたときにも確かめる
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") checkForUpdate();
	});
};

start();
