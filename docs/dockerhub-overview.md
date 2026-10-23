<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager) の
"Repository overview" へ貼り付ける説明文。機能を追加したらここも更新し、Docker Hub側へ反映する。
貼り付けるのは、このコメントより下の本文すべて。

短い説明(Description)欄には次の1行を使う。Docker Hub側の上限は100文字なので、
書き換えるときは必ず文字数を数えること(超えると入らない)。
Self-hosted document manager: versions, tags, full-text/semantic search, Miro export, AI agent API.

画像はGitHub(raw.githubusercontent.com)の公開URLを参照している。スクリーンショットを
撮り直した場合(npm run screenshots)は、pushすればDocker Hub側の表示も自動的に新しくなる。

**本文(このコメントより下)は 25,000 バイトまで。** 超えると Docker Hub が受け付けない
("Exceeded max number of bytes 25000")。足すときは同じだけ削ること。大きさは test/html-pdf.test.js が見張っている。
細かい説明は GitHub の README や、変換サービス側のページ(docs/dockerhub-pdf-converter-overview.md)へ回す。

ロゴは docs/logo-128.png(Docker HubはSVGを画像として出さないため、app/static/logo.svg から
書き出したPNG。角の外は透過)。大きさを指定できないので、表示したい大きさ(128px)で作ってある。
docs/logo.png は同じ絵の512px版(紹介ページ以外で使う用)。ロゴを変えたら両方作り直す。
-->

![Document Manager](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/logo-128.png)

# Document Manager

