# WebService_DocumentManager

HTML / MHTML / Markdown / PDF / 画像(SVG/PNG/JPEG) / CSV・TSV / テキスト・ログ / JSON をアップロードして一覧・プレビューできる社内向けドキュメント管理Webサービス。
Node.js (Express) 製の単一コンテナで動作し、メタデータはSQLiteに、文書ファイルはローカルディスクまたはS3に保存する。

## 主な機能

### 文書管理
- **対応形式**: `.html` / `.htm` / `.mhtml` / `.mht` / `.md` / `.markdown` / `.pdf` / `.svg` / `.png` / `.jpg` / `.jpeg` / `.csv` / `.tsv` / `.txt` / `.log` / `.json`(単一ファイルのみ、1ファイル256MBまで)
- **保存先の切り替え**: 文書ファイルの実体は`STORAGE_BACKEND`環境変数でローカルディスク(既定)/S3を切り替えられる。アップロード・プレビュー変換・全文抽出・配信のすべてが共通のストレージ抽象層([lib/storage.js](app/lib/storage.js))経由になっており、S3モードでもアプリを経由してストリーミング配信するため認証・監査ログの挙動は変わらない。モード切替は「今後の保存先」の変更のみで、既存ファイルの自動移行は行わない
- **プレビュー**
  - html/htm: ブラウザがネイティブに描画できるためそのまま表示
  - mhtml/mht: `mhtml-to-html` で単一HTMLに変換して表示(ブラウザのネイティブmhtmlレンダリングは不安定なため)
  - md/markdown: `marked` でHTMLに変換して表示(ソースのままだと読みにくいため)
  - pdf: iframe埋め込みはせず、プレビュー画面中央に「別ウィンドウで開く」ボタンを表示する(Chromeは`sandbox`付きiframe内での内蔵PDFビューアの読み込みを`net::ERR_BLOCKED_BY_CLIENT`としてブロックすることがあるため、ブラウザのネイティブPDFビューアが確実に使える新しいタブでの表示に統一している)
  - svg/png/jpg/jpeg: ブラウザがネイティブに描画できるためそのまま表示(全文検索の対象にはならない。svgに埋め込まれたスクリプトは`sandbox`属性により実行されない)
  - csv/tsv: 1行目をヘッダーとしてHTMLテーブルに変換して表示(生テキストのままだと列が揃わず読みにくいため)
  - txt/log/json: ブラウザがネイティブに描画できるためそのまま表示(jsonはChrome/Firefox標準の折りたたみ可能なビューアが`sandbox`付きiframe内でも問題なく動作する)
  - 変換結果は元ファイルと同じフォルダに `preview.html` として保存する。ダウンロードは常に元ファイルを返す
  - プレビュー用iframe(html/mhtml/md変換結果)は `sandbox` 属性でスクリプト実行を制限する
  - プレビュー右上のアイコンボタンから、ファイルへの直接リンクのコピー・ダウンロードができる
  - リンクのコピー・「別ウィンドウで開く」・一覧の別ウィンドウアイコンは、いずれも `api/documents/:id/viewer` を指す。`api/documents/:id/file`(APIキー連携クライアント向け。未認証時はJSONの401のみを返す)とは別系統で、未ログイン状態でこのURLを開くとログイン画面へ自動的に迂回し、ログイン完了後に元のURLへ戻ってから文書を表示する。他の人にリンクを共有する場合はこちらが使われる
  - プレビュー上部に、ファイル名が似ている他の文書(現在表示中の一覧内、文字3-gramのDice係数で判定)をチップ表示し、クリックでそちらのプレビューに切り替えられる(バージョン違い等の関連文書を見つけやすくする)
