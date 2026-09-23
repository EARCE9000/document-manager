# draw.io viewer (vendored)

`viewer-static.min.js` は draw.io (diagrams.net) 公式の埋め込み用ビューアです。
`.drawio` をサーバ側で画像化せず、ブラウザ上でそのまま描画するために同梱しています
(画像化を挟まないため、図の大きさやページ数に左右されません)。

| 項目 | 内容 |
|---|---|
| 取得元 | https://github.com/jgraph/drawio `src/main/webapp/js/viewer-static.min.js` |
| バージョン | v31.4.6 |
| ライセンス | Apache License 2.0(全文は同じフォルダの [LICENSE](LICENSE)) |

更新する場合は、同じパスから新しいタグのファイルを取得してこの表を書き換えてください。

```bash
curl -fL -o app/static/vendor/drawio/viewer-static.min.js \
  https://raw.githubusercontent.com/jgraph/drawio/<タグ>/src/main/webapp/js/viewer-static.min.js
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

標準の図形はこのファイル自身に含まれているため、通常の図はそのまま描画できます
(ごく一部の拡張図形は簡略表示になります)。

新しいバージョンへ更新するときは、上記の既定値が増えていないか
(`window.XXX_URL = window.XXX_URL || "https://..."` の箇所)を確認してください。
回帰は [test/api/preview-xss.e2e.js](../../../../test/api/preview-xss.e2e.js) で守っています。
