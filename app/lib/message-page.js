/*!
 * message-page.js : ログインに失敗したときなどに出す、簡単な知らせのページ
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 見た目は画面(index.html)のカードとそろえる。ほかの画面と同じく、いちばん下にフッター
 * (左に著作権、右に版)を置く。UI の標準(webservice-ui.html 1.1)で、ログインの前の画面・
 * エラーの画面にも置くと決めているため。版はビルドしたときの値で、取れなければ「Ver. -」と出す。
 * このページはスクリプトを使わず、サーバーで年と版を埋めて返す。
 */

const ICONS = {
	denied: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
	error: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
};

/** フッターの版の表記。版が無いとき(ビルドせずに動かしているとき)は「Ver. -」 */
const footerVersionText = (version) => `Ver. ${version || "-"}`;

/**
 * 知らせのページの HTML。title・message・retryLabel はサーバーの中で決めた文(利用者の入力を入れない)。
 * @param {{icon: "denied"|"error", iconColor: string, title: string, message: string, retryHref?: string, retryLabel?: string, version?: string|null, year?: number}} options
 */
const messagePageHtml = ({icon, iconColor, title, message, retryHref, retryLabel, version = null, year = new Date().getFullYear()}) => `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${title} - Document Manager</title>
<link rel="icon" type="image/svg+xml" href="./logo.svg">
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; background: #f4f5f7; color: #24292f; }
	body { display: flex; flex-direction: column; }
	main { flex: 1; display: flex; align-items: center; justify-content: center; }
	.messageCard { background: #fff; border-radius: 10px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1); padding: 40px 36px; max-width: 380px; width: 90%; text-align: center; }
	.messageIcon { width: 40px; height: 40px; margin: 0 auto 16px; color: ${iconColor}; display: block; }
	h1 { font-size: 1.05em; margin: 0 0 10px; }
	p { font-size: 0.9em; color: #555; line-height: 1.6; margin: 0; }
	a.button { display: inline-block; background: #1a56db; color: #fff; text-decoration: none; padding: 8px 22px; border-radius: 6px; font-size: 0.9em; margin-top: 20px; }
	a.button:hover { background: #1544ad; }
	footer { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; padding: 5px 16px; background: #16160e; color: #7a8390; font-size: 0.72em; }
</style>
</head>
<body>
	<main>
		<div class="messageCard">
			<svg class="messageIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>
			<h1>${title}</h1>
			<p>${message}</p>
			${retryHref ? `<a class="button" href="${retryHref}">${retryLabel}</a>` : ""}
		</div>
	</main>
	<footer>
		<span class="footer_copyright">© ${year} EARCE.NET</span>
		<span class="footer_version">${footerVersionText(version)}</span>
	</footer>
</body>
</html>`;

module.exports = {messagePageHtml, footerVersionText};
