# draw.io viewer (vendored)

`viewer-static.min.js` は draw.io (diagrams.net) 公式の埋め込み用ビューアです。
`.drawio` をサーバ側で画像化せず、ブラウザ上でそのまま描画するために同梱しています
(画像化を挟まないため、図の大きさやページ数に左右されません)。

| 項目 | 内容 |
|---|---|
| 取得元 | https://github.com/jgraph/drawio `src/main/webapp/js/viewer-static.min.js` と `src/main/webapp/stencils/` |
| バージョン | v31.4.6(本体と stencils は必ず同じタグで揃える) |
| ライセンス | Apache License 2.0(全文は同じフォルダの [LICENSE](LICENSE)) |

`stencils/`(約42MB・204ファイル)は**拡張図形の実体**です。これが無いと、回路図の抵抗・
コンデンサなどが**ただの四角に化けます**(図自体は表示されるので気づきにくい)。

更新する場合は、同じタグから両方を取得してこの表を書き換えてください。

```bash
curl -fL -o app/static/vendor/drawio/viewer-static.min.js \
  https://raw.githubusercontent.com/jgraph/drawio/<タグ>/src/main/webapp/js/viewer-static.min.js

# stencils はファイル数が多いので、sparse-checkout でそのフォルダだけ取り出す
git clone --depth 1 --branch <タグ> --filter=blob:none --sparse https://github.com/jgraph/drawio.git /tmp/drawio
git -C /tmp/drawio sparse-checkout set src/main/webapp/stencils
rm -rf app/static/vendor/drawio/stencils
cp -r /tmp/drawio/src/main/webapp/stencils app/static/vendor/drawio/stencils
```

## 外部通信について

このビューアは既定で、stencil(拡張図形)・スタイル・数式(MathJax)などを `viewer.diagrams.net` から
取得しようとします。さらに、**図をクリックすると `viewer.diagrams.net` の「ライトボックス」が開き、
図の中身がその第三者ページへ渡されます**(既定で有効)。

社内の図が外部へ出るのは避けたいため、[drawio-viewer-boot.js](../../drawio-viewer-boot.js) で
これらの取得先を自ドメイン配下へ差し替え、[drawio-viewer.js](../../drawio-viewer.js) で
ライトボックス(`lightbox`)を無効にしています。加えて、ページ自体を
`default-src 'none'; script-src 'self'` のCSPで配信しているため(server.js参照)、
仮に取りこぼしがあってもブラウザ側で外部への読み込みが止まります。

標準の図形はビューア本体に、拡張図形は同じフォルダの `stencils/` に入れてあるため、
どちらも外部へ出ずにそのまま描画できます。

数式だけは事情が違います。ビューア本体は図の中身に関わらず必ず MathJax の `startup.js` を
読みに行くため、行き先を変えただけでは毎回404になります。MathJax 本体(数MB)は同梱せず、
[app/static/drawio-math/startup.js](../../drawio-math/startup.js) という**こちらで用意した
差し替え**を置いています(vendor配下ではありません)。数式(LaTeX)は組版されず
`$$E = mc^2$$` のような元の文字列のまま出ます。図形や他のラベルには影響しません。
組版させたい場合は MathJax を同梱し、`drawio-math/` をその中身に差し替えてください。

`stencils/` を減らしたい場合は分類フォルダごと消せます(そこを使っている図だけが四角に化けます)。
大きいのは `aws4.xml` 6.4MB / `rack` 5.6MB / `cisco_safe` 3.9MB あたりで、
回路図に要る `electrical` は0.5MBです。落としたことに気づけるよう、
[test/api/preview-xss.e2e.js](../../../../test/api/preview-xss.e2e.js) で
「拡張図形が四角に化けていないこと」「外部へ取りに行っていないこと」に加えて、
**ビューアが取りに行った先がすべて手元にあること(404が1件も出ないこと)**を見ています。

新しいバージョンへ更新するときは、上記の既定値が増えていないか
(`window.XXX_URL = window.XXX_URL || "https://..."` の箇所)を確認してください。
回帰は [test/api/preview-xss.e2e.js](../../../../test/api/preview-xss.e2e.js) で守っています。
