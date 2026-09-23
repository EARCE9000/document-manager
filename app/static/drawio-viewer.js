/*!
 * drawio-viewer.js : .drawio を画像化せずブラウザ上で描画する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * `drawio-viewer.html?id=<文書ID>` として本体(index.html)のプレビュー用iframeから読み込まれる。
 * 図のXMLは api/documents/:id/file?source=1 から取得する(画像化を挟まないため、
 * 図の大きさやページ数に左右されない)。描画できなかった場合は親へ知らせ、
 * 親はアップロード時に添付されたプレビュー画像での表示へ切り替える。
 */

(() => {
	const viewer = document.getElementById("viewer");
	const status = document.getElementById("status");

	const notifyParent = (type, message) => {
		if (window.parent === window) return;
		window.parent.postMessage(message == null ? {type} : {type, message}, window.location.origin);
	};

	const fail = (message) => {
		viewer.style.display = "none";
		status.style.display = "block";
		status.textContent = `この図を表示できませんでした(${message})。ダウンロードして draw.io で開いてください。`;
		notifyParent("drawio-viewer-failed", message);
	};

	// プレビュー領域に収まるように縮小する(元より拡大はしない)。
	// 図の大きさはまちまちなので、開いた直後と領域の大きさが変わったときに掛け直す
	const fitToViewer = (graph) => {
		if (graph == null) return;
		graph.maxFitScale = 1;
		graph.fit(8);
		graph.center(true, true);
	};

	const render = (xml) => {
		const holder = document.createElement("div");
		holder.className = "mxgraph";
		holder.setAttribute("data-mxgraph", JSON.stringify({
			xml,
			// pages: 複数ページの .drawio をページ送りで切り替えられるようにする
			toolbar: "pages zoom layers",
			// ツールバーは常に出す(マウスを乗せないと出ないとページ送りに気づけない)
			"toolbar-nohide": true,
			nav: true,
			center: true,
			border: 12,
			// クリックで viewer.diagrams.net の「ライトボックス」を開かせない
			// (開くと図の中身が社外のページへ渡ってしまう)
			lightbox: false,
			// 図の中のリンクは別タブで開く(このiframeの中で遷移させない)
			"target-blank": true
		}));
		viewer.innerHTML = "";
		viewer.appendChild(holder);
		GraphViewer.createViewerForElement(holder, (instance) => {
			fitToViewer(instance.graph);
			// ページを切り替えたときも、そのページに合わせて収め直す
			if (instance.addListener != null) {
				instance.addListener("graphChanged", () => fitToViewer(instance.graph));
			}
			window.addEventListener("resize", () => fitToViewer(instance.graph));
		});
		notifyParent("drawio-viewer-rendered");
	};

	const documentId = new URLSearchParams(window.location.search).get("id");
	if (!documentId) {
		fail("文書IDが指定されていません");
		return;
	}
	if (typeof GraphViewer === "undefined") {
		fail("ビューアを読み込めませんでした");
		return;
	}

	fetch(`./api/documents/${encodeURIComponent(documentId)}/file?source=1`)
		.then((res) => {
			if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
			return res.text();
		})
		.then((xml) => render(xml))
		.catch((err) => fail(err && err.message ? err.message : String(err)));
})();
