<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager-converter) の
"Repository overview" へ貼り付ける説明文。貼り付けるのは、このコメントより下の本文すべて。
開発者向けの説明(仕組み・実測値・テストの動かし方)は converter/README.md にある。

短い説明(Description)欄には次の1行を使う。Docker Hub側の上限は100文字なので、
書き換えるときは必ず文字数を数えること(超えると入らない)。
Office (Excel/Word/PowerPoint) to PDF converter for Document Manager (LibreOffice, no network).
-->

# Document Manager Converter

*Office-to-PDF conversion service for [Document Manager](https://hub.docker.com/r/earce9000/document-manager).
Converts Excel / Word / PowerPoint files into laid-out PDFs with headless LibreOffice, so they can be viewed
with their layout and exported to Miro boards. Macro-enabled files are rejected. Run it on an isolated
network with no internet access. Documentation below is in Japanese.*

## これは何か

[Document Manager](https://hub.docker.com/r/earce9000/document-manager) で、Excel・Word・PowerPoint を
**レイアウトのついたPDF**で開けるようにするための変換サービスです。LibreOffice をヘッドレスで動かします。

Document Manager 本体だけでも、Office 文書は**内容の概要**(シートの表・見出しと段落・スライドごとの本文)で
読めます。このサービスを併せて動かすと、それに加えて「**体裁つきで開く**」ボタンが出て、
印刷したときに近い見た目のPDFで確かめられます。変換はアップロードのときに自動で行います。

**Miro への書き出しでも使います。** Document Manager から Miro のボードへ Office 文書を書き出すときは、
このサービスで作ったPDFを出します。このサービスが無い環境では、Office 文書は Miro に書き出せません。

**単体で使うものではありません。** Document Manager 本体から、内部ネットワーク経由で呼び出します。
認証を持たないので、**ポートを外へ公開しないでください**。

## どういうPDFになるか

**忠実な再現ではありません。** Microsoft Office で開いたときと同じ見え方になるとは限りません。

- 日本語の MS フォント(MS Pゴシック・メイリオ・游ゴシック等)は、同梱の Noto で代わりに描きます。
  字幅が変わるため、行の折り返し・はみ出し・ページ数がずれることがあります
  (英字は Liberation が Arial・Times 等と字幅をそろえているので崩れにくい)
- SmartArt・グラフ・特殊な図形も差が出やすい部分です
- Excel は「印刷したときの見え方」になります。列幅が足りない列は `###` になり、文字は途中で切れます
  (セルの値そのものは、Document Manager の概要表示で確かめられます)
- 日本語フォントを埋め込むため、PDFは元のファイルより大きくなります(1件あたり 0.5MB 程度の上乗せ)

用途は「**だいたいの体裁と、どこに何があるか**」を掴むことです。細かいところは原本をダウンロードして
確かめてください。

## 使い方

Document Manager の `OFFICE_RENDER_URL` に、このサービスのURLを渡します。

```yaml
services:
  app:
    image: earce9000/document-manager:latest
    environment:
      OFFICE_RENDER_URL: "http://converter:3000"
      # (ほかの設定は Document Manager の説明を参照)
    networks:
      - default
      - convert

  converter:
    image: earce9000/document-manager-converter:latest
    restart: always
    read_only: true
    tmpfs:
      - /tmp:rw,size=1g
    security_opt:
      - no-new-privileges:true
    mem_limit: 1g
    networks:
      - convert

networks:
  convert:
    internal: true
```

アプリの `depends_on` には入れないでください。変換は無くても成り立つ機能なので、このサービスの取得や
起動に失敗しても、アプリは動き続けるようにしておきます(その間は概要表示だけになります)。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CONVERT_MAX_BYTES` | `52428800` (50MB) | 受け付けるファイルの上限(超えた文書は変換せず、概要表示だけになります) |
| `CONVERT_TIMEOUT_SECONDS` | `120` | 1件あたりの打ち切り(超えたら LibreOffice を強制終了します) |
| `LISTEN_PORT` | `3000` | 待ち受けるポート |

小さめの文書は1件1秒ほど、1万行の Excel(264ページ)で4秒ほどです。メモリは変換中で 300MB ほど使います。
変換は1件ずつ順に行い、ほかの処理を圧迫しないようにしています。

## 安全面

他人が作った Office 文書を開くので、何重にも閉じてあります。

- **マクロ付きの文書(`.xlsm` `.docm` `.pptm` `.xlsb`)は受け付けません**。信用できない文書を開くソフトに、
  マクロ入りを渡す理由がないためです(これらは Document Manager の概要表示だけで扱います)
- **ファイル名は受け取りません**。ファイル名そのものに個人名などが入ることがあるため、渡すのは拡張子と、
  ログ用の文書IDだけです
- 変換1件ごとに専用の作業場所を使い、終わったら消します
- 非root で動き、読み取り専用のファイルシステムで動かせます

LibreOffice は、文書に埋め込まれた外部の参照(画像のURL・リンク・外部のセル参照)を取りに行くことがあります。
細工された文書に任意のURLを叩かせないよう、上の例のように**外へ出られないネットワーク**(`internal: true`)に、
ほかのサービスとも分けて置いてください。

LibreOffice のセキュリティ修正を取り込むため、**イメージを毎週作り直しています**。定期的に取得し直してください。

## タグ

- `latest`: 最新
- `YYYYMMDD.HHMM`: ビルドした日時(JST)。直近3世代を残しています

amd64 のみです(LibreOffice 一式のため、イメージは 1GB を超えます)。

## 詳細

仕組み・実測値・API・テストは
[GitHub の converter/README.md](https://github.com/EARCE9000/document-manager/blob/main/converter/README.md)
にあります。ライセンスは MIT です。