- **全文検索**: ファイル名・本文(抽出済みプレーンテキスト)はFTS5(`trigram`トークナイザ)で部分一致検索する。単語分割不要で日本語等CJKにも強いが、3文字未満のクエリはヒットしない制約があるため、その場合は自動的に `LIKE` 検索にフォールバックする。タグ・メモは元々短い文字列のため常に `LIKE` で検索する
- **タグ**: 文書ごとに自由入力のタグを付与できる。他の文書に付けた既存タグを候補として選択することも可能(個数上限なし)
- **メモ**: プレビュー下部に、文書ごとの備忘録として自由記述メモを入力・保存できる(要 admin/readwrite ロール。アーカイブ表示では閲覧のみ)。検索対象にも含まれる
- **登録日検索**: アップロード日時のFrom〜Toで絞り込み。初期表示は「2か月前 〜 (Toは空欄)」
- **週単位グルーピング**: 一覧はアップロード週(日曜始まり)で `YYYY-MM-DD ~` 見出しにまとめ、新しい週が上に来る
- **画面切り替えメニュー**: パンくずバーに「文書一覧 / タグ体系 / アーカイブ」のメニューを常設し、現在の表示をハイライトする(アーカイブは admin/readwrite ロールのみ表示)
- **アーカイブ・復元(Gmail風の論理削除)**: 「削除」ではなく`documents.deleted_at`/`deleted_by`を立てるだけの論理削除で、実ファイルは残す。「アーカイブ」メニューで通常の文書一覧と同じ画面(検索・週単位一覧・プレビュー)のままアーカイブ済み文書の一覧に切り替えられ、いつでも元に戻せる
- **タグ体系(タグツリー表示)**: 「タグ体系」メニューで、通常の週単位一覧とは別に、タグ名を見出しにしたグループ表示へ切り替えられる(検索・日付絞り込み・アップロードはこの画面では行わない)。表示対象のタグと並び順は`tag_order`テーブルで管理し(`GET/PUT api/tag_order`。並び順の変更はadminロール限定)、画面内の「タグ体系を管理」ボタンから追加・並び替え(上下ボタン)・削除ができる。複数のタグを持つ文書は該当する全グループに重複表示され、登録していないタグしか持たない文書は「未分類」として末尾にまとめられる
- **リアルタイム更新**: SSE (`GET api/documents/events`) で他クライアントのアップロード/削除を検知し、一覧を自動更新する
- **アクセスログ・監査ログ**: 標準出力に、全リクエストのアクセスログ(method/url/status/所要時間/接続元IP/ログイン中ユーザー)と、アップロード/ダウンロード/削除を行った実行者を記録する監査ログ(`"msg":"audit"`)を出力する

### 認証・アクセス制御
- **OIDC (OpenID Connect)**: `openid-client` によるDiscoveryベースの実装。`OIDC_ISSUER` を差し替えるだけで、EntraID / AWS Cognito / Synology SSO Server など標準的なOIDCプロバイダに対応できる(同時に使えるのはどれか1つ)
  - Authorization Code Flow + PKCE + state + nonce
  - id_tokenの署名検証(JWKS)・iss/aud/exp検証は `openid-client` が行う
- **ログインセッション**: `express-session` でブラウザのログイン状態を管理し、OIDCプロバイダが発行するaccess_token/refresh_tokenのTTLには依存しない(短命なトークンでも `SESSION_MAX_AGE_HOURS` の間ログイン状態を維持する)
- **未ログイン時の自動リダイレクト**: 未ログイン状態でアクセスすると、画面操作なしで即座にOIDCプロバイダのログイン画面へ遷移する。文書の別ウィンドウプレビュー(`api/documents/:id/viewer`)を未ログイン状態で開いた場合も同様にログイン画面へ迂回し、ログイン完了後に元のURLへ自動的に戻る(`/login?next=...`。自ドメイン配下の相対パス以外は受け付けずオープンリダイレクトを防止)
- **認証判定のログ**: ログイン(コールバック)のたびに、入力メールアドレスの正規化結果・`ADMIN_EMAIL`との一致有無・ホワイトリストの一致行・ブートストラップ発動の有無・最終的なロールを`"msg":"::login:auth_check"`としてログ出力する。許可/拒否どちらの場合も出力されるため、意図通りに判定されているか標準出力から確認できる
- **アクセス許可ユーザー(ホワイトリスト)とロール**: ホワイトリストに登録されたメールアドレスのみログイン可能で、0件の間は誰もログインできない(常に閉じている)。ロールは3種類: `admin`(ホワイトリストの追加・削除・ロール変更が可能) / `readwrite`(文書の追加・削除・タグ編集が可能) / `readonly`(閲覧のみ)。`ADMIN_EMAIL` は常設の特別アカウントではなく、**adminロールのユーザーが1人もいない場合にだけ働く自己修復型のブートストラップ**で、該当メールアドレスでのログイン試行時に自動的にadminとして登録される(誤って全adminを削除してもロックアウトしない)
- **APIキー(マシン間認証)**: ブラウザの対話的ログインを経ずに `Authorization: Bearer <キー>` でapiを呼び出せる。ログイン済みユーザーが自分名義で発行・失効でき、そのキー経由の操作は発行者本人の名義で記録される
  - キーには必ず有効期限がある(無期限キーは発行不可)。選択肢は「当日限り」(`now+12時間`と「翌日02:00(JST)」の早い方。チャット等に貼り付けて使う一時利用向け)/「30日」/「90日」
  - キーには発行時にreadonly/readwriteいずれかのロールを固定で持たせる(adminロールのキーは発行不可)。選べるのは発行者自身のロール以下のみで、権限判定は発行者の"現在の"ロールではなく常にキーに記録されたロールを見る(発行者が後で昇格/降格しても既存キーの権限は変わらない)
  - 期限切れキーでの認証は401(「APIキーの有効期限が切れています」と明示)、有効なキーでもreadonlyロールでの書き込み系API呼び出しは403になる
  - 発行直後の画面から、キー本体のコピーとは別に「AIチャット貼り付け用」のテキスト(接続情報・エンドポイント一覧・実際のキーを埋め込んだ利用ガイド)もコピーできる
