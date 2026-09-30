# Mermaid (vendored)

`mermaid.min.js` は Mermaid 公式のブラウザ向けバンドルです。
`.mmd` / `.mermaid` をサーバ側で画像化せず、ブラウザ上でそのまま描画するために同梱しています。

| 項目 | 内容 |
|---|---|
| 取得元 | https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js |
| バージョン | 11.12.0 |
| ライセンス | MIT(全文は同じフォルダの [LICENSE](LICENSE)) |
| 大きさ | 約2.6MB |

更新する場合は、同じパスから新しいバージョンを取得してこの表を書き換えてください。

```bash
curl -fL -o app/static/vendor/mermaid/mermaid.min.js \
  https://cdn.jsdelivr.net/npm/mermaid@<バージョン>/dist/mermaid.min.js
curl -fL -o app/static/vendor/mermaid/LICENSE \
  https://raw.githubusercontent.com/mermaid-js/mermaid/mermaid@<バージョン>/LICENSE
```

## バージョンの選び方

**12系は選んでいません。** 12.0.0 の `mermaid.min.js` は 5.32MB で、11系の倍あります。
増えているのは ELK レイアウト(大きな図の自動配置)で、通常の図には要りません。
ELK が必要になったときに上げてください。

## 外部通信について

**このビューアは外部と通信しません。** 実際に7種類(flowchart / sequence / class / state /
ER / gantt / pie)を描画して、外部へのリクエストが1件も出ないことを確認しています。

同梱の理由も同じで、CDNから読むと図の存在が第三者に伝わります。

## セキュリティ

Mermaid の図は**ラベルにHTMLを書けます**(draw.io と同じ性質)。つまり図のテキストは
信用できない入力です。守りは二重にしています。

1. `securityLevel: "strict"`(Mermaid 側のサニタイズ)
2. **`script-src 'self'` のCSP**(server.js でレスポンスヘッダーとして付与)

ライブラリのサニタイズ任せにはしません。2 があるため、1 を抜けるものがあっても
ページ内でスクリプトは動きません。ビューアのスクリプトを全て外部ファイルに分けているのは
このためです(インラインを許すとCSPを緩めることになる)。

`eval` / `new Function` はバンドルに含まれていないため、`unsafe-eval` は要りません。

フォントは端末にあるものを指定しています。Webフォントを外部から取りに行かせないためです。

回帰は [test/api/mermaid-viewer.e2e.js](../../../../test/api/mermaid-viewer.e2e.js) で守っています。
