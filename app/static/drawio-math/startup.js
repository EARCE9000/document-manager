/*!
 * startup.js : draw.ioビューアが読み込もうとする MathJax の代わり
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * これは draw.io 由来のファイルではない。こちらで置いている差し替えである。
 *
 * ビューア本体は図の中身に関係なく Editor.initMath() を呼び、DRAW_MATH_URL + "/startup.js"
 * を読みに行く。既定の行き先は diagrams.net 側なので drawio-viewer-boot.js で自分の配下へ
 * 向けているが、そこに実体が無いと毎回404になり、本物の不具合を探すときに邪魔になる。
 *
 * MathJax 本体(数MB)は同梱していない。数式(LaTeX)を書いたラベルは組版されず
 * 「$$E = mc^2$$」のような元の文字列のまま出る。同梱しない場合の見え方と同じで、
 * 図形や他のラベルの表示には影響しない。
 *
 * 中身を空にせず window.MathJax を触らないのは、ビューア側が
 * typeof MathJax.typeset === "function" を見て組版するかどうかを決めているため。
 * ここで何も定義しなければ、その判定が偽になり組版せずに素通りする。
 */