- **開発用バイパス**: `AUTH_DISABLED=true` で認証を丸ごと無効化できる(本番では未設定のこと)

### セキュリティ
- **表示時のエスケープ**: ファイル名・タグ・アップロード者名・許可ユーザーのメールアドレス・APIキーのラベル等、書き込み権限を持つ利用者が自由入力できる値は、フロントエンドで`escapeHtml()`を通してから画面に描画する(HTMLタグとしての解釈も属性値からの脱出も防ぐ)。書き込み権限のある利用者(またはAPIキー)が悪意あるファイル名・タグを登録しても、それを閲覧した他の利用者のブラウザ側でスクリプトは実行されない
- **レート制限**: `api/*` 全体に5分間300リクエスト/IP、`/login` に15分間20リクエスト/IPの上限を設ける(`express-rate-limit`)。超過時は429を返す。未認証・認証済みを問わず、連打によるリソース消費や総当たりを緩和する
- **アップロードサイズ上限**: 1ファイル`UPLOAD_MAX_BYTES`(既定256MB)まで。超過時は413を返す。認証チェック(`requireAuth`/`requireWrite`)をmultipartパース(`express-fileupload`)より先に行う構成のため、未認証のリクエストはファイル本体の読み取りが始まる前に401/403で弾かれる(サイズ判定にすら到達しない)

### AI連携ヘルプ
- 画面右上のヘルプアイコンから、Claude Desktop・Antigravity等のデスクトップAIにこのAPIの使い方を教えるためのMarkdown(接続情報・エンドポイント一覧・curl例)を表示・コピーできる。ベースURLは実際のアクセス元(`location.href`)から動的に算出するため、リバースプロキシ配下の `BASE_PATH` にも自動的に対応する

## ディレクトリ構成

```
document-manager/
├── Dockerfile              # 単一ステージ (node:22-alpine, npm install)
├── app/                     # アプリケーション本体 (Dockerイメージにコピーされる)
│   ├── server.js             # エントリポイント
│   ├── lib/
│   │   ├── db.js              # SQLite初期化・スキーマバージョン管理 (documents/document_tags/api_keys/allowed_users/tag_order)
│   │   ├── oidc-client.js     # OIDC Discovery + Configuration初期化
│   │   ├── api-keys.js        # APIキーの発行/検証/失効
│   │   ├── allowed-users.js   # ログイン許可ユーザーのホワイトリスト管理
│   │   ├── tag-order.js       # タグ体系(タグツリー表示)の並び順管理
│   │   ├── storage.js         # 文書ファイルの保存先抽象化 (ローカルディスク/S3。STORAGE_BACKENDで切替)
│   │   └── logger.js          # 共通ロガー (標準出力のみ)
│   └── static/index.html     # フロントエンド(単一HTML)
└── data/                     # 実行時にマウントされる永続化ボリューム (Dockerイメージには含めない)
    ├── documents/<年月>_<UUID>/  # 文書本体 (元ファイル + 変換後preview.html)
    └── db/document_manager.sqlite
```

## 環境変数

