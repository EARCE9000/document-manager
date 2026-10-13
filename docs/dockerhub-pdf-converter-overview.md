<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager-pdf-converter) の
"Repository overview" へ貼り付ける説明文。貼り付けるのは、このコメントより下の本文すべて。

短い説明(Description)欄には次の1行を使う。Docker Hub側の上限は100文字なので、
書き換えるときは必ず文字数を数えること(超えると入らない)。
HTML to PDF converter for Document Manager (headless Chromium, single long page, no scripts).
-->

# Document Manager PDF Converter

*HTML-to-PDF conversion service for [Document Manager](https://hub.docker.com/r/earce9000/document-manager).
Renders HTML / Markdown / MHTML documents with headless Chromium into a single long PDF page that looks like
the on-screen preview. Scripts are never executed and nothing but the document itself is loaded.
Documentation below is in Japanese.*

## これは何か

[Document Manager](https://hub.docker.com/r/earce9000/document-manager) の「PDFでダウンロード」のための
変換サービスです。HTML・Markdown・MHTML の文書を、**プレビューで見たままの1枚の長いPDF**にします。
HTML をメールに添付すると相手の環境では文字の羅列として出てしまうことがあるため、人に渡すための形として
用意しています。

**単体で使うものではありません。** Document Manager 本体から、内部ネットワーク経由で呼び出します。
認証を持たないので、**ポートを外へ公開しないでください**。

## どういうPDFになるか

- **1枚の長いページ**(A4 には区切りません。区切ると表や図がページの途中で切れるため)
- 横に長い表・1行が長いコードは、切れないように**ページを右へ広げます**
- スクロールさせている枠は、開いて中身を全部出します
- 文字は文字として入ります(検索・コピーできます)
- 200インチ(A4 でおよそ17枚分)を超える長さの文書だけ、複数ページに分かれます

フォントは BIZ UDゴシック / BIZ UD明朝で描きます(文書が指定する游ゴシック・メイリオ等は再配布できない
ため入っていません)。字幅が少し違うので、行の折り返し位置が画面とずれることがあります。
**外部に置かれた画像・フォント・CSS は入りません**(変換時に外部へ接続しないため)。

## 使い方

Document Manager の `HTML_PDF_URL` に、このサービスのURLを渡します。

```yaml
services:
  app:
    image: earce9000/document-manager:latest
    environment:
      HTML_PDF_URL: "http://pdf-converter:3000"
      # (ほかの設定は Document Manager の説明を参照)
    networks:
      - default
      - pdf

  pdf-converter:
    image: earce9000/document-manager-pdf-converter:latest
    restart: always
    read_only: true
    tmpfs:
      - /tmp:rw,size=512m
    security_opt:
      - no-new-privileges:true
    mem_limit: 1g
    networks:
      - pdf

networks:
  pdf:
    internal: true
```

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CONVERT_MAX_BYTES` | `52428800` (50MB) | 受け付けるHTMLの上限 |
| `CONVERT_TIMEOUT_SECONDS` | `60` | 1件あたりの打ち切り(通常は1秒かかりません) |
| `PDF_VIEWPORT_WIDTH` | `1280` | 画面として描く幅(px) |
| `LISTEN_PORT` | `3000` | 待ち受けるポート |

## 安全面

他人が作ったHTMLをブラウザのエンジンで開くので、何重にも閉じてあります。

- **文書のスクリプトを動かしません**
- **文書そのもの以外は読み込みません**(外部の画像・CSS、コンテナ内のファイル、内部の宛先)
- 変換1件ごとに Chromium を起動して捨てます(前の文書の状態を持ち越しません)
- 非root で動き、読み取り専用のファイルシステムで動かせます

そのうえで、上の例のように**外へ出られないネットワーク**(`internal: true`)に置いてください。

**Chromium 自身のサンドボックスは切っています。** 権限を絞ったコンテナの中では立ち上げられないためです。
スクリプトを動かさず通信も断っているので攻撃の入口は狭いですが、描画そのものの欠陥に対する守りは
コンテナの隔離だけになります。そのため**イメージを毎週作り直しています**(Chromium のセキュリティ修正を
取り込むため)。定期的に取得し直してください。

## タグ

- `latest`: 最新
- `YYYYMMDD.HHMM`: ビルドした日時(JST)。直近3世代を残しています

amd64 のみです。

## 詳細

仕組み・実測値・テストは
[GitHub の pdf-converter/README.md](https://github.com/EARCE9000/document-manager/blob/main/pdf-converter/README.md)
にあります。ライセンスは MIT です。
