/*!
 * render.js : .drawio の各ページを、紙1枚ずつに描く(pdf-converter の draw.io 用ページ)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 図は ./diagram.xml から読む(server.js がその1件だけを渡す)。描き終えたら
 * window.drawioRendered に {pages: [{width, height, scale}], error} を置く。server.js はそれを待ってから
 * 紙に出す。紙の大きさはページごとに @page(名前付きページ)で決めるので、図の大きさが
 * ページによって違っても、どのページも余白なしで図の大きさぴったりになる。
 */

(() => {
	// PDFの1ページは200インチ(19200px)まで(server.js の MAX_PAGE_PX と揃える)。
	// これより大きい図は、縦横の比を保ったまま収まるまで縮める
	const MAX_PAGE_PX = 19200;
	// 図の周りの余白(px)。アプリのビューアと同じ程度にしておく
	const BORDER = 12;

	// CSPで止めた外部の読み込み(図に貼られた外部の画像など)の数。通信に出る前にブラウザが
	// 止めるので、server.js の遮断の数には入らない。「画像が出ない」の切り分けのために数えて返す。
	// 図に仕込まれたスクリプト(inline)が止められたものは数えない(外へ出ようとしたものではない)
	let blocked = 0;
	document.addEventListener("securitypolicyviolation", (event) => {
		if (/^(https?|wss?|ftp):/i.test(String(event.blockedURI || ""))) blocked++;
	});

	const finish = (result) => {
		window.drawioRendered = {...result, blocked};
	};
	const fail = (message) => finish({pages: [], error: message});

	if (typeof GraphViewer === "undefined" || typeof mxUtils === "undefined") {
		fail("ビューアを読み込めませんでした");
		return;
	}

	const renderPage = (container, root, index) => {
		const holder = document.createElement("div");
		holder.className = "page";
		holder.dataset.index = String(index);
		container.appendChild(holder);
		const viewer = new GraphViewer(holder, root, {
			page: index,
			toolbar: null,
			nav: false,
			lightbox: false,
			center: false,
			resize: true,
			// 既定では、図が画面の幅より大きいと縮めて収める。紙は図に合わせて広げるので縮めない
			"allow-zoom-out": false,
			border: BORDER,
			highlight: "none",
			"target-blank": true
		});
		const graph = viewer.graph;
		const bounds = graph.getGraphBounds();
		// 図の左上は余白の分だけ内側に寄せて描かれるので、右下にも同じだけ余白を付ける
		const width = Math.max(1, Math.ceil(bounds.x + bounds.width + BORDER));
		const height = Math.max(1, Math.ceil(bounds.y + bounds.height + BORDER));
		holder.style.width = `${width}px`;
		holder.style.height = `${height}px`;
		const scale = Math.min(1, MAX_PAGE_PX / Math.max(width, height));
		if (scale < 1) holder.style.zoom = String(scale);
		// 縮めると端数が出る。切り捨てると、はみ出した端数の分だけで白紙のページが1枚増えるので切り上げる
		// (上限ちょうどに縮めた辺が、計算の誤差で上限を超えないようにもしておく)
		const fit = (size) => Math.max(1, Math.min(MAX_PAGE_PX, Math.ceil(size * scale - 0.001)));
		return {width: fit(width), height: fit(height), scale};
	};

	fetch("./diagram.xml")
		.then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		})
		.then(async (xml) => {
			const doc = mxUtils.parseXml(xml);
			const root = doc.documentElement;
			if (root == null || root.nodeName === "parsererror" || doc.getElementsByTagName("parsererror").length > 0) {
				throw new Error("draw.io のファイルとして読めません");
			}
			// <mxfile> なら <diagram> の数だけページがある。<mxGraphModel> だけのファイルは1ページ
			let pageCount = 1;
			if (root.nodeName === "mxfile") {
				pageCount = Array.from(root.childNodes).filter((node) => node.nodeName === "diagram").length;
			} else if (root.nodeName !== "mxGraphModel") {
				throw new Error("draw.io のファイルとして読めません");
			}
			if (pageCount === 0) throw new Error("図のページがありません");

			const container = document.getElementById("pages");
			const pages = [];
			for (let index = 0; index < pageCount; index++) pages.push(renderPage(container, root, index));

			// 紙の大きさを、ページごとに図の大きさにする
			const style = document.createElement("style");
			style.textContent = pages.map((p, index) =>
				`@page drawio${index} { size: ${p.width}px ${p.height}px; margin: 0; }\n`
				+ `.page[data-index="${index}"] { page: drawio${index}; }`).join("\n");
			document.head.appendChild(style);

			// 埋め込みの画像とフォントの読み込みを待ってから知らせる
			await document.fonts.ready;
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			finish({pages, error: null});
		})
		.catch((err) => fail(err && err.message ? err.message : String(err)));
})();