| 変数名 | 既定値 | 説明 |
| --- | --- | --- |
| `LISTEN_PORT` | `8080` | Listenポート |
| `BASE_URL_PATH` | `/` | Express内部のルーティングprefix(通常は変更不要。リバースプロキシがprefixを剥がして転送する前提) |
| `BASE_PATH` | `/document_management` | 外部公開時のパスprefix。ログイン/ログアウト/ホームの遷移先の組み立てに使用 |
| `DATA_DIR` | `/data` | DBの保存先。`STORAGE_BACKEND=local`の場合は文書ファイルもここに保存される |
| `STORAGE_BACKEND` | `local` | 文書ファイルの保存先。`local`(ディスク)または`s3`。切り替えは今後の保存先を変えるだけで、既存ファイルの自動移行は行わない |
| `S3_BUCKET` | (STORAGE_BACKEND=s3の場合必須) | 保存先のS3バケット名 |
| `S3_REGION` | (STORAGE_BACKEND=s3の場合必須) | S3バケットのリージョン |
| `S3_PREFIX` | `documents` | S3オブジェクトキーのプレフィックス(`<prefix>/<文書ID>/<ファイル名>`) |
| `S3_ENDPOINT` | (未設定) | MinIO等のS3互換サービスに接続する場合のエンドポイントURL。未設定時は実AWS S3に接続する |
| `LOG_LEVEL` | `info` | ログレベル (pino) |
| `AUTH_DISABLED` | (未設定) | `true` で認証を丸ごとバイパスする開発用フラグ。本番では未設定のこと |
| `OIDC_ISSUER` | (必須) | OIDCプロバイダのissuer URL。例: `https://login.microsoftonline.com/<TENANT_ID>/v2.0`(EntraID)、`https://cognito-idp.<REGION>.amazonaws.com/<USER_POOL_ID>`(Cognito) |
| `OIDC_CLIENT_ID` | (必須) | クライアントID |
| `OIDC_CLIENT_SECRET` | (空文字) | クライアントシークレット。パブリッククライアントの場合は未設定でよい |
| `OIDC_REDIRECT_URI` | (必須) | コールバックURL。プロバイダ側にも同じ値を登録すること |
| `OIDC_SCOPE` | `openid profile email` | 要求スコープ。プロバイダのアプリクライアントで許可されているものに合わせること(EntraIDでrefresh_tokenが必要な場合は `offline_access` を追加。ただし本アプリはaccess_tokenのTTLに依存しないため通常は不要) |
| `OIDC_USERNAME_CLAIM` | `email` | ユーザー識別子として使うid_tokenのクレーム名 |
| `SESSION_SECRET` | (ランダム生成) | ログインセッションの署名鍵。未設定だとコンテナ再起動のたびに全セッションが無効になる |
| `SESSION_MAX_AGE_HOURS` | `8` | ログインセッションの寿命(時間) |
| `ADMIN_EMAIL` | (未設定) | adminロールのユーザーが1人もいない場合にだけ、ログイン時に自動でadminとして登録される自己修復用のメールアドレス。常設の特別枠ではない |

S3の認証情報は、AWS SDKの標準クレデンシャルチェーン(ECSタスクロール/EC2インスタンスロール等のIAMロールを優先し、未設定時は`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`環境変数や共有設定ファイルにフォールバック)にそのまま従う。アプリ側で個別の環境変数は用意していない。

## ローカル動作確認

```bash
cd app
npm install
AUTH_DISABLED=true DATA_DIR=../data node server.js
```

`http://localhost:8080/` にアクセスすると、認証なし(`dev-user`)で操作できる。

## Dockerビルド・起動

```bash
docker build -t document-manager .

docker run -d \
  --name document-manager \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e OIDC_ISSUER="https://login.microsoftonline.com/<TENANT_ID>/v2.0" \
  -e OIDC_CLIENT_ID="<CLIENT_ID>" \
  -e OIDC_CLIENT_SECRET="<CLIENT_SECRET>" \
  -e OIDC_REDIRECT_URI="https://your-domain.example.com/document_management/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="<ランダムな文字列>" \
  document-manager
```

環境変数の詳細は上記「環境変数」の表を参照。`OIDC_*`系は利用するIDプロバイダ(EntraID/Cognito/Google等)の値に置き換えること。

## DockerHubから利用する

ビルド済みイメージは [earce9000/document-manager](https://hub.docker.com/r/earce9000/document-manager) として公開している(`linux/amd64`/`linux/arm64`対応)。`main`ブランチへのpushのたびに、`latest`と`YYYYMMDD_HHmmss`(JST、ビルド日時)タグが自動的にビルド・公開される([.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml))。特定時点のビルドに固定したい場合は日時タグでpullする。

```bash
docker pull earce9000/document-manager:latest

docker run -d \
  --name document-manager \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e OIDC_ISSUER="https://login.microsoftonline.com/<TENANT_ID>/v2.0" \
  -e OIDC_CLIENT_ID="<CLIENT_ID>" \
  -e OIDC_CLIENT_SECRET="<CLIENT_SECRET>" \
  -e OIDC_REDIRECT_URI="https://your-domain.example.com/document_management/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="<ランダムな文字列>" \
  earce9000/document-manager:latest
```

`Dockerfile` は `node:22-alpine` ベースの単一ステージ構成。`better-sqlite3` はprebuiltバイナリを同梱しているため、ビルドツール(python3/make/g++)は不要。**npmでインストールすること**(yarn classicはprebuiltバイナリの検出ロジックを持たず、常にソースビルドを試みて失敗する)。
