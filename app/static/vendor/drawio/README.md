# draw.io viewer (vendored)

`viewer-static.min.js` は draw.io (diagrams.net) 公式の埋め込み用ビューアです。
`.drawio` をサーバ側で画像化せず、ブラウザ上でそのまま描画するために同梱しています
(画像化を挟まないため、図の大きさやページ数に左右されません)。

| 項目 | 内容 |
|---|---|
| 取得元 | https://github.com/jgraph/drawio `src/main/webapp/js/viewer-static.min.js` |
| バージョン | v31.4.6 |
| ライセンス | Apache License 2.0 (https://github.com/jgraph/drawio/blob/dev/LICENSE) |

更新する場合は、同じパスから新しいタグのファイルを取得してこの表を書き換えてください。

```bash
curl -fL -o app/static/vendor/drawio/viewer-static.min.js \
  https://raw.githubusercontent.com/jgraph/drawio/<タグ>/src/main/webapp/js/viewer-static.min.js
```

## 外部通信について

このビューアは既定で stencil(拡張図形)・スタイルを `viewer.diagrams.net` から取得しようとします。
社内の図の内容が外部へ送られるのは避けたいため、[drawio-viewer.html](../../drawio-viewer.html) では
これらのパスを自ドメイン配下に差し替え、**外部への通信を行わない**ようにしています。
標準の図形はこのファイル自身に含まれているため、通常の図はそのまま描画できます
(ごく一部の拡張図形は簡略表示になります)。
