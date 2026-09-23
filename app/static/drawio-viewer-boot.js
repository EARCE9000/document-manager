/*!
 * drawio-viewer-boot.js : draw.ioビューア本体を読み込む前の設定
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * viewer-static.min.js は読み込み時にこれらのグローバルを見るため、必ず先に読み込むこと。
 */

// 外部(viewer.diagrams.net)への通信を行わせない。標準の図形はビューア本体に含まれており、
// ここで指すパスに実体は無い(ごく一部の拡張図形が簡略表示になるだけ)
window.PROXY_URL = "./vendor/drawio/";
window.STYLE_PATH = "./vendor/drawio/styles";
window.SHAPES_PATH = "./vendor/drawio/shapes";
window.STENCIL_PATH = "./vendor/drawio/stencils";
window.IMAGE_PATH = "./vendor/drawio/images";
window.mxLoadStylesheets = false;
window.mxLoadResources = false;
