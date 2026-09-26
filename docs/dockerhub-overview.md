<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager) の
"Repository overview" へ貼り付ける説明文。機能を追加したらここも更新し、Docker Hub側へ反映する。
貼り付けるのは、このコメントより下の本文すべて。

短い説明(Description)欄には次の1行を使う:
Self-hosted document manager with versioning, tagging, full-text/semantic search, and an API for AI agents.

画像はGitHub(raw.githubusercontent.com)の公開URLを参照している。スクリーンショットを
撮り直した場合(npm run screenshots)は、pushすればDocker Hub側の表示も自動的に新しくなる。
-->

# Document Manager

*Self-hosted document management service for single-file documents (HTML / MHTML / Markdown / PDF / images /
CSV / TSV / text / log / JSON / draw.io / Excel / Word / PowerPoint). Versioning, tagging, projects with
annotated contents lists, sandboxed hosting of web-page mockups, full-text and semantic search, and a
token-authenticated REST API designed for AI agents. Documentation below is in Japanese; see the
[GitHub repository](https://github.com/EARCE9000/document-manager) for details.*

## どんなシステムか

社内の資料を1か所に集めて、探して、そのままブラウザで読むためのドキュメント管理サービスです。
Node.js (Express) 製で、このイメージを起動するだけで動きます。

扱うのは「1ファイルで完結する文書」です。HTML / MHTML / Markdown / PDF / 画像(SVG・PNG・JPEG) /
CSV・TSV / テキスト・ログ / JSON / draw.io / Excel・Word・PowerPoint に対応していて、どれも
ダウンロードせずにブラウザ上でそのまま閲覧できます。Markdown や MHTML はサーバー側で見やすい形に
変換し、PDF はブラウザ標準のビューアで開きます。draw.io は公式ビューアを同梱しており、図をそのまま
描画します(画像を別途用意する必要はありません)。Excel・Word・PowerPoint は**内容の概要**
(シートの表・見出しと段落・スライドごとの本文と発表者ノート)を表示し、中身の文字は全文検索の
対象になります(この概要表示では書式・図・グラフは再現しません)。

レイアウトも見たい場合は、**変換サービス**(別イメージ `earce9000/document-manager-converter`)を
併せて起動すると、PDFでも開けるようになります。ただし LibreOffice による変換のため**忠実な再現では
ありません**(フォントの字幅の違いで行の折り返しやページ数がずれることがあります)。
「だいたいの体裁と、どこに何があるか」を掴む用途で、細かいところは原本をダウンロードして
確認してください。変換サービスは任意で、無くても文書の登録・検索・概要表示には影響しません。

![文書一覧とプレビュー](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/document-list.png)

資料は**タグ**と**プロジェクト**で整理します。タグは自由入力で、よく使うタグだけを並べた
「タグ体系」の画面から一覧できます。プロジェクトはフォルダ階層を持てるので、案件ごとの資料を
まとめるのに向いています。1つの文書を複数のプロジェクトに置くこともできます。

![タグ体系](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/tag-tree.png)

**版の管理**ができます。修正した資料を「新しい版」としてアップロードすると、古い版は自動的に
アーカイブされ、タグとプロジェクトへの登録は新しい版へ引き継がれます。プレビューの上部には
「v1 › v2 › v3」と版の履歴が並び、過去の版もそのまま開けます。別々に登録してしまった資料を、
後から新旧の版として結び直すこともできます。版とは別に、見積書と契約書のような**関連文書**どうしを
結ぶこともできます。

![プロジェクト](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/projects.png)

**「お品書き」で案件の資料を人に渡せます。** 資料を集めても、ファイル名だけでは受け取った側が
全部開くことになります。プロジェクト名をクリックすると、その案件にどんな資料が揃っていて
**それぞれが何なのか**を1枚にした一覧が出ます。資料ごとの説明はその場で書け、フォルダは章の
見出しになります。そのままMarkdownでコピーできるので、引き継ぎ・レビュー依頼・打ち合わせの
資料としてメールや議事録に貼れます。

説明は**プロジェクトごとに持ちます**。同じ設計書でも「A案件では前提資料、B案件では参考」と
書き分けられます。

![お品書き](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/project-manifest.png)

**削除はありません。** 「アーカイブ」は Gmail と同じ論理削除で、実ファイルは残り、いつでも元に戻せます。
誰が何をしたかは操作履歴に残り、他の利用者がアップロードやタグ付けをすると、画面の右下に小さな通知が出ます。

![操作履歴](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/history.png)

**Webページのモックアップを、そのまま動かして確認できます。** LLMなどで作った画面案の一式を
ZIPでアップロードすると、別ウィンドウで**実際に動く状態**で開けます(JavaScriptも動きます)。
React のようにJSが画面を組み立てるものでも構いません。文書とは別のコレクションとして管理し、
版を重ねると古い版は自動でアーカイブされ、版履歴から辿れます。サンプルのExcelやPDFを同梱して
ダウンロードさせることもできます。

![モックアップ管理](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/mockups.png)

安全のため、モックアップは**このアプリから切り離した状態**で配信します。ブラウザから見ると
モックアップのページは「どこのサイトでもない」扱いになり、**このアプリの文書やAPI、ログイン情報には
一切手が届きません**。アップロードされたJavaScriptが、見ている人の権限で勝手に操作することは
できない、ということです。ZIPの展開時にも、決められた置き場所の外へ書き出そうとするものや、
極端に膨らむように細工されたものは受け付けません。

なお、この機能はファイルをローカルディスクに保存する構成(既定)でのみ使えます。
S3 / GCS 構成ではメニューごと表示されません。

**検索**は、ファイル名・タグ・メモ・本文を対象にした部分一致検索が標準です。日本語でも単語の区切りを
気にせず探せます。加えて、Weaviate を併せて起動すると**意味検索**(言い換えや表記ゆれを含めて近い資料を
探す)も使えるようになります。

**ログイン**は OpenID Connect です。Entra ID・Cognito・Google・Synology SSO など、標準的なプロバイダなら
設定を差し替えるだけで使えます。利用できるのは許可リストに登録された人だけで、権限は管理者・読み書き・
閲覧のみの3種類です。

**AIエージェントから使えます。** ブラウザを介さずに呼べる API キーを画面から発行でき(有効期限は最長1年)、API の仕様は
`GET api/openapi.json`(機械可読)と `GET api/usage.md`(説明文)で取得できます。Claude Code・OpenAI Codex・
Google Antigravity 用の Skill も画面からダウンロードでき、「この資料アップして」「前の版を置き換えて」
「〜を探して」と話しかけるだけで操作できるようになります。

![APIキー管理とAIエージェント用Skill](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/api-keys-skill.png)

**構成は後から変えられます。** 既定では1コンテナで完結し、文書のメタデータは SQLite、ファイルは
ローカルディスクに保存します。環境変数を変えるだけで、メタデータを PostgreSQL に、ファイルを S3 や
GCS に移せるので、AWS(ECS/Fargate)や GCP(Cloud Run / GKE)で複数インスタンス構成にもできます。

## 構成

![システム構成](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/architecture.png)

**変換サービス(converter)と Weaviate / 推論サーバーはどちらも任意**です。無くてもアプリは動き、
体裁つき表示と意味検索だけが使えなくなります。単一コンテナだけで動かすこともできます。

変換サービスは、信用できない文書を LibreOffice で開くという性質上、**インターネットにも他の
サービスにも出られない専用ネットワークに閉じ込めています**(読み取り専用・作業場所はメモリ上の
一時領域・非root・メモリ上限)。細工された文書に任意のURLを叩かせないためです。

## 管理画面(管理者のみ)

画面右上の歯車から開きます。サーバーにログインせずに「異常が無いか」「次に何をすべきか」を
判断できることを目的にしています。

- **サーバー**: 版・ビルド時刻・起動時刻・稼働時間・DBファイルの一覧。更新したはずなのに
  ビルド時刻が変わっていなければ、新しいイメージに入れ替わっていないと分かります
- **データベース**: 破損の検知(起動のたびに自動で確認)と、**DBと実ファイルの照合**。
  ファイルだけ残っている文書は登録し直せます。逆に**ファイルが見つからない文書の記録は消しません**
  (ストレージが一時的に見えていないだけの可能性があり、消すとタグ・メモ・版の紐付けまで失うため)
- **変換サービス**: 動いているか、変換に失敗した文書はあるか(その場で再実行できます)
- **アクセス許可ユーザー**: ログインできる人とその権限の管理

## 立ち上げるために必要な作業

### 1. 事前に用意するもの

**OpenID Connect の設定**を、利用しているプロバイダ側で済ませてください。クライアントIDと
クライアントシークレットを発行し、コールバックURL(`https://<公開するホスト名>/login`)を登録します。

**データの置き場所**として、ホスト側にディレクトリを1つ用意します。ここに SQLite のデータベースと
文書ファイルが入ります。

**セッションの署名鍵**を生成しておきます。

```bash
openssl rand -hex 32
```

### 2. 起動する

```bash
docker run -d \
  --name document-manager \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e BASE_PATH="/" \
  -e OIDC_ISSUER="https://accounts.example.com" \
  -e OIDC_CLIENT_ID="<クライアントID>" \
  -e OIDC_CLIENT_SECRET="<クライアントシークレット>" \
  -e OIDC_REDIRECT_URI="https://docs.example.com/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="<手順1で生成した値>" \
  earce9000/document-manager:latest
```

`http://localhost:8080/` を開くとログイン画面へ転送されます。

`SESSION_SECRET` を指定しないと、起動のたびに鍵が変わり、再起動のたびに全員がログアウトされます。
必ず固定の値を渡してください。

Windows の Git Bash から実行する場合は、`-v` のパスが書き換えられてしまうため、先頭に
`MSYS_NO_PATHCONV=1` を付けてください。

### 3. 最初のログイン

**許可リストが空の間は誰もログインできません。** そこで `ADMIN_EMAIL` が働きます。管理者が1人もいない間に
限り、そのアドレスでログインした人が自動的に管理者として登録されます。常設の特別扱いではないため、
管理者を全員削除してしまっても締め出されません。

最初のログイン後、画面右上の利用者アイコンから、使う人のメールアドレスを許可リストへ追加してください。
権限は、管理者(admin)・読み書き(readwrite)・閲覧のみ(readonly)から選べます。

### 4. リバースプロキシの後ろに置く場合

公開するパスを `BASE_PATH` に設定します。ホスト全体をこのサービスに使うなら `/`、
サブパスで公開するなら `/document_management` のように指定します。`OIDC_REDIRECT_URI` も
公開URLに合わせてください。アプリはリクエストからURLを組み立てるので、ほかの設定は不要です。

画面の自動更新と通知に Server-Sent Events を使っています。プロキシが応答を溜め込む設定だと通知が
届かないため、その場合はバッファリングを無効にしてください(Apache なら `flushpackets=on`、
nginx 向けにはアプリ側から `X-Accel-Buffering: no` を返しています)。

### 5. 意味検索を使う場合

アプリ・Weaviate・埋め込み計算用の推論サーバーの3つを起動します。**Weaviate はポートを公開しないでください。**
匿名アクセスが有効なため、外部から触れる状態になってしまいます。

```yaml
services:
  app:
    image: earce9000/document-manager:latest
    restart: always
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      BASE_PATH: "/"
      OIDC_ISSUER: "https://accounts.example.com"
      OIDC_CLIENT_ID: "<クライアントID>"
      OIDC_CLIENT_SECRET: "<クライアントシークレット>"
      OIDC_REDIRECT_URI: "https://docs.example.com/login"
      ADMIN_EMAIL: "admin@example.com"
      SESSION_SECRET: "<openssl rand -hex 32 の値>"
      WEAVIATE_URL: "http://weaviate:8080"
      WEAVIATE_GRPC_PORT: "50051"
    depends_on:
      - weaviate

  weaviate:
    image: docker.io/semitechnologies/weaviate:latest
    restart: always
    environment:
      AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: "true"
      PERSISTENCE_DATA_PATH: /var/lib/weaviate
      ENABLE_MODULES: text2vec-transformers,text2vec-cohere,text2vec-openai,text2vec-aws
      DEFAULT_VECTORIZER_MODULE: text2vec-transformers
      TRANSFORMERS_INFERENCE_API: http://t2v-transformers:8080
      CLUSTER_HOSTNAME: node1
    volumes:
      - weaviate_data:/var/lib/weaviate
    depends_on:
      - t2v-transformers

  t2v-transformers:
    image: docker.io/semitechnologies/transformers-inference:sentence-transformers-paraphrase-multilingual-mpnet-base-v2
    restart: always
    environment:
      ENABLE_CUDA: "0"

volumes:
  weaviate_data:
```

登録済みの文書は、起動後にバックグラウンドで順に索引付けされます(1件あたり数秒。進み具合は画面の
「ベクトル索引」で確認できます)。推論サーバーは 1.0〜1.4GB 程度のメモリを使い、索引付けの間は
CPU を複数コア使います。

podman 用の構成ファイル(コンテナの固定IP、Weaviate のポート非公開)は
[`deploy/compose.yml`](https://github.com/EARCE9000/document-manager/blob/main/deploy/compose.yml)
にあります。podman では、イメージ名を `docker.io/` から完全に指定してください(短い名前は
`registries.conf` の検索順で解決されるため、RHEL系ホストでは失敗します)。

### 6. 主な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `OIDC_ISSUER` | (必須) | OpenID Connect の issuer URL |
| `OIDC_CLIENT_ID` | (必須) | クライアントID |
| `OIDC_CLIENT_SECRET` | (空) | クライアントシークレット(パブリッククライアントなら不要) |
| `OIDC_REDIRECT_URI` | (必須) | コールバックURL。プロバイダ側にも同じ値を登録する |
| `ADMIN_EMAIL` | (未設定) | 管理者が1人もいない間だけ働く、自己修復用のアドレス |
| `SESSION_SECRET` | (ランダム) | セッションの署名鍵。必ず固定値を指定する |
| `SESSION_MAX_AGE_HOURS` | `8` | ログインセッションの寿命(時間) |
| `BASE_PATH` | `/document_management` | 公開時のパスprefix |
| `DATA_DIR` | `/data` | SQLite とローカル保存時の文書ファイルの置き場所 |
| `DATABASE_BACKEND` | `sqlite` | `sqlite` / `postgres`(複数インスタンス構成では必須) |
| `DATABASE_URL` | (未設定) | PostgreSQL の接続文字列(標準の `PG*` 変数でも可) |
| `STORAGE_BACKEND` | `local` | `local` / `s3` / `gcs` |
| `OFFICE_RENDER_URL` | (未設定) | 体裁つき表示(Office→PDF)の変換サービスのURL。未設定ならこの機能は無効(概要表示だけになります) |
| `WEAVIATE_URL` | (未設定) | 設定すると意味検索が有効になる |
| `UPLOAD_MAX_BYTES` | `268435456` | 1ファイルのアップロード上限(256MB)。超過時は413 |
| `CONTENT_TEXT_MAX_CHARS` | `300000` | 検索用に保存する本文の上限。超過分は検索対象外(ファイル自体は全て保存される) |
| `MOCKUP_MAX_TOTAL_BYTES` | `314572800` | モックアップZIPの展開後の合計サイズの上限(300MB) |
| `MOCKUP_VIEW_TOKEN_MINUTES` | `60` | モックアップを開いていられる時間(分)。切れても開き直せます |
| `PROJECT_NOTE_MAX_CHARS` | `500` | お品書きの説明書き1件の上限(文字数) |
| `AUTH_DISABLED` | (未設定) | `true` で認証を無効化(開発用。本番では使わない) |
| `LOG_LEVEL` | `info` | ログレベル |
| `TZ` | (ホスト依存) | タイムゾーン(例: `Asia/Tokyo`) |

S3 の認証情報は AWS SDK の標準の取得順(IAMロール優先)、GCS は Application Default Credentials に従います。
全変数の一覧は GitHub の README にあります。

### 7. データの扱いと更新・切り戻し

`/data` をマウントしておけば、文書・モックアップと SQLite のデータベースはそこに残ります。

SQLite のスキーマにはバージョンがあり、更新時には**新しいファイルを作ってデータを移し、古いファイルは
そのまま残します**。古いイメージへ戻せるようにするためです。更新前に `/data/db` のバックアップを取ってください。
なお、更新後に登録した文書は、古いイメージへ戻すと見えません(古いイメージは古いファイルを読むためです)。

PostgreSQL 構成の場合、スキーマの更新は起動時に自動で適用されます。

## ライセンス

MIT

ソースコードと詳しいドキュメント: https://github.com/EARCE9000/document-manager