*Self-hosted document management service for single-file documents (HTML / MHTML / Markdown / PDF / images /
CSV / TSV / text / log / JSON / draw.io / Excel / Word / PowerPoint). Versioning, tagging, projects with
annotated contents lists, sandboxed hosting of web-page mockups, full-text and semantic search, export to
Miro boards, and a token-authenticated REST API designed for AI agents. Documentation below is in Japanese; see the
[GitHub repository](https://github.com/EARCE9000/document-manager) for details.*

## どんなシステムか

社内の資料を1か所に集めて、探して、そのままブラウザで読むためのドキュメント管理サービスです。
Node.js (Express) 製で、このイメージを起動するだけで動きます。

扱うのは「1ファイルで完結する文書」です。設定ファイル(YAML・XML・TOML・INI)、字幕・文字起こし(SRT・VTT)、
テキストで書く図(Mermaid・PlantUML・Graphviz)、手順のスクリプト(.sh・.ps1)もそのまま置けて、中身は全文検索の
対象になります。**Mermaid(.mmd)はテキストのままではなく図として描画します**(公式のライブラリを同梱しているため、
外部へは出ません)。主なものは HTML / MHTML / Markdown / PDF / 画像(SVG・PNG・JPEG) /
CSV・TSV / テキスト・ログ / JSON / draw.io / Excel・Word・PowerPoint に対応していて、どれも
ダウンロードせずにブラウザ上でそのまま閲覧できます。Markdown や MHTML はサーバー側で見やすい形に
変換し、PDF はブラウザ標準のビューアで開きます。Markdown の表は途中で折り返さずに表示し、
手順書に貼られたコマンドは**ボタン1つでコピー**できます。draw.io は公式ビューアを同梱しており、図をそのまま
描画します(画像を別途用意する必要はありません)。Excel・Word・PowerPoint は**内容の概要**
(シートの表・見出しと段落・スライドごとの本文と発表者ノート)を表示し、中身の文字は全文検索の
対象になります(この概要表示では書式・図・グラフは再現しません)。

レイアウトも見たい場合は、**変換サービス**(別イメージ `earce9000/document-manager-converter`)を
併せて起動すると、PDFでも開けるようになります。ただし LibreOffice による変換のため**忠実な再現では
ありません**(フォントの字幅の違いで行の折り返しやページ数がずれることがあります)。
「だいたいの体裁と、どこに何があるか」を掴む用途で、細かいところは原本をダウンロードして
確認してください。変換サービスは任意で、無くても文書の登録・検索・概要表示には影響しません。

HTML や Markdown の資料を**メールなどで人に渡す**ための **「PDFでダウンロード」** もあります
(HTML をそのまま添付すると、相手の環境では文字の羅列として出てしまうことがあるため)。
**PDF変換サービス**(別イメージ `earce9000/document-manager-pdf-converter`)を併せて起動すると、
HTML・Markdown・MHTML・draw.io の文書を、**プレビューの見た目のまま**PDFにして保存できます。
A4 には区切らないので表や図が途中で切れず、横に長い表はページを右へ広げて入れます。
フォントは BIZ UDゴシックで描くため行の折り返しが少しずれることがあり、**外部のサイトに置かれた
画像は入りません**(該当するときは保存時に知らせます)。

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

**「おしながき」で案件の資料を人に渡せます。** 資料を集めても、ファイル名だけでは受け取った側が
全部開くことになります。プロジェクト名をクリックすると、その案件にどんな資料が揃っていて
**それぞれが何なのか**を1枚にした一覧が出ます。資料ごとの説明はその場で書け、フォルダは章の
見出しになります。そのままMarkdownでコピーできるので、引き継ぎ・レビュー依頼・打ち合わせの
資料としてメールや議事録に貼れます。

説明は**プロジェクトごとに持ちます**。同じ設計書でも「A案件では前提資料、B案件では参考」と
書き分けられます。

案件が仕上がったら、南京錠で**ロック**して画面からもAIからも編集できなくできます。

![おしながき](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/project-manifest.png)

**人に渡すリンクは、更新しても変わりません。** 「常に最新版を指すリンク」を渡しておけば、あとで差し替えても
相手は最新を見られます。版を固定したリンクも1クリックでコピーできます。

**削除はありません。** 「アーカイブ」は Gmail と同じ論理削除で、実ファイルは残り、いつでも元に戻せます。
誰が何をしたかは操作履歴に残り、他の利用者がアップロードやタグ付けをすると、画面の右下に小さな通知が出ます。

![操作履歴](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/history.png)

**Webページのモックアップを、そのまま動かして確認できます。** LLMなどで作った画面案の一式を
ZIPでアップロードすると、別ウィンドウで**実際に動く状態**で開けます(JavaScriptも動きます)。
React のようにJSが画面を組み立てるものでも構いません。文書とは別のコレクションとして管理し、
版を重ねると古い版は自動でアーカイブされ、版履歴から辿れます。一覧は最後に触ったものが左上に来ます。サンプルのExcelやPDFを同梱して
ダウンロードさせることもできます。

![モックアップ管理](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/mockups.png)

安全のため、モックアップは**このアプリから切り離した状態**で配信します。ブラウザから見ると
モックアップのページは「どこのサイトでもない」扱いになり、**このアプリの文書やAPI、ログイン情報には
一切手が届きません**。アップロードされたJavaScriptが、見ている人の権限で勝手に操作することは
できない、ということです。ZIPの展開時にも、決められた置き場所の外へ書き出そうとするものや、
極端に膨らむように細工されたものは受け付けません。

なお**この機能は既定では無効**です。使う場合は、管理画面(右上の歯車)→「サーバー」タブから
有効にしてください(再起動は要りません)。ファイルの置き場所は問いません(S3・GCSでも使えます)。

**検索**は、ファイル名・タグ・メモ・本文を対象にした部分一致検索が標準です。日本語でも単語の区切りを
気にせず探せます。**スペースで区切ると、すべてを含む資料だけに絞り込めます**(全角スペースでも構いません)。
語ごとに当たる場所は違っていてよいので、「請求書 2026年度」のようにファイル名とタグにまたがる指定もできます。
加えて、Weaviate を併せて起動すると**意味検索**(言い換えや表記ゆれを含めて近い資料を探す)も使えるようになります。

**ログイン**は OpenID Connect です。Entra ID・Cognito・Google・Synology SSO など、標準的なプロバイダなら
設定を差し替えるだけで使えます。利用できるのは許可リストに登録された人だけで、権限は管理者・読み書き・
閲覧のみの3種類です。

**AIエージェントから使えます。** ブラウザを介さずに呼べる API キーを画面から発行でき(有効期限は最長1年)、API の仕様は
`GET api/openapi.json`(機械可読)と `GET api/usage.md`(説明文)で取得できます。Claude Code・OpenAI Codex・
Google Antigravity 用の Skill も画面からダウンロードでき、「この資料アップして」「前の版を置き換えて」
「〜を探して」と話しかけるだけで操作できるようになります。

**上で紹介したモックアップとおしながきも、AIから操作できます。** モックアップはもともとAIが作るものなので、
「この画面案をアップして」と言えば、作ったページ一式をそのまま登録し、開くためのURLを返します
(フォルダを渡すだけでよく、ZIPに固める必要はありません)。おしながきも「この案件の資料一覧ちょうだい」で
そのまま受け取れます。

**Miro のボードに書き出せます(任意)。** 打ち合わせで使う Miro のボードに、資料を並べて出します。書き出すのは
頼まれたときだけで、ボードが知らないうちに変わることはありません。ボードに置いた目印の付箋(`[DM]名前` と向き)の
横に、書き出すたびに新しいフレームを作って並べます(向きは8方向と十字)。
前に出したフレームには触りません。PDF・画像はそのまま、HTML・Markdown・draw.io は PDF に、Office は体裁つきの
PDF にして出し、各資料に「Document Manager で開く」リンクを付けます。AIエージェントに「この資料を Miro に
書き出して」と頼むか、プレビューのアイコンから1件ずつ出します。画面の上の「Miro」で目印を置き、書き出しの履歴を見られます。

![Miro](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/miro.png)

![AIエージェント用Skillの配布](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/tools.png)

**構成は後から変えられます。** 既定では1コンテナで完結し、文書のメタデータは SQLite、ファイルは
ローカルディスクに保存します。環境変数を変えるだけで、メタデータを PostgreSQL に、ファイルを S3 や
GCS に移せるので、AWS(ECS/Fargate)や GCP(Cloud Run / GKE)で複数インスタンス構成にもできます。
モックアップの原本(ZIP)も S3・GCS に置けます。

## 構成

![システム構成](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/architecture.png)

**2つの変換サービス(converter / pdf-converter)と Weaviate / 推論サーバーは、どれも任意**です。
無くてもアプリは動き、該当する機能だけが使えなくなります。単一コンテナだけで動かすこともできます。

変換サービスは信用できない文書を開くため(LibreOffice / Chromium)、**インターネットにも他の
サービスにも出られない専用ネットワークに、別々に閉じ込めています**(読み取り専用・作業場所はメモリ上の
一時領域・非root・メモリ上限)。細工された文書に任意のURLを叩かせないためです。

## 管理画面(管理者のみ)

画面右上の歯車から開きます。サーバーにログインせずに「異常が無いか」「次に何をすべきか」を
判断できることを目的にしています。

- **サーバー**: 版・ビルド時刻・起動時刻・稼働時間・DBファイルの一覧。更新したはずなのに
  ビルド時刻が変わっていなければ、新しいイメージに入れ替わっていないと分かります
- **データベース**: 破損の検知(起動のたびに自動で確認)と、**DBと実ファイルの照合**。
  ファイルだけ残っている文書は登録し直せます。逆に**ファイルが見つからない文書の記録は消しません**
  (ストレージが一時的に見えていないだけの可能性があり、消すとタグ・メモ・版の紐付けまで失うため)
- **変換サービス**: 2つの変換サービスが動いているか、変換に失敗した文書はあるか(その場で再実行できます)
- **Miro 連携**: Miro との連携と、書き出すボードの選択
- **アクセス許可ユーザー**: ログインできる人とその権限の管理
- **セッション**: 不正アクセスが疑われるときに、利用者のセッション・APIキー・モックアップの表示を
  **まとめて切断**できます(パスワードが漏れているなら、認証基盤側での変更も必要です)

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

### 3. 最初のログイン

**許可リストが空の間は誰もログインできません。** そこで `ADMIN_EMAIL` が働きます。管理者が1人もいない間に
限り、そのアドレスでログインした人が自動的に管理者として登録されます。常設の特別扱いではないため、
管理者を全員削除してしまっても締め出されません。

最初のログイン後、画面右上の利用者アイコンから、使う人のメールアドレスを許可リストへ追加してください。
権限は、管理者(admin)・読み書き(readwrite)・閲覧のみ(readonly)から選べます。

### 4. リバースプロキシの後ろに置く場合

公開するパスを `BASE_PATH` に設定します。ホスト全体をこのサービスに使うなら `/`、
サブパスで公開するなら `/document_management` のように指定します。`OIDC_REDIRECT_URI` も
公開URLに合わせてください。

画面の自動更新に Server-Sent Events を使うので、プロキシの応答の溜め込みは無効にしてください
(Apache なら `flushpackets=on`。nginx 向けにはアプリが `X-Accel-Buffering: no` を返します)。

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
    image: docker.io/semitechnologies/weaviate:1.36.24
    restart: always
    environment:
      AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: "true"
      PERSISTENCE_DATA_PATH: /var/lib/weaviate
      ENABLE_MODULES: text2vec-transformers,text2vec-cohere,text2vec-openai,text2vec-aws
      API_BASED_MODULES_DISABLED: "true"   # ENABLE_MODULES の物だけにする(v1.33 から、ほかの外部連携モジュールが既定で有効)
      DISABLE_TELEMETRY: "true"
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

登録済みの文書は起動後に順に索引付けされます(進み具合は画面の「ベクトル索引」)。推論サーバーは 1.0〜1.4GB ほどのメモリを使います。

podman 用の構成は [`deploy/compose.yml`](https://github.com/EARCE9000/document-manager/blob/main/deploy/compose.yml) にあります。

### 6. PDFでダウンロードを使う場合

Miro に HTML・Markdown・draw.io を書き出すときも、この変換を使います。
PDF変換サービス(`earce9000/document-manager-pdf-converter`)を**外へ出られないネットワーク**に起動し、
アプリに `HTML_PDF_URL`(例: `http://pdf-converter:3000`)を渡します。**ポートは公開しないでください**
(認証を持ちません)。compose の例・安全面の考え方・更新の仕方は
[変換サービスのページ](https://hub.docker.com/r/earce9000/document-manager-pdf-converter)にあります。

### 7. Miro に書き出す場合

Miro の開発者ハブでアプリを作り(権限は `boards:read` と `boards:write`)、クライアントIDとシークレットを
`MIRO_CLIENT_ID` / `MIRO_CLIENT_SECRET` で渡すか、管理画面の「Miro 連携」に入力します。管理者が1回連携し、
書き出すボードを選べば使えます。サーバーから `api.miro.com` へ出られる必要があります。
手順は [docs/miro.md](https://github.com/EARCE9000/document-manager/blob/main/docs/miro.md) にあります。

### 8. 主な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `OIDC_ISSUER` | (必須) | OpenID Connect の issuer URL |
| `OIDC_CLIENT_ID` | (必須) | クライアントID |
| `OIDC_CLIENT_SECRET` | (空) | クライアントシークレット(パブリッククライアントなら不要) |
| `OIDC_REDIRECT_URI` | (必須) | コールバックURL。プロバイダ側にも同じ値を登録する |
| `ADMIN_EMAIL` | (未設定) | 管理者が1人もいない間だけ働く、自己修復用のアドレス |
| `SESSION_SECRET` | (ランダム) | セッションの署名鍵。必ず固定値を指定する |
| `SESSION_MAX_AGE_HOURS` | `16` | ログインセッションの寿命(時間)。ログイン時点からの絶対時間で、操作しても延びない |
| `BASE_PATH` | `/document_management` | 公開時のパスprefix |
| `DATA_DIR` | `/data` | SQLite とローカル保存時の文書ファイルの置き場所。モックアップを使う場合は、保存先がS3でも展開した控えがここに置かれます(失われても原本から作り直されます) |
| `DATABASE_BACKEND` | `sqlite` | `sqlite` / `postgres`(複数インスタンス構成では必須) |
| `DATABASE_URL` | (未設定) | PostgreSQL の接続文字列(標準の `PG*` 変数でも可) |
| `STORAGE_BACKEND` | `local` | `local` / `s3` / `gcs` |
| `HTML_PDF_URL` | (未設定) | PDFでダウンロード(HTML・Markdown・MHTML・draw.io→PDF)の変換サービスのURL。未設定ならこの機能は無効(画面にボタンが出ないだけ) |
| `OFFICE_RENDER_URL` | (未設定) | 体裁つき表示(Office→PDF)の変換サービスのURL。未設定ならこの機能は無効(概要表示だけになります) |
| `WEAVIATE_URL` | (未設定) | 設定すると意味検索が有効になる |
| `UPLOAD_MAX_BYTES` | `268435456` | 1ファイルのアップロード上限(256MB)。超過時は413 |
| `CONTENT_TEXT_MAX_CHARS` | `300000` | 検索用に保存する本文の上限。超過分は検索対象外(ファイル自体は全て保存される) |
| `MOCKUPS_ENABLED` | (未設定=無効) | モックアップ機能の既定値。管理画面からも切り替えられます |
| `MOCKUP_MAX_TOTAL_BYTES` | `314572800` | モックアップZIPの展開後の合計サイズの上限(300MB) |
| `MOCKUP_STORAGE_PREFIX` | `mockups` | S3/GCS利用時に、モックアップの原本を置くキーの先頭。文書側(既定 `documents`)とは必ず別にしてください |
| `MOCKUP_VIEW_TOKEN_MINUTES` | `60` | モックアップを開いていられる時間(分)。切れても開き直せます |
| `PROJECT_NOTE_MAX_CHARS` | `500` | おしながきの説明書き1件の上限(文字数) |
| `MIRO_CLIENT_ID` / `MIRO_CLIENT_SECRET` | (未設定) | Miro のアプリの値。未設定なら管理画面で入力した値を使う |
| `AUTH_DISABLED` | (未設定) | `true` で認証を無効化(開発用。本番では使わない) |
| `RATE_LIMIT_DISABLED` | (未設定) | `true` でレート制限を無効化(開発・テスト用。本番では使わない) |
| `LOG_LEVEL` | `info` | ログレベル |
| `TZ` | `Asia/Tokyo` | タイムゾーン |

S3 の認証情報は AWS SDK の標準の取得順(IAMロール優先)、GCS は Application Default Credentials に従います。
全変数の一覧は GitHub の README にあります。

### 9. データの扱いと更新・切り戻し

`/data` をマウントしておけば、文書・モックアップと SQLite のデータベースはそこに残ります。

SQLite のスキーマを上げるときは、**新しいファイルにデータを移し、古いファイルは残します**(古いイメージへ戻せるように)。
更新前に `/data/db` のバックアップを取ってください。戻すと、更新後に登録した文書は見えません。

PostgreSQL 構成の場合、スキーマの更新は起動時に自動で適用されます。

タグは `latest`(最新)と、ビルドした日時の `YYYYMMDD.HHMM`(JST。直近10世代を残す)です。
切り戻しは日時のタグを指定します。amd64 と arm64 に対応しています。

## ライセンス

MIT

ソースコードと詳しいドキュメント: https://github.com/EARCE9000/document-manager
