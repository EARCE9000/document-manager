/*!
 * mermaid-viewer.js : .mmd / .mermaid をブラウザ上で図として描く
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 図のテキストは**利用者が書いたもの**で、Mermaidのラベルには生のHTMLを書ける。
 * つまり信用できない入力として扱う。守りは二重にしている。
 *
 *   1. securityLevel: "strict"(Mermaid側のサニタイズ)
 *   2. script-src 'self' のCSP(server.jsがレスポンスヘッダーで付ける)
 *
 * ライブラリのサニタイズ任せにはしない。2があるため、1を抜けるものがあっても
 * ここでスクリプトは動かない。このファイルが外部スクリプトなのも同じ理由
 * (インラインを許すとCSPを緩めることになる)。
 */

const viewer = document.getElementById("viewer");
const source = document.getElementById("source");
const status = document.getElementById("status");
const sourceToggle = document.getElementById("sourceToggle");

const documentId = new URLSearchParams(window.location.search).get("id") || "";

const setStatus = (text, failed) => {
	status.textContent = text;
	status.classList.toggle("failed", failed === true);
	status.hidden = text === "";
};

// 端末にあるフォントだけを使う。Webフォントを外部から取りに行かせないため
mermaid.initialize({
	startOnLoad: false,
	securityLevel: "strict",
	fontFamily: '"Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif',
	theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default"
});

sourceToggle.addEventListener("click", () => {
	const showing = !source.hidden;
	source.hidden = showing;
	viewer.hidden = !showing;
	sourceToggle.textContent = showing ? "元のテキストを見る" : "図に戻る";
});

const render = async () => {
	if (documentId === "") {
		setStatus("文書が指定されていません。", true);
		return;
	}
	let text;
	try {
		// ?source=1 は原本をそのまま受け取るためのもの(ダウンロード扱いにはならない)
		const res = await fetch(`./api/documents/${encodeURIComponent(documentId)}/file?source=1`);
		if (res.status !== 200) {
			setStatus(`図を読み込めませんでした(${res.status})。`, true);
			return;
		}
		text = await res.text();
	} catch (err) {
		setStatus("図を読み込めませんでした。時間をおいて開き直してください。", true);
		return;
	}

	// 図にできなくても、書いた人が直せるよう元のテキストは必ず持っておく
	source.textContent = text;

	if (text.trim() === "") {
		setStatus("中身が空です。", true);
		viewer.hidden = true;
		source.hidden = false;
		sourceToggle.hidden = true;
		return;
	}

	try {
		const {svg} = await mermaid.render("mermaidDiagram", text);
		// mermaid.render が返すSVGは securityLevel: "strict" を通ったもの。
		// 加えてこのページ自体が script-src 'self' で配信されている
		viewer.innerHTML = svg;
		setStatus("");
	} catch (err) {
		// 書き間違いは珍しくない。黙って空にせず、原因と元のテキストを見せる
		viewer.hidden = true;
		source.hidden = false;
		sourceToggle.textContent = "図に戻る";
		setStatus(`図として描けませんでした。\n${String(err && err.message ? err.message : err)}`, true);
	}
};

render();
