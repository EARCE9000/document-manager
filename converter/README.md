# Office → PDF 変換サービス (converter)

Excel / Word / PowerPoint を**元の体裁のまま**確認できるようにするための、小さなHTTPサービスです。
LibreOffice をヘッドレスで動かして PDF を作ります。

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
| `GET /health` | 稼働確認。`{status, apiVersion, libreOffice}` を返す |
| `POST /convert` | 本体に変換対象のバイト列、`X-Filename` に元のファイル名(URLエンコード)。`application/pdf` を返す |

対応拡張子: `.xlsx .xlsm .docx .docm .pptx .pptm .odt .ods .odp`

エラーは `{"error": "..."}` (JSON)。400=拡張子が対象外/Office文書として読めない、504=タイムアウト、500=変換失敗。

```bash
curl -X POST http://127.0.0.1:3010/convert \
  -H "Content-Type: application/octet-stream" \
  -H "X-Filename: $(python -c 'import urllib.parse;print(urllib.parse.quote("報告書.pptx"))')" \
  --data-binary @報告書.pptx -o out.pdf
```

## 設計上の約束

- **変換は直列(同時実行1)**。非力なサーバでも他の処理を圧迫しないことを優先する
- **リクエストごとに専用のプロファイルとサブディレクトリ**を使う(LibreOfficeは同じプロファイルを共有すると多重起動で失敗する)
- **タイムアウトでプロセスを確実に殺す**(既定120秒。`CONVERT_TIMEOUT_SECONDS`)
- **認証は持たない**。内部ネットワークに閉じることを前提とする(composeを参照)
- **依存パッケージを持たない**(Node標準モジュールのみ)

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `LISTEN_PORT` | 3000 | 待ち受けポート |
| `WORK_DIR` | /tmp/convert | 作業場所(tmpfsを割り当てる) |
| `CONVERT_MAX_BYTES` | 134217728 (128MB) | 受け付ける最大サイズ |
| `CONVERT_TIMEOUT_SECONDS` | 120 | 1件あたりの打ち切り |

## 開発

```bash
# ビルド(コンテキストはリポジトリ直下)
docker build -f converter/Dockerfile -t dm-converter:local .

# 起動(読み取り専用 + tmpfs + メモリ上限。本番と同じ条件)
docker run -d --name dm-converter -p 3010:3000 \
  --tmpfs /tmp:rw,size=512m --read-only --memory 1g dm-converter:local

# 実ファイル(test/fixtures/office/)での結合テスト。所要時間も出る
node converter/test/smoke.js
```

amd64 のみをビルドします。arm64 は QEMU エミュレーション下での `apt-get`(LibreOffice一式)が
現実的な時間で終わらないため対象外です。
