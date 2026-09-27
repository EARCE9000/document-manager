/*!
 * drawio-viewer-boot.js : draw.ioビューア本体を読み込む前の設定
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * viewer-static.min.js は読み込み時にこれらのグローバルを見るため、必ず先に読み込むこと。
 */

// ビューア既定の「ライトボックス」(図をクリックすると viewer.diagrams.net が開き、
// 図の中身がその第三者ページへ渡される)を使わせない。drawio-viewer.js 側で lightbox:false を
// 指定しているが、万一クリックされても社外のホストへ行かないよう、行き先も自分自身にしておく
window.DRAWIO_LIGHTBOX_URL = window.location.origin;

// 外部(viewer.diagrams.net)への通信を行わせない。標準の図形はビューア本体に、
// 拡張図形は vendor/drawio/stencils に同梱してある(STENCIL_PATH の先に実体がある)。
// 実体を置かずにパスだけ差し替えると、外部へは出ない代わりに回路図の抵抗などが
// ただの四角に化けるので、行き先を変えるときは中身があるかまで見ること
window.PROXY_URL = "./vendor/drawio/";
window.STYLE_PATH = "./vendor/drawio/styles";
window.SHAPES_PATH = "./vendor/drawio/shapes";
window.STENCIL_PATH = "./vendor/drawio/stencils";
window.IMAGE_PATH = "./vendor/drawio/images";
// 数式(MathJax)・画像化・変換サービスも既定では diagrams.net 側を見に行くため、同様に止める。
// 数式だけは、図の中身に関わらず必ず startup.js を読みに行く作りになっているので、
// 404にせずこちらの差し替え(drawio-math/startup.js)を置いている
window.DRAW_MATH_URL = "./drawio-math";
window.GRAPH_IMAGE_PATH = "./vendor/drawio/images";
window.EXPORT_URL = "./vendor/drawio/export";
window.VSS_CONVERT_URL = "./vendor/drawio/convert";
window.EMF_CONVERT_URL = "./vendor/drawio/convert";
// 編集機能向けの外部サービス(ビューアでは使わないが、既定値を残さない)
window.DRAWIO_GITHUB_URL = window.location.origin;
window.DRAWIO_GITHUB_API_URL = window.location.origin;
window.DRAWIO_GITLAB_URL = window.location.origin;
window.mxLoadStylesheets = false;
window.mxLoadResources = false;
