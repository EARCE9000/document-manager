# Office → PDF 変換サービス (converter)

Excel / Word / PowerPoint の**レイアウトのついたPDF**を作るための、小さなHTTPサービスです。
LibreOffice をヘッドレスで動かします。

**忠実な再現ではありません。** Microsoft Office で開いたときと同じ見え方になるとは限らず、
日本語のMSフォント(MS Pゴシック・メイリオ・游ゴシック等)は同梱の Noto で代替するため字幅が変わり、
行の折り返し・はみ出し・ページ数がずれることがあります(英字は Liberation が Arial/Times 等と
字幅互換なので崩れにくい)。SmartArt・グラフ・特殊な図形も差が出やすい部分です。
**用途は「だいたいの体裁と、どこに何があるか」を掴むこと**で、細かいところは原本を
ダウンロードして確認してもらう前提です。

アプリ本体([../app/](../app/))からは内部ネットワーク経由でのみ呼び出し、**外部には公開しません**。

## なぜ別のイメージなのか

LibreOffice を同梱するとイメージが1GBを超えます。アプリ本体に入れると、**変換機能を使わない利用者にも
その負担を強いる**ことになるため、`earce9000/document-manager-converter` として分けています。
converter を動かさない構成では、アプリ側は従来どおり[概要プレビュー](../app/lib/office.js)だけを使います。

## 実測値 (amd64 / ローカル環境)

| 項目 | 実測 |
|---|---|
| イメージサイズ | 1.19GB |
| 待機時メモリ | 約16MB |
| ピークメモリ | **約272MB** |
| 変換時間 | 小さめのxlsx/docx/pptx: **約1秒** / 1万行のExcel(264ページ): **約4秒** |
| 2回目以降 | 初回と変わらず約1秒(常駐プロセスは持たない) |

LibreOffice は **25.2.3** (Debian 13 trixie のパッケージ。追加リポジトリ不要)。

### Excelの見え方について

PDFは「Excelで印刷したときの見え方」になります。**列幅が足りない列は `###` になり、文字は途中で
切れます**(元の文書がそういう体裁である、ということです)。全文を確認したい場合は、
アプリ内蔵の[概要プレビュー](../app/lib/office.js)を使ってください。こちらは列幅に関係なく
セルの値をそのまま表示します。2つの表示は補い合う関係にあります。

### PDFのサイズに注意

日本語フォントを埋め込むため、**変換後のPDFは元より大きくなります**。文書1件あたり
**0.5MB程度の上乗せ**を見込んでください(LibreOffice 7.4 系と比べても増えています)。

| 入力 | PDF |
|---|---|
| 実資料のpptx 29KB(5ページ) | 199KB |
| 小さいxlsx 17KB | 515KB |
| 1万行のxlsx 291KB(264ページ) | 14.4MB |

## API

| | 内容 |
|---|---|
| `GET /health` | 稼働確認。`{status, apiVersion, libreOffice, maxBytes, timeoutSeconds}` を返す(設定が効いているか外から確認できる) |
| `POST /convert` | 本体に変換対象のバイト列、`X-Extension` に拡張子、`X-Document-Id` にログ用の文書ID。`application/pdf` を返す |

対応拡張子: `.xlsx .docx .pptx .odt .ods .odp`

**マクロ付き(`.xlsm` `.docm` `.pptm` `.xlsb`)は受け付けません**(400)。LibreOfficeは既定でマクロを
実行しませんが、信用できないファイルを開くソフトにわざわざマクロ入りを渡す理由がないためです。
これらはアプリ側の概要プレビューだけで扱います。

**ファイル名は受け取りません。** 医療機関の資料などでは**ファイル名自体に患者名・施設名が入り得る**ため、
渡すのは拡張子と、ログ用の文書IDだけにしています。

エラーは `{"error": "..."}` (JSON)。400=拡張子が対象外/マクロ付き/Office文書として読めない、
413=サイズ超過、504=タイムアウト、500=変換失敗。

```bash
curl -X POST http://127.0.0.1:3010/convert \
  -H "Content-Type: application/octet-stream" \
  -H "X-Extension: .pptx" -H "X-Document-Id: 202609_xxxxxxxx" \
  --data-binary @報告書.pptx -o out.pdf
```

## 設計上の約束

- **変換は直列(同時実行1)**。非力なサーバでも他の処理を圧迫しないことを優先する
- **リクエストごとに専用のプロファイルとサブディレクトリ**を使う(LibreOfficeは同じプロファイルを共有すると多重起動で失敗する)
- **タイムアウトでプロセスを確実に殺す**(既定120秒。`CONVERT_TIMEOUT_SECONDS`)
- **認証は持たない**。内部ネットワークに閉じることを前提とする(下記)
- **依存パッケージを持たない**(Node標準モジュールのみ)

## 隔離(compose側で担保していること)

LibreOfficeは、文書に埋め込まれた外部参照(画像URL・リンク・外部セル参照)を取りに行くことがあります。
細工された文書に任意のURLを叩かせない(SSRF)ため、**ネットワーク構成で封じ込めています**。

- **変換専用ネットワーク(`document_manager_convert`)にだけ参加する** → Weaviate等の他サービスへ到達できない
- そのネットワークは **`internal: true`** → インターネットへ出られない
- ボリュームなし・**読み取り専用**・作業場所はtmpfs・非root・`no-new-privileges`・メモリ上限

この構成は [test/deploy.test.js](../test/deploy.test.js) で検証しており、崩すとテストが落ちます。
podmanでは、実際に効いているかを次で確認できます。

```bash
podman network inspect <プレフィックス>_document_manager_convert | grep -i internal
```

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `LISTEN_PORT` | 3000 | 待ち受けポート |
| `WORK_DIR` | /tmp/convert | 作業場所(tmpfsを割り当てる) |
| `CONVERT_MAX_BYTES` | 52428800 (50MB) | 受け付ける最大サイズ(超過は413) |
| `CONVERT_TIMEOUT_SECONDS` | 120 | 1件あたりの打ち切り(超過は504。sofficeは強制終了する) |

## 開発

```bash
# ビルド(コンテキストはリポジトリ直下)
docker build -f converter/Dockerfile -t dm-converter:local .

# 起動(読み取り専用 + tmpfs + メモリ上限。本番と同じ条件)
docker run -d --name dm-converter -p 3010:3000 \
  --tmpfs /tmp:rw,size=512m --read-only --memory 1g dm-converter:local

# 上限・タイムアウトの検証用に、小さい値で動くインスタンスも立てる
docker run -d --name dm-converter-limits -p 3011:3000 \
  --tmpfs /tmp:rw,size=512m --read-only --memory 1g \
  -e CONVERT_MAX_BYTES=1048576 -e CONVERT_TIMEOUT_SECONDS=2 dm-converter:local

# 実ファイル(test/fixtures/office/)での結合テスト。所要時間も出る
CONVERTER_LIMITS_URL=http://127.0.0.1:3011 node converter/test/smoke.js

# Document Manager本体と繋いだ結合テスト(アップロード→変換→PDFの中身まで)
npm run test:converter
```

amd64 のみをビルドします。arm64 は QEMU エミュレーション下での `apt-get`(LibreOffice一式)が
現実的な時間で終わらないため対象外です。
