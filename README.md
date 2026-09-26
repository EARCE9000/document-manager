# WebService_DocumentManager

HTML / MHTML / Markdown / PDF / 画像(SVG/PNG/JPEG) / CSV・TSV / テキスト・ログ / JSON / draw.io / Excel・Word・PowerPoint をアップロードして一覧・プレビューできる社内向けドキュメント管理Webサービス。
版管理(新しい版のアップロードと版履歴)、タグ・プロジェクトによる整理、全文検索/セマンティック検索、Claude Code・Codex・Antigravity 等のAIエージェントからAPIで登録・検索するための Skill を備える。
文書とは別に、**ビルド済みのWebページ一式(ZIP)を登録して別ウィンドウで動かせる「モックアップ管理」**と、プロジェクトの資料に説明書きを付けて一覧にする**「お品書き」**も持つ。
Node.js (Express) 製。既定では単一コンテナ(メタデータはSQLite、文書ファイルはローカルディスク)で動くが、メタデータDBを PostgreSQL、文書ファイルを S3 / GCS に切り替えることで、AWS(ECS/Fargate)や GCP(Cloud Run / GKE)のマネージド環境・複数インスタンス構成でも動作する(切り替えは環境変数のみ。詳細は「[マルチクラウド構成の要点](#マルチクラウド構成の要点)」)。

## システム構成

![システム構成](docs/architecture.png)

図は[deploy/compose.yml](deploy/compose.yml)の構成(運用サーバ向け)。**変換サービス(converter)とWeaviate/推論サーバーはどちらも任意**で、
無くてもアプリは動く(体裁つき表示・意味検索だけが使えなくなる)。単一コンテナだけで動かすこともできる。
図の元データは[docs/architecture.svg](docs/architecture.svg)(構成が変わったらこちらを直してPNGを作り直す)。

## スクリーンショット

| 文書一覧・プレビュー(版履歴) | タグ体系(draw.io のプレビュー) |
|---|---|
| ![文書一覧](docs/screenshots/document-list.png) | ![タグ体系](docs/screenshots/tag-tree.png) |

| プロジェクト | プロジェクトのお品書き |
|---|---|
| ![プロジェクト](docs/screenshots/projects.png) | ![お品書き](docs/screenshots/project-manifest.png) |

| モックアップ管理 | 操作履歴 |
|---|---|
| ![モックアップ](docs/screenshots/mockups.png) | ![操作履歴](docs/screenshots/history.png) |

| APIキー管理・AIエージェント用 Skill |
|---|
| <img src="docs/screenshots/api-keys-skill.png" alt="APIキー管理とAIエージェント用Skill" width="420"> |

画像はダミーのサンプルデータで撮影したもの。画面が変わったら `npm run screenshots`([docs/screenshots/capture.js](docs/screenshots/capture.js))で撮り直せる。

## 主な機能

### 文書管理
- **対応形式**: `.html` / `.htm` / `.mhtml` / `.mht` / `.md` / `.markdown` / `.pdf` / `.svg` / `.png` / `.jpg` / `.jpeg` / `.csv` / `.tsv` / `.txt` / `.log` / `.json` / `.drawio` / `.xlsx` / `.xlsm` / `.docx` / `.docm` / `.pptx` / `.pptm`(実体は単一ファイル、1ファイル256MBまで。`.drawio`は画像を用意しなくてもそのままプレビューできる)
- **保存先の切り替え**: 文書ファイルの実体は`STORAGE_BACKEND`環境変数でローカルディスク(既定)/S3(AWS)/GCS(Google Cloud Storage)を切り替えられる。アップロード・プレビュー変換・全文抽出・配信のすべてが共通のストレージ抽象層([lib/storage.js](app/lib/storage.js))経由になっており、S3/GCSモードでもアプリを経由してストリーミング配信(Range対応)するため認証・監査ログの挙動は変わらない。モード切替は「今後の保存先」の変更のみで、既存ファイルの自動移行は行わない
- **メタDBの切り替え**: 文書メタデータ・タグ・プロジェクト・APIキー・ホワイトリスト・操作履歴・セッションを格納するDBは`DATABASE_BACKEND`環境変数でSQLite(既定・単一コンテナ向け)/PostgreSQL(RDS/Aurora, Cloud SQL/AlloyDB等)を切り替えられる。全DBアクセスが非同期の抽象層([lib/datastore.js](app/lib/datastore.js))経由のため、アプリロジックはバックエンドを意識しない。Postgresを選ぶとセッションもDBで共有され、複数インスタンスでの水平スケール(ECS/Cloud Run)に対応する
- **プレビュー**
  - html/htm: ブラウザがネイティブに描画できるためそのまま表示
  - mhtml/mht: `mhtml-to-html` で単一HTMLに変換して表示(ブラウザのネイティブmhtmlレンダリングは不安定なため)
  - md/markdown: `marked` でHTMLに変換して表示(ソースのままだと読みにくいため)
  - pdf: iframe埋め込みはせず、プレビュー画面中央に「別ウィンドウで開く」ボタンを表示する(Chromeは`sandbox`付きiframe内での内蔵PDFビューアの読み込みを`net::ERR_BLOCKED_BY_CLIENT`としてブロックすることがあるため、ブラウザのネイティブPDFビューアが確実に使える新しいタブでの表示に統一している)
  - svg/png/jpg/jpeg: ブラウザがネイティブに描画できるためそのまま表示(全文検索の対象にはならない。svgに埋め込まれたスクリプトは`sandbox`属性により実行されない)
  - csv/tsv: 1行目をヘッダーとしてHTMLテーブルに変換して表示(生テキストのままだと列が揃わず読みにくいため)
  - txt/log/json: ブラウザがネイティブに描画できるためそのまま表示(jsonはChrome/Firefox標準の折りたたみ可能なビューアが`sandbox`付きiframe内でも問題なく動作する)
  - drawio: サーバ側では画像化せず、**draw.io公式のビューア(`app/static/vendor/drawio/viewer-static.min.js`。Apache-2.0)を同梱し、ブラウザ上でXMLをそのまま描画する**。画像化を挟まないため図の大きさ・図形数に左右されず(実測: 4,000セル・731KBのXMLで約3.7秒)、複数ページの`.drawio`もツールバーのページ送りで切り替えられる。図のXMLは`GET api/documents/:id/file?source=1`で取得する(ダウンロード扱いにはせず監査ログにも残さない)。描画は[app/static/drawio-viewer.html](app/static/drawio-viewer.html)が行い、別ウィンドウ(`api/documents/:id/viewer`)もこのページへリダイレクトする。draw.ioの図はラベルにHTMLを書けるため、このページだけは`script-src 'self'`のCSPを付けて配信し、図に仕込まれたスクリプトが動かないようにしている(スクリプトは全て外部ファイルに分離)。ビューアの既定動作のうち外部(`viewer.diagrams.net`)に関わるものは全て無効化している: stencil・スタイル・数式(MathJax)等の取得先を自ドメイン配下へ差し替え、**図をクリックすると図の中身ごと第三者ページ(ライトボックス)が開く既定動作も止めている**。ページ自体も`default-src 'none'`のCSPで配信するため、取りこぼしがあってもブラウザ側で止まる(回帰は[test/api/preview-xss.e2e.js](test/api/preview-xss.e2e.js)で検証)。アップロード時にプレビュー画像(svg/png)を添えることもでき(同フォルダに `preview.<ext>` として保存)、ビューアで描画できなかった場合の代替として使う。実体(ダウンロード対象)は常に`.drawio`のまま保持する。XML内のページ名・図形ラベルは全文検索の対象になる
  - xlsx/docx/pptx(Excel/Word/PowerPoint): **内容の概要**をHTMLへ変換して表示する([app/lib/office.js](app/lib/office.js))。OOXML(ZIP+XML)を直接読むため外部プロセス(LibreOffice等)も追加の依存も不要で、Excelはシートごとの表(日付書式のセルは日付として表示)、Wordは見出し・段落・箇条書き・表、PowerPointはスライドごとのタイトル・本文・発表者ノートを出す。**この概要プレビューでは元の体裁(フォント・色・セル書式・図形・グラフ・画像)を再現しない**(プレビュー冒頭にその旨を明示する)。体裁ごと確認したい場合は、別イメージの変換サービスを併用するとPDFで開ける(下記「体裁つき表示」)。取り出したテキストはそのまま全文検索の対象になる(表の中身・スライドのノートも含む)。大きな文書は表示を打ち切る(シート300行×50列・3000段落・200スライド。[app/lib/office.js](app/lib/office.js)の`LIMITS`)。ZIP爆弾対策として展開後サイズに上限を設けている。マクロ(`.xlsm`等のvbaProject)は読まず、サーバ側でファイルを開くこともしない。読めない/壊れたファイルはプレビュー不可として登録され、ダウンロードはできる
  - 変換結果は元ファイルと同じフォルダに `preview.html` として保存する。ダウンロードは常に元ファイルを返す
- **体裁つき表示(Office→PDF。任意機能)**: `OFFICE_RENDER_URL`を設定すると、xlsx/docx/pptxを**レイアウトのついたPDF**でも開けるようになる。変換はLibreOfficeを同梱した別イメージ([converter/](converter/)、`earce9000/document-manager-converter`)が行い、アップロード時に非同期で実行する。状態は文書情報の`renderStatus`(`ok`/`pending`/`failed`/`null`=対象外)で分かり、`ok`なら画面の「体裁つきで開く」ボタンと`GET api/documents/:id/file?render=1`から取得できる([app/lib/office-render.js](app/lib/office-render.js))
  - **未設定でも動く**。その場合は従来どおり概要プレビューだけになり、文書の登録・検索・ダウンロードには影響しない。変換サービスが落ちていても同じ(アプリ側は`depends_on`にも入れていない)
  - LibreOfficeを同梱するとイメージが1GBを超えるため、**変換を使わない利用者に負担を強いない**よう別イメージに分けている
  - **忠実な再現ではない**。変換はLibreOfficeが行うため、Microsoft Officeで開いたときと同じ見え方になるとは限らない。特に日本語のMSフォント(MS Pゴシック・メイリオ・游ゴシック等)は同梱のNotoで代替するため字幅が変わり、行の折り返し・はみ出し・ページ数がずれることがある(英字はLiberationがArial/Times等と字幅互換なので崩れにくい)。SmartArt・グラフ・特殊な図形も差が出やすい
  - **用途は「だいたいの体裁と、どこに何があるか」を掴むこと**。細かいところを確認したい場合は原本をダウンロードしてもらう。画面にもその旨を出している
  - Excelは**印刷したときの見え方**になるため、列幅が足りない列は`###`になり文字も途中で切れる(元の文書がそういう体裁であるということ)。全文を確認したい場合は概要プレビューを使う。2つの表示は補い合う関係にある
  - converterは信用できない文書をLibreOfficeで開くため、**専用の内部ネットワークに閉じ込める**(インターネットにも他サービスにも到達できない。読み取り専用・作業場所はtmpfs・非root・メモリ上限)。設定を書いただけでは効いている保証にならないので、実機で確かめる手順を[deploy/check-converter-isolation.sh](deploy/check-converter-isolation.sh)に用意している。詳細は[converter/README.md](converter/README.md)
  - 変換に失敗した文書は`GET api/documents?renderStatus=failed`で一覧でき、`POST api/documents/:id/render/retry`で再実行できる(管理画面からも操作できる)
  - プレビュー用iframe(html/mhtml/md変換結果)は `sandbox` 属性でスクリプト実行を制限する
  - プレビュー右上のアイコンボタンから、ファイルへの直接リンクのコピー・ダウンロードができる
  - リンクのコピー・「別ウィンドウで開く」・一覧の別ウィンドウアイコンは、いずれも `api/documents/:id/viewer` を指す。`api/documents/:id/file`(APIキー連携クライアント向け。未認証時はJSONの401のみを返す)とは別系統で、未ログイン状態でこのURLを開くとログイン画面へ自動的に迂回し、ログイン完了後に元のURLへ戻ってから文書を表示する。他の人にリンクを共有する場合はこちらが使われる
  - プレビュー上部に、ファイル名が似ている他の文書(現在表示中の一覧内、文字3-gramのDice係数で判定)をチップ表示し、クリックでそちらのプレビューに切り替えられる(バージョン違い等の関連文書を見つけやすくする)
- **全文検索**: ファイル名・本文(抽出済みプレーンテキスト)はFTS5(`trigram`トークナイザ)で部分一致検索する。単語分割不要で日本語等CJKにも強いが、3文字未満のクエリはヒットしない制約があるため、その場合は自動的に `LIKE` 検索にフォールバックする。タグ・メモは元々短い文字列のため常に `LIKE` で検索する
  - **索引に載せるのはアーカイブされていない文書だけ**: アーカイブ時に索引から外し、復元時に`documents.content_text`から入れ直す(本文はDBに残るため情報は失われない)。版管理で旧版が増えても索引が肥大しない。アーカイブ済みの検索は索引を使わない走査(SQLiteは`LIKE`、Postgresは`ILIKE`)で行う。Postgresでは本文・ファイル名のGIN trigramインデックスを`WHERE deleted_at IS NULL`の部分インデックスにして同じ効果を得ている
  - **本文の保存量に上限**: 検索用に保存する本文は`CONTENT_TEXT_MAX_CHARS`(既定30万文字)まで。超過分は検索対象外になるだけで、ファイルの登録・プレビュー・ダウンロードには影響しない(ファイル名・タグ・メモは全て検索できる)。上限に達した文書はプレビュー上部にその旨を表示し、APIの応答にも`contentTruncated`/`contentTextMaxChars`が入る。1ファイル256MBまで登録できるため、巨大なログ・CSVを1つ入れただけでDBが数百MB膨らむのを防ぐ
  - **実測(1万件・本文2,000文字/件・7割アーカイブ)**: DBファイル 168MB → **101MB**、全文検索の索引 94MB → **28MB**、通常の全文検索 103ms → **59ms**、アーカイブ検索(索引なしの走査) 76ms。一覧の取得は3,000件で37ms
- **セマンティック検索(任意機能)**: `WEAVIATE_URL`環境変数を設定すると、キーワードの部分一致ではなく言い換え・表記ゆれを含めて意味的に近い文書を検索できるようになる(`GET api/documents/search/vector?q=...`)。ベクトルDBには[Weaviate](https://weaviate.io/)(OSS)を別コンテナで使用する。`WEAVIATE_URL`未設定の間はこの機能自体が無効化され、既存のキーワード検索・文書管理には一切影響しない。文書一覧画面の「セマンティック検索」チェックボックス、またはAPI(`api/documents/search/vector`)から利用できる。詳細は[docker-compose.yml](docker-compose.yml)を参照
  - **Embeddingプロバイダの切り替え**: 既定は自己ホストの`text2vec-transformers`(多言語sentence-transformersモデル、外部APIキー不要)。`text2vec-cohere`(Cohere SaaS、要`COHERE_APIKEY`)・`text2vec-openai`(要`OPENAI_APIKEY`)・`text2vec-aws`(Cohere on AWS Bedrock、要`AWS_BEDROCK_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`)に切り替えると、Weaviateが直接各社のEmbedding APIを呼ぶ構成になり、`t2v-transformers`コンテナは不要になる。認証情報はこのアプリの環境変数からWeaviateへのリクエストヘッダーとして都度渡され、Weaviateコンテナ自体・DBのいずれにも保持させない(AWSの認証情報はECS等のタスク定義でSecrets Managerから環境変数へ注入する構成を想定している)。
    - 既定値は`WEAVIATE_VECTORIZER`環境変数で指定するほか、「ベクトル索引」画面から admin ロールでGUI上書きもできる(`GET/PUT/DELETE api/vector-index/vectorizer`)。選択肢には必要な環境変数が揃っているものだけが選べる状態で表示され(未設定のものは「(未設定)」と表示され選択不可)、GUI自体は認証情報の値を一切扱わない(表示もしない)
    - **切り替えは新規作成するコレクションにのみ反映される**ため、既に文書を索引済みの状態で切り替える場合はコレクション(`DocumentChunk`)の再作成が必要になる。GUIから切り替えた場合はこれを自動的に行う(既存コレクションの削除・全文書の索引状態リセットまでを自動実行し、サーバー再起動は不要)。環境変数`WEAVIATE_VECTORIZER`側だけを変更した場合は、従来通りWeaviate側でコレクションを削除してからサーバーを再起動すること
  - **大きな文書の分割登録**: 索引付けは`VECTOR_INSERT_BATCH_SIZE`(既定50)チャンクずつに分けてWeaviateへ登録する。全チャンクを1リクエストで送ると、書籍1冊分のPDF等ではCPUでの埋め込み計算がWeaviate側のタイムアウト(既定90秒)を超えて失敗するため(実機で発生)。リクエストのタイムアウトも`VECTOR_INSERT_TIMEOUT_SECONDS`(既定180秒)で長めに取る
- **索引付けの非同期化**: アップロード/削除/復元のAPI応答は、メタDB(SQLite/Postgres)への登録・全文検索インデックス(SQLiteはFTS5、Postgresはpg_trgm)更新が終わり次第すぐに返る(Weaviate側の埋め込み計算完了は待たない)。Weaviateへの登録・削除はバックグラウンドで実行され、進行状況は`documents.vector_index_status`に`processing`(処理中)として記録される。状態が変化するたび(処理中→成功/失敗)にSSE(`GET api/documents/events`の`documents-changed`)で通知するため、「ベクトル索引」画面を開いたままでも自動的に反映される。同一文書に対する登録・削除の実行順序は内部で直列化しており、アップロード直後に即削除するような操作を行っても、削除済みの文書のチャンクがWeaviate側に残留することはない。既に処理中の文書に対して再度索引付けが要求された場合(手動の再実行・複数タブからの操作等)は、新たに処理を開始せず進行中の処理に合流するため、二重に実行されることはない。また、埋め込み計算は1件だけでもCPUを使い切る重い処理のため、文書をまとめてアップロードした場合でも埋め込み計算自体は内部でグローバルに1件ずつ直列実行するよう制限している(この制限が無いと推論サーバーにリクエストが殺到し、Weaviate側の90秒タイムアウトで軒並み失敗することを実機で確認したため)。サーバーの強制終了等でプロセス内の実行キューが失われた場合に備え、起動時に`processing`のまま残っている文書は自動的に未処理へリセットされる(次回の索引付け/バックフィルで再処理される)
  - **既存文書のバックフィル**: `WEAVIATE_URL`を設定してサーバーを起動すると、この機能を導入する前にアップロード済みだった文書も自動的に差分索引付けされる(既にWeaviate側に登録済みの文書は再処理しない)
  - **索引状態の確認・再実行**: パンくずメニューの「ベクトル索引」(要 admin/readwrite ロール。件数が多くなる想定のためモーダルではなくページ全体で表示)から、索引付けに失敗した文書の一覧確認・個別/一括での再実行ができる。チャンク分割方法や埋め込みモデルを変更した場合など、既に成功している文書も含めて作り直したい場合は「全件を再索引」から一括で再実行できる(`GET api/documents/vector-index/status` / `POST api/documents/:id/vector-index/retry`)
  - **チャンク分割設定**: 本文を分割する単位(チャンクサイズ・オーバーラップ)は`VECTOR_CHUNK_SIZE`/`VECTOR_CHUNK_OVERLAP`環境変数で既定値を指定できるほか、「ベクトル索引」画面から admin ロールで上書き保存できる(GUIでの変更はサーバー再起動不要、`GET/PUT/DELETE api/vector-index/settings`)。**変更は新規に索引付けする文書からのみ反映される**ため、既存の索引付け済み文書にも適用したい場合は変更後に「全件を再索引」を行うこと
- **関連文書**: 文書同士を、種類も方向も持たない「関連」として紐づけられる(見積書と契約書、仕様書とその議事録など)。プレビュー右上のボタンで相手の文書を選ぶと、どちらから見ても相手がチップで表示され、クリックで開ける(チップの×で解除。文書自体には影響しない)。新旧の版の関係(`previous_id`)とは別で、`document_links`テーブルに(小さいID, 大きいID)へ正規化した1行として持つため、方向違いの二重登録は起きない。アーカイブ済みの文書との関連もそのまま残る(`archived`で判別)。API: `GET api/documents/:id/links` / `PUT`・`DELETE api/documents/:id/links/:relatedId`
- **タグ**: 文書ごとに自由入力のタグを付与できる。他の文書に付けた既存タグを候補として選択することも可能(個数上限なし)
- **メモ**: プレビュー下部に、文書ごとの備忘録として自由記述メモを入力・保存できる(要 admin/readwrite ロール。アーカイブ表示では閲覧のみ)。検索対象にも含まれる
- **登録日検索**: アップロード日時のFrom〜Toで絞り込み。初期表示は「2か月前 〜 (Toは空欄)」
- **週単位グルーピング**: 一覧はアップロード週(日曜始まり)で `YYYY-MM-DD ~` 見出しにまとめ、新しい週が上に来る
- **画面切り替えメニュー**: パンくずバーに「文書一覧 / タグ体系 / プロジェクト │ モックアップ … ベクトル索引 / アーカイブ」のメニューを常設し、現在の表示をハイライトする(アーカイブ・ベクトル索引は admin/readwrite ロールのみ表示。ベクトル索引は`WEAVIATE_URL`未設定でも表示され、その場合は未設定である旨を案内する)。日常的に使うものを左、時々しか使わないものを右に寄せ、文書とは別のコレクションであるモックアップは細い縦線で仕切って区別する(モックアップは`STORAGE_BACKEND=local`のときだけ表示)
- **アーカイブ・復元(Gmail風の論理削除)**: 「削除」ではなく`documents.deleted_at`/`deleted_by`を立てるだけの論理削除で、実ファイルは残す。アーカイブ済みの一覧・検索は`GET api/documents/archived`(要 admin/readwrite)。従来の`GET api/documents/trash`も同じ処理のまま残してあるが、AI連携時に「ゴミ箱=完全削除」と誤解されやすいため、新しい利用側には`archived`を案内する。「アーカイブ」メニューで通常の文書一覧と同じ画面(検索・週単位一覧・プレビュー)のままアーカイブ済み文書の一覧に切り替えられ、いつでも元に戻せる。アーカイブの中は「文書 / モックアップ」のタブに分かれており、引退したものはどちらも同じ入口に集まる。押し間違いが起きやすい操作のため、一覧・プレビュー・プロジェクトのツリーのどこから実行しても確認ダイアログを挟む(復元は即時)
- **新しい版のアップロード(旧版との紐付け)**: 既存文書を修正したものを、旧版と紐付けた「新しい版」として登録できる。画面ではプレビュー右上の「新しい版をアップロード」ボタン、APIでは`POST api/documents`の`previousId`フィールドに旧版の文書IDを指定する。新しい版の登録と同時に、旧版は自動的にアーカイブされ、タグと、プロジェクトへの登録(フォルダ・並び順。施錠中のプロジェクトも含む)が新しい版へ引き継がれる(メモは引き継がない)。紐付けは`documents.previous_id`で持ち、応答の`previousId`/`nextId`で前後の版が分かる。プレビュー上部に「版履歴」(v1 › v2 › …)を表示し、クリックでアーカイブ済みの旧版も開ける(`GET api/documents/:id/versions`で古い順に取得)。版履歴は一本道に保つため、既に新しい版がある旧版を指定すると409になる(最新版を指定する)
- **後からの版の紐づけ・解除**: 既に別々に登録されている文書同士も、後から新旧の版として紐づけられる(アップロード時に`previousId`を付け忘れた場合や、この機能より前に登録した文書のため)。プレビュー右上のリンクアイコンから旧版にあたる文書を選ぶ(アーカイブ済みも選べる)か、`PUT api/documents/:id/previous`に`{"previousId": "..."}`を送る。紐づけると旧版はアーカイブされ、タグは両方の和集合、プロジェクトへの登録は新版が未登録のプロジェクトだけ引き継ぐ(既に登録済みなら旧版側の登録を外す)。同じボタン/`DELETE api/documents/:id/previous`で解除できる(アーカイブ済みの旧版は自動では戻さない)。自分自身の指定は400、この文書に既に旧版がある場合・指定した旧版に既に新版がある場合・版履歴が循環する場合は409
- **プロジェクトのお品書き**: プロジェクト名をクリックすると、その案件の資料一覧に**資料ごとの説明書き**を付けたものがプレビュー領域に出る(ツリーは左に残るため、構成を見ながら書ける)。フォルダは章の見出しになり、フォルダにも前書きを書ける。「引き継ぎ・レビュー依頼・打ち合わせで、どんな資料が揃っていて何なのかを1枚で渡す」ための画面。説明はクリックしてその場で編集し(Ctrl+Enterで保存)、`Markdownをコピー`でそのまま議事録やメールに貼れる(`GET api/projects/:id/manifest.md`。画面のコピーも同じAPIを使うので内容は必ず一致する)。印刷もできる。**説明書きは文書ではなくプロジェクトへの紐づけ(`project_documents.note`)に持つ** ため、1つの文書を複数のプロジェクトに置いた場合でも「A案件では前提資料、B案件では参考」と書き分けられる(文書自身のメモとは別物)。並び順の決定は[lib/project-manifest.js](app/lib/project-manifest.js)1か所に寄せてあり、画面とMarkdownで食い違わない。説明1件あたり500文字(`PROJECT_NOTE_MAX_CHARS`)。詳細は[docs/project-manifest.md](docs/project-manifest.md)
- **タグ体系(タグツリー表示)**: 「タグ体系」メニューで、通常の週単位一覧とは別に、タグ名を見出しにしたグループ表示へ切り替えられる(検索・日付絞り込み・アップロードはこの画面では行わない)。表示対象のタグと並び順は`tag_order`テーブルで管理し(`GET/PUT api/tag_order`。並び順の変更はadminロール限定)、画面内の「タグ体系を管理」ボタンから追加・並び替え(上下ボタン)・削除ができる。複数のタグを持つ文書は該当する全グループに重複表示され、登録していないタグしか持たない文書は「未分類」として末尾にまとめられる
- **リアルタイム更新**: SSE (`GET api/documents/events`) で他クライアントのアップロード/削除を検知し、一覧を自動更新する
- **操作のポップアップ通知**: 他の利用者がアップロード・新しい版の登録・タグ付け・アーカイブ・復元を行うと、画面右下に小さなポップアップで「誰が・どの文書に・何をしたか」を表示する(約6秒で自動的に消え、マウスを乗せている間は残る。クリックでその文書を開く)。自分がブラウザで行った操作は通知しないが、自分名義でもAPIキー経由(AIエージェント等)の操作は「APIキー経由」として通知する。画面右上のベルのボタンで利用者ごとにオン/オフでき、設定はそのブラウザに保存される。同じSSEの`document-activity`イベントで配信し、Postgres構成では`LISTEN/NOTIFY`のペイロードで全インスタンスへ伝播する(ファイル名・タグは切り詰め、NOTIFYの8000バイト上限に収める)
- **APIでの通知の購読**: SSE(`GET api/documents/events`)はAPIキー(`Authorization: Bearer`、readonlyキー可)でも購読でき、ブラウザと同じ`document-activity`イベント(`{"action", "documentId", "entryFile", "tags", "user", "viaApiKey", "at"}`)を受け取れる。同梱クライアントの`watch`コマンド(`dm_client.py watch` / `dm_client.mjs watch`)は、イベントを1件1行のJSONで出力し、切断時は自動で再接続する(`--count`/`--timeout`/`--action`で終了条件・絞り込みを指定)。切断中のイベントは再送しない(Last-Event-ID未対応)。リバースプロキシでバッファリングされないよう`X-Accel-Buffering: no`を返す
- **アクセスログ・監査ログ**: 標準出力に、全リクエストのアクセスログ(method/url/status/所要時間/接続元IP/ログイン中ユーザー)と、アップロード/ダウンロード/削除を行った実行者を記録する監査ログ(`"msg":"audit"`)を出力する
- **操作履歴**: 画面右上の履歴アイコンから、自分自身が行った操作(登録/アーカイブ/復元/プロジェクトへの登録・解除)を直近30日分モーダルで確認できる(`GET api/history`)。他の利用者の操作は見えない。標準出力の監査ログとは別に`audit_log`テーブルに保存し、対象の文書名・プロジェクト名は記録時点の値をスナップショットとして残すため、後から文書やプロジェクトが変更・削除されても履歴自体は読める

### モックアップ管理

LLMなどで作ったWebページのモックアップ(ビルド済みの一式)をZIPで登録し、**別ウィンドウでそのまま動かして確認する**ための機能。文書とは**別のコレクション**で、DBの表もファイルの置き場も分かれている。`STORAGE_BACKEND=local`の構成でのみ使える(それ以外は503を返し、画面にもメニューを出さない)。詳細は[docs/mockup.md](docs/mockup.md)。

- **登録**: ZIP(既定100MBまで)＋一覧に出すプレビュー画像(任意)。アップロード時に展開して配信用に置き、**原本のZIPも残す**(サンプルファイル込みで配りたい場合があるため)。入口は`index.html`
- **表示**: 別ウィンドウで開く。**JSは動かす**(モックアップの意味が無くなるため)が、配信時に`Content-Security-Policy: sandbox allow-scripts`を付けて**オリジンを落とす**。ページは`window.origin === null`になり、このアプリのAPIにもcookieにも手が届かない(実ブラウザで確認済み)。CDNの参照は制限しない(LLMが作るモックアップはほぼ必ず外部CDNを使うため)
- **引換券による配信**: オリジンを落とすと、そのページからのCSS・JS・画像の要求は**クロスサイト扱い**になり`SameSite=Lax`のセッションcookieが届かない。配信側に素朴に認証を置くと「HTMLは開けるのに中身が何も動かない」(Chromeは`ERR_BLOCKED_BY_ORB`で遮断)状態になる。そこで入口(`GET api/mockups/:id/view`。ここは通常のページ遷移なのでcookieが届く)で**短時間だけ有効な署名付きの引換券**を発行し、`/view/<引換券>/<入口>`へリダイレクトして、その下で配信する。**認証を外したのではなく、認証できた人にだけ券を渡している**。券はそのモックアップ1件だけに効き、既定60分で切れる(`MOCKUP_VIEW_TOKEN_MINUTES`)。鍵は`SESSION_SECRET`から派生するため偽造も期限の延長もできない([lib/mockup-token.js](app/lib/mockup-token.js))
- **ZIPの展開で守ること**: **置き場所(パス)は厳格に、ファイルの種類は寛容に**。`..`を含むエントリ・絶対パス・ドライブレター・バックスラッシュ区切り・シンボリックリンク・展開先の外を指すものはすべて拒否する(中身が無害な`.txt`でもDBファイルを上書きすれば同じ被害になるため、拡張子では守れない)。一方でサンプルの`.xlsx`や`.pdf`を同梱してダウンロードさせる使い方は通し、配信時に`Content-Type`を**固定表から引く**(表に無ければ`application/octet-stream`＋ダウンロード扱い)。展開後の合計サイズは`zlib`の`maxOutputLength`で頭打ちにしており、**ヘッダーの展開後サイズを小さく偽ったZIP爆弾でも膨らまない**([lib/mockup-zip.js](app/lib/mockup-zip.js))
- **版管理**: 新しい版を登録すると旧版は自動でアーカイブされ、版履歴で辿れる。アーカイブ済みは「アーカイブ」メニューの「モックアップ」タブに出る
- **検索**: 名前・メモ・中のHTMLから抽出したテキスト。ビルド済みJSに埋もれた文言は拾えないため、過大な期待はしない前提
- **権限**: 現役の一覧・表示は readonly 以上、登録・編集は readwrite 以上。**アーカイブ済みは readwrite 以上**で、readonly にはIDが分かっても1件の情報・プレビュー・原本ZIP・入口のいずれからも触れさせない(文書側とあえて揃えていない。理由は[docs/mockup.md](docs/mockup.md))
- **上限(環境変数で変更可)**: ZIP 100MB / 展開後の合計300MB / ファイル数2,000 / 1ファイル50MB / 階層20 / 圧縮率200倍

### 認証・アクセス制御
- **OIDC (OpenID Connect)**: `openid-client` によるDiscoveryベースの実装。`OIDC_ISSUER` を差し替えるだけで、EntraID / AWS Cognito / Synology SSO Server など標準的なOIDCプロバイダに対応できる(同時に使えるのはどれか1つ)
  - Authorization Code Flow + PKCE + state + nonce
  - id_tokenの署名検証(JWKS)・iss/aud/exp検証は `openid-client` が行う
- **ログインセッション**: `express-session` でブラウザのログイン状態を管理し、OIDCプロバイダが発行するaccess_token/refresh_tokenのTTLには依存しない(短命なトークンでも `SESSION_MAX_AGE_HOURS` の間ログイン状態を維持する)
- **未ログイン時の自動リダイレクト**: 未ログイン状態でアクセスすると、画面操作なしで即座にOIDCプロバイダのログイン画面へ遷移する。文書の別ウィンドウプレビュー(`api/documents/:id/viewer`)を未ログイン状態で開いた場合も同様にログイン画面へ迂回し、ログイン完了後に元のURLへ自動的に戻る(`/login?next=...`。自ドメイン配下の相対パス以外は受け付けずオープンリダイレクトを防止)
- **認証判定のログ**: ログイン(コールバック)のたびに、入力メールアドレスの正規化結果・`ADMIN_EMAIL`との一致有無・ホワイトリストの一致行・ブートストラップ発動の有無・最終的なロールを`"msg":"::login:auth_check"`としてログ出力する。許可/拒否どちらの場合も出力されるため、意図通りに判定されているか標準出力から確認できる
- **アクセス許可ユーザー(ホワイトリスト)とロール**: ホワイトリストに登録されたメールアドレスのみログイン可能で、0件の間は誰もログインできない(常に閉じている)。ロールは3種類: `admin`(ホワイトリストの追加・削除・ロール変更が可能) / `readwrite`(文書の追加・削除・タグ編集が可能) / `readonly`(閲覧のみ)。`ADMIN_EMAIL` は常設の特別アカウントではなく、**adminロールのユーザーが1人もいない場合にだけ働く自己修復型のブートストラップ**で、該当メールアドレスでのログイン試行時に自動的にadminとして登録される(誤って全adminを削除してもロックアウトしない)
- **APIキー(マシン間認証)**: ブラウザの対話的ログインを経ずに `Authorization: Bearer <キー>` でapiを呼び出せる。ログイン済みユーザーが自分名義で発行・失効でき、そのキー経由の操作は発行者本人の名義で記録される
  - 有効期限の選択肢は「当日限り」(`now+12時間`と「翌日02:00(JST)」の早い方。チャット等に貼り付けて使う一時利用向け)/「30日」/「90日」/「1年」。**最長1年で、無期限キーは発行できない**(漏えいしたキーが際限なく使われるのを防ぐため)。スクリプト・Claude Code等のツールから継続利用する場合は、期限切れ前に発行し直す。漏えい時は画面から失効させること
  - 以前は「無期限」を選べたため、その頃のキーは`expires_at`に番兵値(`9999-12-31T23:59:59.999Z`)を持つ。起動時に上限(1年)へ自動的に切り詰める(`capUnlimitedKeys`)
  - **キーの管理(`api/apikeys`の発行・一覧・失効)はブラウザのログインセッションからのみ行える**(`requireSession`。APIキーで呼ぶと403)。APIキーでAPIキーを発行できると、期限が切れる前にキー自身が新しいキーを作り直せてしまい、上記の上限(最長1年)が意味を持たなくなるため。AIエージェントは自分でキーを作り直せず、期限切れ時は利用者に発行し直してもらう
  - キーには発行時にreadonly/readwriteいずれかのロールを固定で持たせる(adminロールのキーは発行不可)。選べるのは発行者自身のロール以下のみで、権限判定は発行者の"現在の"ロールではなく常にキーに記録されたロールを見る(発行者が後で昇格/降格しても既存キーの権限は変わらない)
  - 期限切れキーでの認証は401(「APIキーの有効期限が切れています」と明示)、有効なキーでもreadonlyロールでの書き込み系API呼び出しは403になる
  - 発行直後の画面から、キー本体のコピーとは別に「AIチャット貼り付け用」のテキスト(接続情報・エンドポイント一覧・実際のキーを埋め込んだ利用ガイド)もコピーできる
- **開発用バイパス**: `AUTH_DISABLED=true` で認証を丸ごと無効化できる(本番では未設定のこと)

### 管理画面(adminロールのみ)
画面右上の歯車アイコンから開く。モーダルではなくページとして開き、タブで切り替える([docs/admin-screen.md](docs/admin-screen.md)に定義と決めた理由を残してある)。
運用者が**SSHせずに「異常の有無」と「次に何をすべきか」を判断できる**ことを目的にしている。

- **アクセス許可ユーザー**: ホワイトリストの追加・ロール変更・削除(従来モーダルだったもの)
- **サーバー**: 版・リビジョン・**ビルド時刻**(イメージが作られた時刻)・**起動時刻**(コンテナが起動した時刻)・稼働時間・同梱クライアントの版・DBファイルの一覧とサイズ。更新したはずなのにビルド時刻が変わっていなければ入れ替わっていない、と画面上で判断できる。DBファイルの一覧には旧バージョンも並ぶため、切り戻せる状態かも分かる(`GET api/server-status`)
- **データベース**: 破損の検知(`PRAGMA quick_check`/`integrity_check`)と、**DBと実ファイルの照合**
  - SQLiteの破損は「書き込みは通るのに一部だけ読めない」形で進むことがあり、画面上は正常に見える。**起動のたびに自動で簡易確認**し、結果をログと画面に残す(`GET api/db-integrity`)
  - 照合は、実ファイルだけある文書(孤立ファイル)と、DBだけある文書(実ファイルが無い)を報告する。前者は**アーカイブ済みとして登録し直せる**(元がアーカイブ済みだったか知る手段が無いため。必要なら既存の「復元」で戻す)。後者は**報告のみで削除しない**——ボリュームが未マウントのときは全件が欠損に見えるため、消すと「復旧可能な障害」を「恒久的なデータ消失」に変えてしまう(`GET api/storage-reconcile`)
  - **ストレージに到達できていない疑いがあるときは、何も報告せず照合を中止する**
- **変換サービス**: 到達性・LibreOfficeの版・上限・タイムアウトと、**変換に失敗した文書の一覧・再実行**。「未設定」(異常ではない)と「落ちている」を区別して表示する(`GET api/office-render/health`)
- 動作の原則: **画面を開いただけでは重い処理を走らせない**(整合性確認と照合はボタン。開いた時点では起動時の結果を出す)、**重い操作は正体を明かす**(厳密な整合性確認は同期的に走りサーバーの他の処理が止まるため、確認ダイアログで明示する)、**破壊的な操作は置かない**(復旧・再構築・DBの直接編集は画面に入れない)
- APIはすべて`requireAdmin`。画面でボタンを隠すのは見た目の話で、**本当の境界はサーバー側**

### セキュリティ
- **表示時のエスケープ**: ファイル名・タグ・アップロード者名・許可ユーザーのメールアドレス・APIキーのラベル等、書き込み権限を持つ利用者が自由入力できる値は、フロントエンドで`escapeHtml()`を通してから画面に描画する(HTMLタグとしての解釈も属性値からの脱出も防ぐ)。書き込み権限のある利用者(またはAPIキー)が悪意あるファイル名・タグを登録しても、それを閲覧した他の利用者のブラウザ側でスクリプトは実行されない
- **レート制限**(`express-rate-limit`、超過時は429): `api/*`は認証状態で上限を分けている。未認証(総当たり・スクレイピング等が主目的)はIPごとに5分間300リクエスト、認証済み(ログインセッション・APIキー)は利用者ごとに5分間1000リクエストと大幅に緩め、複数文書の一括操作等を行うAI連携の実利用でも制限に達しにくくしている(認証済み側はIPではなく利用者識別子でカウントするため、社内共有ネットワーク等で複数人が同一IPに見える環境でも互いに影響しない)。無効なAPIキーでの試行は未認証側の枠でカウントされる。`/login`(OIDCログイン開始・コールバック)には15分間20リクエスト/IPの上限を別途設けている(実際のパスワード入力はOIDCプロバイダ側で行われるため、これは認可コード交換の仕組み自体への連打対策という位置づけ)
- **防御ヘッダー**: 全応答に`X-Frame-Options: SAMEORIGIN`(画面を外部サイトのiframeに埋め込ませない。ログイン済みの利用者に気づかせず操作させる攻撃を防ぐ)と`Referrer-Policy: same-origin`(外部サイトへ遷移するとき文書IDを含むURLを渡さない)を付ける。静的配信にも届くよう、各ルートではなくミドルウェアで付与する
- **応答に載せるURLは設定値に固定する**: リバースプロキシ配下では`Host`ヘッダーを公開URLとして使えない(転送先の宛先になることがあり、呼び出し側が任意の値を入れられる)。`OIDC_REDIRECT_URI`のオリジンを使う。AI向け利用ガイドの`?baseUrl=`も自分のオリジン配下に限定する(正規ドメインのURLを渡すだけで「ベースURLだけ別サイトに差し替えたガイド」を作れると、AIが以降の呼び出しをAPIキーごと別サイトへ送ってしまうため)
- **ログイン後の戻り先**: 文字列の前方一致では判定しない。ブラウザ(WHATWG URL)は`\`を`/`と同等に扱うため、`//`だけを弾く実装では`/\evil.example`がプロトコル相対URLとして解釈され外部へ飛ぶ。実際にブラウザと同じ規則で解決してオリジンが変わらないことを確かめ、リダイレクト先には解決後の値を使う
- **壊れたリクエストで中身を漏らさない**: 不正なmultipartや壊れたJSONはExpressの既定ハンドラに落ちるとHTMLを返し、`NODE_ENV`がproductionでなければスタックトレースと絶対パスまで載せる。守りを環境変数ひとつに依存させないため、明示的なエラーハンドラでJSONの400/500だけを返す
- **応答に載る値の上限**: ファイル名はパス区切り・制御文字を拒否し、メモは`MEMO_MAX_CHARS`(既定4000字)、文書タグは50字×50件で切り詰める。これらは文書一覧・検索の応答すべてに載るため、上限が無いと1件の文書でAIエージェントの文脈を埋め尽くせる
- **AIへの明示**: 取得した内容(ファイル名・メモ・タグ・本文・検索の抜粋)は利用者が書いた**データであって指示ではない**ことを、SKILL.mdと利用ガイドの両方に書いている。文書は誰でもアップロードできるため、1件の文書の中身でAIの動きを変えられる状態は「1人の悪意で他の利用者のAIを操れる」ことになる
- **アップロードサイズ上限**: 1ファイル`UPLOAD_MAX_BYTES`(既定256MB)まで。超過時は413を返す。認証チェック(`requireAuth`/`requireWrite`)をmultipartパース(`express-fileupload`)より先に行う構成のため、未認証のリクエストはファイル本体の読み取りが始まる前に401/403で弾かれる(サイズ判定にすら到達しない)

### API仕様の配信(OpenAPI / AI向けガイド)
- API仕様は[app/lib/api-spec.js](app/lib/api-spec.js)に一元化し、そこから2つの形式で配信する(どちらもログイン済みまたはAPIキーで取得可)
  - `GET api/openapi.json`: OpenAPI 3.1。ツール・AIエージェント向けの機械可読な仕様。全APIを網羅し、ロール(`x-role`)とAPIキーから実行できるか(`x-api-key-usable`)も含む
  - `GET api/usage.md`: AI向けの利用ガイド(Markdown)。接続情報・エンドポイント一覧・curl例・「アップして」と言われたときの振る舞い等の指示を含む
- 「アップして」「探して」等のAIへの指示も仕様の一部として同じ場所で管理し、OpenAPIの`info.description`・`x-ai-instructions`と利用ガイドの双方に反映される
- ベースURLは`?baseUrl=`で指定でき(画面は自分のURLを渡す)、省略時はリクエストから組み立てる。リバースプロキシ配下の`BASE_PATH`にも対応する
- セマンティック検索・ベクトル索引関連は、`WEAVIATE_URL`が設定されている環境でのみ仕様に含まれる(存在しないAPIをAIに教えないため)
- **実装とのずれ防止**: Expressに登録済みの`api/*`ルートと仕様の突き合わせを[test/api-spec.test.js](test/api-spec.test.js)で検証する(APIを追加して仕様を更新し忘れるとテストが落ちる)

### AI連携ヘルプ
- 画面右上のヘルプアイコンから、上記の利用ガイド(`api/usage.md`)を表示・コピーできる。Claude Desktop・Antigravity・Cowork等のデスクトップ/エージェント型AIに、このAPIの使い方をそのまま渡せる。APIキー発行直後の「AIチャット貼り付け用にコピー」も同じガイドに実際のキーを埋め込んだもの

### AIエージェント用 Skill・APIクライアント(Claude Code / Codex / Antigravity)
- [tools/claude-skill/](tools/claude-skill/) に、Claude Code・OpenAI Codex・Google Antigravity から「アップして」「新しい版で上げて」「探して」と話しかけるだけでこのAPIを操作できる Skill(`document-manager`)を同梱している。Skillの形式(`SKILL.md`+`scripts/`)は3つのエージェントで共通のため同じZIPを使い、展開先だけが異なる(Claude Code: `~/.claude/skills/`、Codex: `~/.agents/skills/`、Antigravity: `~/.gemini/config/skills/`)。Python版(`dm_client.py`、標準ライブラリのみ)と Node.js版(`dm_client.mjs`、外部依存なし)のクライアントはどちらも同じコマンドで、単体のCLIとしても使える
- クライアントのコマンド: `config` / `search`(全文・`--semantic`で意味検索・`--archived`) / `get` / `versions` / `upload`(`--previous-id`・`--replace-same-name`・`--tags`・`--preview`・`--project`/`--folder`) / `download` / `tags`(`--add`/`--remove`/`--set`) / `memo` / `archive` / `restore` / `links`・`link`・`unlink` / `link-previous`・`unlink-previous` / `projects`・`project-create`・`tree`・`folder-create`・`place`・`unplace` / `watch`(SSE) / `spec`(`api/usage.md`、`--openapi`で`api/openapi.json`)。プロジェクト・フォルダはIDでも名前でも指定できる。ここに無い操作(タグ体系の管理など)は`spec`でAPI仕様を読んで直接呼ぶ
- **更新のお知らせ**: 手元のクライアントがサーバー同梱のものより古い場合、サーバーが応答ヘッダー`X-Skill-Latest-Version`で知らせ、クライアントが利用者とAIへ「ZIPを取り直してフォルダを置き換える」よう促す(認証に失敗した応答にも付くため、APIキーが期限切れでも気づける)。またサーバーが更新されたときは`X-Server-Updated`で**APIキーごとに1回だけ**知らせ、AIに`spec`での取り直しを促す。合図はビルドであって起動ではないため、クラッシュ復帰や再起動では通知されない
  - 貼り付けた利用ガイドで動くAI(コピペ経路)にはヘッダーが届かないため、ガイド自身の冒頭に「いつ・どの版の内容か」と入手先(ガイド・OpenAPI・同梱クライアントのZIP・`GET api/version`)を表で載せ、AIが自分で取り直せるようにしている
- クライアントのバージョン: `--version`(または`config`の`clientVersion`)で確認でき、`User-Agent: document-manager-skill/<バージョン>`として送られるためサーバーのアクセスログからも追える。Python版・Node.js版・SKILL.mdの記載が揃っていることは結合テストで検証する。タグ`skill-v<バージョン>`のpushでGitHub Releaseを作る
- 画面右上「APIキー管理」→「AIエージェント用 Skill」から、SkillのZIPのダウンロード(`GET api/claude-skill.zip`。ログイン済みならロールを問わず取得可。サーバー側でリポジトリの`tools/claude-skill/document-manager/`から生成する)と、エージェント別(タブで切り替え)の登録手順・接続先URL入りの登録依頼文のコピーができる。リポジトリからは `python tools/claude-skill/build_skill_zip.py` で `tools/claude-skill/dist/document-manager-skill.zip` を作れる。このZIPを各エージェントのチャットに渡して「Skillとして登録して」と頼むか、上記の展開先に展開すれば登録できる。GitHub Actions(`skill-package.yml`)が、Skill関連の変更のたびにクライアントの結合テストとZIP作成を行ってアーティファクトに保存し、タグ`skill-v*`のpushでGitHub ReleaseにZIPを公開する。詳細は [tools/claude-skill/document-manager/README.md](tools/claude-skill/document-manager/README.md) を参照

## ディレクトリ構成

```
document-manager/
├── Dockerfile              # 2ステージ (依存のインストールはビルドホスト上で行い、node_modulesだけをターゲット環境のイメージへコピー)
├── docker-compose.yml      # app + Weaviate + Embedding推論サーバー(セマンティック検索を使う場合)
│                           # converterは profile 指定時のみ(docker compose --profile convert up)
├── .github/workflows/
│   ├── docker-publish.yml    # mainへのpushでDockerイメージ(amd64/arm64)をビルドしDocker Hubへ公開
│   ├── converter-publish.yml # converter/の変更と週次で、変換サービスのイメージ(amd64)を公開
│   │                           # 公開前に実ファイルでの変換と、本体と繋いだ結合テストを通す
│   └── skill-package.yml     # Skillの結合テスト・ZIP作成(アーティファクト保存)、タグskill-v*でGitHub Release公開
├── app/                     # アプリケーション本体 (Dockerイメージにコピーされる)
│   ├── server.js             # エントリポイント
│   ├── lib/
│   │   ├── datastore.js       # DBアクセスの非同期抽象層 (DATABASE_BACKENDでsqlite/postgresを切替。各libはこれ経由でアクセス)
│   │   ├── db.js              # SQLite初期化・スキーマバージョン管理 (documents/document_tags/document_links/api_keys/allowed_users/tag_order/projects/project_folders/project_documents/audit_log/vector_search_settings)
│   │   ├── schema-pg.js       # Postgresバックエンド用スキーマDDL (pg_trgm/GIN含む。datastore.initで冪等作成)
│   │   ├── session-store.js   # express-session用の永続セッションストア (sqlite/postgres。MemoryStore不使用)
│   │   ├── oidc-client.js     # OIDC Discovery + Configuration初期化
│   │   ├── api-keys.js        # APIキーの発行/検証/失効
│   │   ├── allowed-users.js   # ログイン許可ユーザーのホワイトリスト管理
│   │   ├── tag-order.js       # タグ体系(タグツリー表示)の並び順管理
│   │   ├── projects.js        # プロジェクト(フォルダ階層による文書整理)の管理
│   │   ├── project-manifest.js # お品書き(プロジェクトの資料一覧＋説明書き)の組み立て・Markdown化
│   │   ├── mockups.js         # モックアップ(ビルド済みページ一式)のメタデータ管理
│   │   ├── mockup-zip.js      # モックアップZIPの安全な展開(パス検査・ZIP爆弾対策)
│   │   ├── mockup-storage.js  # モックアップの置き場(原本ZIP・展開先・プレビュー画像)
│   │   ├── mockup-token.js    # モックアップ配信用の、短時間だけ有効な引換券
│   │   ├── audit-log.js       # 操作履歴(自分の登録/アーカイブ/復元/プロジェクト操作)の記録・参照
│   │   ├── storage.js         # 文書ファイルの保存先抽象化 (ローカルディスク/S3/GCS。STORAGE_BACKENDで切替)
│   │   ├── vector-search.js   # セマンティック検索(Weaviate連携、任意機能。WEAVIATE_URLで有効化)
│   │   ├── drawio.js          # .drawio(XML/圧縮diagram)からのテキスト抽出(全文検索用)
│   │   ├── office.js          # Excel/Word/PowerPoint(OOXML)→概要プレビューHTML+全文検索用テキスト
│   │   ├── office-render.js   # 体裁つき表示(Office→PDF)。変換サービスへの依頼(OFFICE_RENDER_URLで有効化)
│   │   ├── db-integrity.js    # SQLiteの破損検知(起動時の自動確認・管理画面からの再確認)
│   │   ├── storage-reconcile.js # DBと実ファイルの照合(読み取りのみ。孤立ファイル/欠損の報告)
│   │   ├── claude-skill.js    # AIエージェント用SkillのZIP生成(api/claude-skill.zip。Node標準のzlibのみ使用)
│   │   ├── api-spec.js        # API仕様の単一の情報源(OpenAPI・AI向け利用ガイド・AIへの指示を生成)
│   │   ├── document-links.js  # 関連文書(種類・方向を持たない文書同士の紐付け)
│   │   └── logger.js          # 共通ロガー (標準出力のみ)
│   └── static/
│       ├── index.html        # フロントエンド(単一HTML)
│       ├── drawio-viewer.*   # .drawio をブラウザ上で描画するページ(html/js/css)
│       └── vendor/drawio/    # draw.io公式のビューア(viewer-static.min.js。Apache-2.0)
├── deploy/                  # 運用サーバ(podman + リバースプロキシ)向けのcompose構成
│   ├── compose.yml           # 公開イメージ + Weaviate + 推論サーバー(Weaviate側はポート非公開)
│   ├── compose.sh            # 起動用ラッパー(up/verify/down/logs/ps。必須設定が無ければ止める。upは入れ替わったかまで確認する)
│   ├── compose.env.example   # サイト固有の値のひな形(実ファイルはGit管理外)
│   └── check-converter-isolation.sh # 変換サービスの隔離が実際に効いているかを実機で確認する
├── converter/               # Office→PDF 変換サービス(別イメージ。LibreOffice同梱)
│   ├── Dockerfile            # Debian 13 + LibreOffice 25.2 + 日本語フォント(amd64のみ)
│   ├── server.js             # HTTPの受け口(依存なし。直列実行・タイムアウト・マクロ拒否)
│   ├── README.md             # 実測値・API・隔離の考え方
│   └── test/smoke.js         # 実ファイルでの結合テスト(所要時間も出す)
├── tools/
│   ├── claude-skill/         # AIエージェント用Skill(Dockerイメージにも /app/claude-skill/ としてコピーされる)
│   │   ├── document-manager/  # Skill本体(SKILL.md / README.md / scripts/dm_client.py・dm_client.mjs)
│   │   ├── build_skill_zip.py # ZIP作成(dist/に出力。dist/はgit管理外)
│   │   └── ci_smoke_test.py   # クライアントとZIPの結合テスト(CIとローカル共通)
│   ├── verify-schema-migration.js # スキーマ移行でデータが失われないかを実際に動かして確認(手動実行)
│   └── make-office-fixtures.py    # テスト用のExcel/Word/PowerPointを生成する
├── test/                    # テスト(Dockerイメージには含めない。「テスト」参照)
├── docs/
│   ├── admin-screen.md       # 管理者画面の定義(決めた理由と積み残しを含む)
│   ├── mockup.md             # モックアップ管理の定義(隔離のしかたと、実測で確かめた結果)
│   ├── project-manifest.md   # お品書きの定義(説明書きをプロジェクトごとに持つ理由)
│   ├── dockerhub-overview.md # Docker Hubの説明文(機能を足したらここも更新する)
│   └── screenshots/          # READMEのスクリーンショットと撮影スクリプト(capture.js)
└── data/                     # 実行時にマウントされる永続化ボリューム (Dockerイメージには含めない)
    ├── documents/<年月>_<UUID>/  # 文書本体 (元ファイル + 変換後preview.html。STORAGE_BACKEND=local時のみ)
    ├── mockups/<年月>_<UUID>/    # モックアップ (原本のsource.zip + 展開先のsite/ + プレビュー画像。STORAGE_BACKEND=local時のみ)
    └── db/document_manager_v<N>.sqlite  # DATABASE_BACKEND=sqlite時のみ。<N>はスキーマバージョン(現在v16)で、移行時は旧バージョンのファイルを残したまま新しいファイルを作る(移行が正しく行われるかは`node tools/verify-schema-migration.js <移行元のコミット>`で実際に動かして確認できる)(postgres時はマネージドDB側に保存され、このボリュームは不要)
```

## 環境変数

| 変数名 | 既定値 | 説明 |
| --- | --- | --- |
| `LISTEN_PORT` | `8080` | Listenポート |
| `BASE_URL_PATH` | `/` | Express内部のルーティングprefix(通常は変更不要。リバースプロキシがprefixを剥がして転送する前提) |
| `BASE_PATH` | `/document_management` | 外部公開時のパスprefix。ログイン/ログアウト/ホームの遷移先の組み立てに使用 |
| `DATA_DIR` | `/data` | `DATABASE_BACKEND=sqlite`(既定)時のSQLite DBの保存先。`STORAGE_BACKEND=local`の場合は文書ファイルもここに保存される。`DATABASE_BACKEND=postgres`かつ`STORAGE_BACKEND`がs3/gcsなら永続ボリューム不要 |
| `DATABASE_BACKEND` | `sqlite` | メタデータDBのバックエンド。`sqlite`(単一コンテナ・`DATA_DIR`上のファイル)または`postgres`(マネージドPostgreSQL)。複数インスタンスで水平スケールする場合は`postgres`が必須(SQLiteは単一インスタンス前提。セッションもこのDBで共有される)。横断SSEに`LISTEN/NOTIFY`を使うため、水平スケール時は**RDS for PostgreSQL / Cloud SQL for PostgreSQL 推奨(Aurora PostgreSQLは`LISTEN/NOTIFY`非対応)**。詳細は[マルチクラウド構成の要点](#マルチクラウド構成の要点) |
| `DATABASE_URL` | (postgres時に使用) | Postgres接続文字列(例: `postgres://user:pass@host:5432/dbname`)。`DATABASE_BACKEND=postgres`で未設定の場合は標準の`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`が使われる。スキーマは起動時に自動適用される(`schema_migrations`テーブルで適用済みバージョンを管理し、未適用のマイグレーションだけを順に適用する。詳細は[lib/schema-pg.js](app/lib/schema-pg.js)) |
| `DATABASE_SSL` | (未設定) | `true`でPostgres接続にTLSを使う(マネージドPGで必要な場合)。証明書検証は行わない(`rejectUnauthorized:false`) |
| `STORAGE_BACKEND` | `local` | 文書ファイルの保存先。`local`(ディスク)/`s3`(AWS)/`gcs`(Google Cloud Storage)。切り替えは今後の保存先を変えるだけで、既存ファイルの自動移行は行わない |
| `S3_BUCKET` | (STORAGE_BACKEND=s3の場合必須) | 保存先のS3バケット名 |
| `S3_REGION` | (STORAGE_BACKEND=s3の場合必須) | S3バケットのリージョン |
| `S3_PREFIX` | `documents` | S3オブジェクトキーのプレフィックス(`<prefix>/<文書ID>/<ファイル名>`) |
| `S3_ENDPOINT` | (未設定) | MinIO等のS3互換サービスに接続する場合のエンドポイントURL。未設定時は実AWS S3に接続する |
| `GCS_BUCKET` | (STORAGE_BACKEND=gcsの場合必須) | 保存先のGoogle Cloud Storageバケット名 |
| `GCS_PREFIX` | `documents` | GCSオブジェクト名のプレフィックス(`<prefix>/<文書ID>/<ファイル名>`) |
| `WEAVIATE_URL` | (未設定) | セマンティック検索(意味検索)用のWeaviateエンドポイント(例: `http://weaviate:8080`)。未設定の間はこの機能自体が無効化され、`api/documents/search/vector`は503を返す |
| `WEAVIATE_GRPC_PORT` | `50051` | WeaviateのgRPCポート(`WEAVIATE_URL`設定時のみ使用) |
| `WEAVIATE_VECTORIZER` | `text2vec-transformers` | Embedding計算に使うWeaviateのベクトライザーモジュールの既定値。`text2vec-transformers`(自己ホスト、認証情報不要)/ `text2vec-cohere`(Cohere SaaS、要`COHERE_APIKEY`)/ `text2vec-openai`(要`OPENAI_APIKEY`)/ `text2vec-aws`(Cohere on AWS Bedrock、要`AWS_BEDROCK_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`)。「ベクトル索引」画面からadminロールで上書きでき、その場合はDB側の値が優先される(認証情報自体はDBに保存されない) |
| `COHERE_APIKEY` | (未設定) | `text2vec-cohere`を使う場合に必須。CohereのEmbedding APIキー |
| `OPENAI_APIKEY` | (未設定) | `text2vec-openai`を使う場合に必須。OpenAIのAPIキー |
| `AWS_BEDROCK_REGION` | (未設定) | `text2vec-aws`を使う場合に必須。Bedrockを呼び出すAWSリージョン(例: `us-east-1`) |
| `AWS_BEDROCK_MODEL` | `cohere.embed-multilingual-v3` | `text2vec-aws`使用時のBedrockモデルID。Amazon Titanの埋め込みモデル(例: `amazon.titan-embed-text-v2:0`)等に変更することも可能 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (未設定) | `text2vec-aws`を使う場合に必須。Bedrockの呼び出し権限を持つIAMユーザーの認証情報(S3の`STORAGE_BACKEND=s3`利用時とは別に、Weaviateへのリクエストヘッダーとして都度渡される)。AWS上で稼働させる場合は、ECSタスク定義の`secrets`等でAWS Secrets Managerの値をコンテナ起動時に注入する構成を推奨する |
| `VECTOR_CHUNK_SIZE` | `180` | セマンティック検索の本文チャンク分割サイズ(文字数の既定値)。既定モデル(mpnet-base-v2、最大128トークン)で実測した結果に基づく値([チャンクサイズの実測](#チャンクサイズの実測モデルの最大シーケンス長との関係)参照)。「ベクトル索引」画面からadminロールで上書き保存でき、その場合はDB側の値が優先される |
| `VECTOR_CHUNK_OVERLAP` | `20` | チャンク分割時のオーバーラップ(文字数の既定値)。上書きの扱いは`VECTOR_CHUNK_SIZE`と同様 |
| `CONTENT_TEXT_MAX_CHARS` | `300000` | 検索用に保存する本文の上限(文字数)。超過分は全文検索の対象外になる(ファイル自体は影響を受けない)。巨大なログ・CSV等でDBが膨らむのを防ぐための安全弁 |
| `UPLOAD_MAX_BYTES` | `268435456` | 1ファイルあたりのアップロード上限(バイト。既定256MB)。超過時は413を返す |
| `VECTOR_INSERT_BATCH_SIZE` | `50` | ベクトル索引付けで、1リクエストにまとめて送るチャンク数。Weaviateはリクエスト単位でタイムアウトするため、大きな文書でも1回あたりの埋め込み計算量が上限内に収まるよう小分けにする |
| `VECTOR_INSERT_TIMEOUT_SECONDS` | `180` | Weaviateへの登録リクエストのタイムアウト(秒)。CPUでの埋め込み計算は遅いため既定より長めに取る |
| `OFFICE_RENDER_URL` | (未設定) | 体裁つき表示(Office→PDF)の変換サービスのURL(例: `http://converter:3000`)。未設定の間はこの機能が無効になり、Office文書は概要プレビューだけで扱う(登録・検索・ダウンロードには影響しない) |
| `MEMO_MAX_CHARS` | `4000` | 文書メモの上限(文字数)。メモは文書一覧・検索の応答すべてに載るため、1件で応答を埋め尽くせないようにする安全弁 |
| `PROJECT_NOTE_MAX_CHARS` | `500` | お品書きの説明書き1件の上限(文字数)。説明はプロジェクトのツリー取得の応答すべてに載るため、長文を持たせないための安全弁(長い説明は文書のメモ側に書く) |
| `MOCKUP_VIEW_TOKEN_MINUTES` | `60` | モックアップ表示用の引換券の有効期限(分)。短くするとURLが漏れたときの露出は縮むが、長く開いたままにしていると途中で配信が止まる(開き直せば直る) |
| `MOCKUP_MAX_TOTAL_BYTES` | `314572800` | モックアップZIPの**展開後**の合計サイズの上限(バイト。既定300MB)。ZIP爆弾に対する実質の防波堤で、`zlib`の`maxOutputLength`で頭打ちにするためヘッダーの偽装では抜けられない |
| `MOCKUP_MAX_FILE_BYTES` | `52428800` | モックアップZIP内の1ファイルの上限(バイト。既定50MB) |
| `MOCKUP_MAX_FILES` | `2000` | モックアップZIP内のファイル数の上限 |
| `MOCKUP_MAX_DEPTH` | `20` | モックアップZIP内のディレクトリ階層の上限 |
| `MOCKUP_MAX_RATIO` | `200` | 展開後÷圧縮後の比の上限。ZIP爆弾対策の二段目(HTMLは素直に10〜20倍に圧縮されるため誤検知しない) |
| `RECONCILE_MAX_ENTRIES` | `5000` | 「DBと実ファイルの照合」で一度に調べる件数の上限。文書数が多い環境で管理画面の操作が返らなくなるのを避ける |
| `LOG_LEVEL` | `info` | ログレベル (pino) |
| `AUTH_DISABLED` | (未設定) | `true` で認証を丸ごとバイパスする開発用フラグ。本番では未設定のこと |
| `OIDC_ISSUER` | (必須) | OIDCプロバイダのissuer URL。例: `https://login.microsoftonline.com/<TENANT_ID>/v2.0`(EntraID)、`https://cognito-idp.<REGION>.amazonaws.com/<USER_POOL_ID>`(Cognito) |
| `OIDC_CLIENT_ID` | (必須) | クライアントID |
| `OIDC_CLIENT_SECRET` | (空文字) | クライアントシークレット。パブリッククライアントの場合は未設定でよい |
| `OIDC_REDIRECT_URI` | (必須) | コールバックURL。プロバイダ側にも同じ値を登録すること |
| `OIDC_SCOPE` | `openid profile email` | 要求スコープ。プロバイダのアプリクライアントで許可されているものに合わせること(EntraIDでrefresh_tokenが必要な場合は `offline_access` を追加。ただし本アプリはaccess_tokenのTTLに依存しないため通常は不要) |
| `OIDC_USERNAME_CLAIM` | `email` | ユーザー識別子として使うid_tokenのクレーム名 |
| `SESSION_SECRET` | (ランダム生成) | ログインセッションの署名鍵。セッション本体は永続ストア(SQLite/Postgres)に保存されるため、この値を固定すればコンテナ再起動をまたいでログイン状態が維持される。未設定だと起動のたびにランダム生成され、署名鍵が変わるため全セッションが無効になる |
| `SESSION_MAX_AGE_HOURS` | `8` | ログインセッションの寿命(時間) |
| `ADMIN_EMAIL` | (未設定) | adminロールのユーザーが1人もいない場合にだけ、ログイン時に自動でadminとして登録される自己修復用のメールアドレス。常設の特別枠ではない |

S3の認証情報は、AWS SDKの標準クレデンシャルチェーン(ECSタスクロール/EC2インスタンスロール等のIAMロールを優先し、未設定時は`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`環境変数や共有設定ファイルにフォールバック)にそのまま従う。アプリ側で個別の環境変数は用意していない。

GCSの認証情報は、Google CloudのADC(Application Default Credentials。GKEのWorkload Identityやアタッチされたサービスアカウント、`GOOGLE_APPLICATION_CREDENTIALS`が指す鍵ファイル等)に従う。アプリ側で個別の環境変数は用意していない。

Postgresの認証情報は`DATABASE_URL`(または`PG*`環境変数)に含める。パスワードを含むため、AWSなら`ECSタスク定義のsecrets`でSecrets Managerの値を、GCPならCloud RunのシークレットやSecret Managerの値を、コンテナ起動時に環境変数へ注入する構成を推奨する(平文でイメージやリポジトリに残さない)。DBはアプリと同じクラウド・同じVPC内に置き、レイテンシと下り転送料を抑えること。

### マルチクラウド構成の要点

同じDockerイメージのままAWS/GCP双方のマネージド環境で動く。実行基盤とマネージドサービスは同じクラウドに揃えるのが原則:

| 用途 | AWS (ECS/Fargate) | GCP (Cloud Run / GKE) |
| --- | --- | --- |
| メタDB・セッション | `DATABASE_BACKEND=postgres` + RDS/Aurora | `DATABASE_BACKEND=postgres` + Cloud SQL/AlloyDB |
| 文書ファイル | `STORAGE_BACKEND=s3` + S3 | `STORAGE_BACKEND=gcs` + GCS |
| ベクトル検索(任意) | Weaviateコンテナ / Weaviate Cloud | 同左 |

複数インスタンスで動かす場合は`DATABASE_BACKEND=postgres`が前提(セッションもPostgresで共有されるため、どのインスタンスに振り分けられてもログイン状態が維持される)。全文検索は、SQLiteではFTS5(trigram)、PostgresではpgのGIN trigramインデックス(pg_trgm)で自動的に切り替わる。

**リアルタイム更新(SSE)の横断通知には標準PostgreSQLが必要**: 一覧やベクトル索引状態の変更通知(`GET api/documents/events`)は各インスタンスがメモリ上で接続を保持しているため、素朴にはインスタンス内に閉じる。これを複数インスタンス横断で届けるため、`DATABASE_BACKEND=postgres` のときは **Postgres の `LISTEN/NOTIFY`** をバックプレーンに使い、あるインスタンスで起きた変更を全インスタンスのSSEクライアントへ伝播する(`lib/datastore.js` の `subscribe`/`notify`)。

- **`LISTEN/NOTIFY` は標準PostgreSQL(RDS for PostgreSQL / Cloud SQL for PostgreSQL)の機能**。**Aurora PostgreSQL は `LISTEN/NOTIFY` に非対応**、AlloyDB は要確認。**横断SSEが必要な水平スケール構成では RDS / Cloud SQL を使うこと**(Aurora等では横断通知が届かず、各インスタンス内に閉じる。データ自体は共有DBで整合しているため、実害は「他インスタンスの利用者の変更が即時に画面反映されないことがある」程度で、次の再取得・再読み込みで反映される)。
- SQLite(単一インスタンス)ではプロセス内で完結するため、この制約は無関係。

複数インスタンス運用時のもう一つの既知の制約:

- **ベクトル索引付けはインスタンスごとに直列化される**: 埋め込み計算の直列化・重複防止(`runSerialized`/`runEmbeddingExclusive`)はプロセス内メモリのキューで行うため、インスタンスをまたいだ調停は行わない(同一文書への同時操作が複数インスタンスに分かれると二重に索引付けされ得る)。索引付けは「全チャンクを作り直す冪等な処理」なので結果は壊れないが、埋め込み計算が余分に走る可能性がある。

## ローカル動作確認

```bash
cd app
npm install
AUTH_DISABLED=true DATA_DIR=../data node server.js
```

`http://localhost:8080/` にアクセスすると、認証なし(`dev-user`)で操作できる。

## テスト

テストはアプリ本体(`app/`)の外、リポジトリ直下の `test/` に置く(Dockerイメージは `app/` のみを
コピーするため、テストはイメージに含まれない)。テスト用の依存(Playwright)もルートの
`package.json`(`app/`とは別)で管理する。

```bash
# リポジトリ直下で
npm install        # テスト用依存(@playwright/test)を入れる。アプリ依存は app/ 側で別途 npm install
npm test           # 層1(純関数)+層2(SQLite結合)。node:test、外部サービス不要
npm run test:api   # 層3(API)。Playwrightが認証有効のテストサーバを起動しHTTPで検証
npm run test:e2e   # 層4(ブラウザE2E)。実Chromiumで主要UIフローを操作。要 `npx playwright install chromium`
npm run test:pg    # Postgres固有(LISTEN/NOTIFY等)。要 DATABASE_BACKEND=postgres + DATABASE_URL(未設定ならスキップ)
npm run test:converter  # 本体と変換サービスを実物同士で繋ぐ。要 converterの起動(未起動ならスキップ)
npm run test:reconcile  # DBと実ファイルの照合。実サーバを起動し、食い違いを実際に作って確認する
npm run test:discard    # アップロード失敗時の後始末。実サーバを起動し、登録を失敗させて確認する
python tools/claude-skill/ci_smoke_test.py  # AIエージェント用Skillのクライアント(Python/Node.js)とZIPの結合テスト
```

- **`test/api-spec.test.js`**: API仕様([app/lib/api-spec.js](app/lib/api-spec.js))とExpressに登録済みルートの突き合わせ(過不足の検出)、OpenAPI・利用ガイドの生成結果の検証
- **`test/unit.test.js`**: 純関数ユニット(Range計算・SQLプレースホルダ変換・チャンク分割・有効期限計算(最長1年)・ロール判定・draw.ioのテキスト抽出)
- **`test/security.test.js`**: 外部から与えた値を「安全」と判定してしまう箇所の検証(ログイン後の戻り先・アップロードのファイル名・ダウンロード名のヘッダー・AI向けガイドの入手先と注意書き)。**破れた実例をそのままテストとして残す**方針で、表記を変えて破られる再発を防ぐ
- **`test/storage-discard.test.js`**: 実ファイルを捨てる唯一の経路の検証。渡した名前だけが消えること・置き場所の外に触れないこと・**汎用の削除APIが生えていないこと**・ソースに再帰削除が無いことまで固定する
- **`test/db-integrity.test.js`**: 意図的に壊したDBを渡して、破損を本当に検知できるか(正常系だけでは意味がないため)
- **`test/office-render.test.js`**: 変換サービスへ到達できないときに例外を投げないこと(落ちていてもアプリは動き続ける、という設計の根幹)
- **`test/mockup-zip.test.js`**: モックアップZIPの展開の検証。展開先の外を指すエントリ・シンボリックリンク・階層や件数の上限に加え、**展開後サイズを小さく偽ったZIP爆弾**でも膨らまないこと(ヘッダーの値を信じず`zlib`の`maxOutputLength`で頭打ちにする)
- **`test/mockup-token.test.js`**: モックアップ配信の引換券の検証。これは配信時に**認証の代わりになる**ため、偽造・対象の差し替え・期限の延長・使い回しを念入りに確かめる
- **`test/project-manifest.test.js`**: お品書きの組み立ての検証。並び順・入れ子・Markdown化に加え、**データが壊れていても資料を落とさないこと**(親が見つからないフォルダ・見つからない文書でも行を残す)
- **`test/integration-sqlite.test.js`**: 一時SQLiteに対する各モジュールのライフサイクル(projects/allowed-users/api-keys/tag-order/audit-log)
- **`test/integration-postgres.test.js`**: Postgres固有の検証(`schema_migrations`の適用、横断SSEのバックプレーンである`LISTEN/NOTIFY`が実際に通知を届けること)。`DATABASE_BACKEND=postgres`＋`DATABASE_URL`未設定時は全てスキップ(`npm run test:pg`で実行)
- **`test/api/`**: Playwright(`@playwright/test` のAPIリクエスト機能)による認証・認可の強制テスト。`serve.js` が認証を有効にしたまま(OIDC初期化のみ省略)テストサーバを起動し、APIキー(readonly/readwrite)で 401/403/200 とアップロード/アーカイブ/タグ/プロジェクトのCRUD、新しい版のアップロード(旧版のアーカイブ・タグとプロジェクト配置の引き継ぎ・版履歴・404/409)(`versions.spec.js`)、APIキーの有効期限(最長1年)、SkillのZIPダウンロード、および意味検索(ベクトル検索)を検証する。`*.spec.js` はブラウザを使わないため `npx playwright install` は不要
  - `test/api/` の webServer 環境変数はパススルー式(既定は sqlite + local)。`DATABASE_BACKEND=postgres`/`DATABASE_URL`/`STORAGE_BACKEND=s3`/`S3_*`/`AWS_*` を与えれば、同じAPIテストを **Postgres + S3(MinIO等)** 構成でも実行できる(実際にこの構成で全件パスを確認済み)
  - ブラウザE2E(`*.e2e.js`、`npm run test:e2e`)は、serve.jsが払い出した管理者のログイン済みセッションcookieをChromiumへ注入して操作する。保存型XSSがCSPで実際にブロックされること(`preview-xss.e2e.js`)と、アップロード→検索→タグ付け→プレビュー→APIキー発行・利用、.drawio(ビューアでの描画・ページ送り)、新しい版のアップロードと版履歴、APIキー管理画面からのSkill ZIPダウンロード(`ui-flow.e2e.js`)を検証する
  - `hardening.spec.js`は、防御ヘッダー・壊れたリクエストの応答・管理APIの権限(APIキーでは403)・応答に載る値の上限を、実サーバの応答として確認する(ミドルウェアの並び順やルートごとのヘッダー上書きで壊れるため)
  - `admin-pane.e2e.js`は管理画面(ページ切替・タブ・各タブの操作・adminでなければ開かないこと)を実ブラウザで確認する
  - モックアップは`mockups.spec.js`(登録・配信・引換券・置き場所の外への脱出・権限)、`mockups-archived-access.spec.js`(**アーカイブ済みへ至る経路の総当たり**。一覧を断るだけでは足りず、IDが分かれば中身に触れられてしまう穴を塞いだときに追加した)、`mockup-view.e2e.js`(実ブラウザで、JSは動くがオリジンを持たず、かつ**モックアップ自身のファイルが1つも遮断されないこと**)、`mockups-ui.e2e.js`(画面からの通し)で確認する
  - お品書きは`project-manifest.spec.js`(説明書きの保存・プロジェクトごとに別であること・Markdown・権限・施錠)と、`project-manifest.e2e.js`/`project-manifest-xss.e2e.js`(実ブラウザでの編集と、**仕込まれた文字列が実行されないこと**)で確認する
  - 意味検索のE2E(`vector-search.spec.js`)は `WEAVIATE_URL` を与えたときだけ実行される(未設定時は自動スキップし、代わりに503応答=機能無効を検証)。`WEAVIATE_URL`/`WEAVIATE_GRPC_PORT`/`WEAVIATE_VECTORIZER` を渡すと、アップロード→埋め込み→索引→意味検索ヒットまでを通しで検証する

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

> **Windows + Git Bash利用時の注意**: Git Bashは`-v`引数のパス(`$(pwd)/data:/data`等)をMSYSが独自に(誤って)変換してしまい、`/data`側まで書き換えられて`EACCES: permission denied`でコンテナが落ちることがある(実際にこのDocker検証中に再現した)。`docker run`の前に`MSYS_NO_PATHCONV=1`を付けるか、PowerShell/コマンドプロンプトから実行すること。`docker compose`はYAML内のパスを直接読むためこの問題が起きない。

## セマンティック検索(Weaviate)込みで起動する

セマンティック検索を使わない場合は上記の`docker run`単体構成のままでよい。使う場合は[docker-compose.yml](docker-compose.yml)でapp/Weaviate/Embedding推論サーバーの3コンテナを起動する。

```bash
docker compose up -d
```

- `app`: このリポジトリのDockerfileをビルドして起動(`WEAVIATE_URL`は自動設定される)。`OIDC_*`等の必須環境変数は`docker-compose.yml`内のenvironmentか`.env`ファイルで別途指定すること
- `weaviate`: ベクトルDB本体(OSS)。データは`weaviate_data`ボリュームに永続化される
- `t2v-transformers`: Embedding計算を行う推論サーバー(Weaviate公式、多言語sentence-transformersモデル)。既定の`WEAVIATE_VECTORIZER=text2vec-transformers`の場合のみ使われ、外部APIキーは不要

Cohere/OpenAIのEmbedding APIを使いたい場合は、`docker-compose.yml`自体を編集せず、`.env`ファイル(または環境変数)で以下のように上書きするだけでよい(`t2v-transformers`コンテナは未使用になるが動かしたままでも問題ない)。

```bash
# .env
WEAVIATE_VECTORIZER=text2vec-cohere
COHERE_APIKEY=<Cohereで発行したAPIキー>
```

初回起動時、Weaviateがコレクションを自動作成し、以後のアップロードから自動的に索引付けされる。`WEAVIATE_URL`を設定しなければこれらのコンテナは不要で、機能自体が無効化される(既存の単一コンテナ運用に影響しない)。

> **podmanで実行する場合**: イメージ名は `docker.io/` から完全指定すること(下記の手順は指定済み)。podmanは短い名前を`/etc/containers/registries.conf`の`unqualified-search-registries`から解決するため、RHEL系ホストでは`registry.access.redhat.com`を先に探して`Repo not found`で失敗する。

### `docker compose`を使わずにWeaviateも起動する場合

Kubernetes等、`docker compose`を前提にできない環境向けに、[docker-compose.yml](docker-compose.yml)と同じ構成(コンテナ間の環境変数・ポート・ボリューム)を`docker run`だけで再現する手順。コンテナ名で名前解決できるよう、まずユーザー定義ネットワークを作成する。

```bash
# 1. コンテナ間通信用のネットワークを作成(初回のみ)
docker network create document-manager-net

# 2. Embedding推論サーバー(WEAVIATE_VECTORIZER=text2vec-transformers、既定の場合のみ必要。
#    Cohere/OpenAIを使う場合はこのコンテナ自体を起動しなくてよい)
docker run -d \
  --name t2v-transformers \
  --network document-manager-net \
  --restart unless-stopped \
  -e ENABLE_CUDA=0 \
  docker.io/semitechnologies/transformers-inference:sentence-transformers-paraphrase-multilingual-mpnet-base-v2

# 3. Weaviate本体(REST:8081→8080, gRPC:50051→50051でホストに公開。無くても動くが
#    動作確認・デバッグ用に外部からも叩けるようにしている)
docker run -d \
  --name weaviate \
  --network document-manager-net \
  --restart unless-stopped \
  -p 8081:8080 \
  -p 50051:50051 \
  -v weaviate_data:/var/lib/weaviate \
  -e QUERY_DEFAULTS_LIMIT=25 \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true \
  -e PERSISTENCE_DATA_PATH=/var/lib/weaviate \
  -e ENABLE_MODULES=text2vec-transformers,text2vec-cohere,text2vec-openai,text2vec-aws \
  -e DEFAULT_VECTORIZER_MODULE=text2vec-transformers \
  -e TRANSFORMERS_INFERENCE_API=http://t2v-transformers:8080 \
  -e CLUSTER_HOSTNAME=node1 \
  docker.io/semitechnologies/weaviate:latest

# 4. document-manager本体(同じネットワークに参加させ、WEAVIATE_URLはコンテナ名で指定)
docker build -t document-manager .

# Windows + Git Bashの場合、-vのパスをMSYSに誤変換されないようMSYS_NO_PATHCONV=1を付けること
# (付けないと/data側まで巻き込まれてEACCESでコンテナが落ちる。上記「Dockerビルド・起動」の注意点と同じ)
MSYS_NO_PATHCONV=1 docker run -d \
  --name document-manager \
  --network document-manager-net \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e WEAVIATE_URL="http://weaviate:8080" \
  -e WEAVIATE_GRPC_PORT="50051" \
  -e OIDC_ISSUER="https://login.microsoftonline.com/<TENANT_ID>/v2.0" \
  -e OIDC_CLIENT_ID="<CLIENT_ID>" \
  -e OIDC_CLIENT_SECRET="<CLIENT_SECRET>" \
  -e OIDC_REDIRECT_URI="https://your-domain.example.com/document_management/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="<ランダムな文字列>" \
  document-manager
```

Cohere(SaaS)/OpenAI/Cohere on AWS Bedrockを使う場合は手順2を省略し、手順4に`-e WEAVIATE_VECTORIZER="text2vec-cohere" -e COHERE_APIKEY="<APIキー>"`(OpenAIなら`text2vec-openai`/`OPENAI_APIKEY`、AWS Bedrockなら`text2vec-aws`/`AWS_BEDROCK_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`)を追加するだけでよい。手順3の`weaviate`はENABLE_MODULESにあらかじめ全方式含めてあるため、Weaviate側の設定変更は不要。

停止・削除する場合は次の順序で(依存関係の都合上、appから止めるのが無難)。

```bash
docker rm -f document-manager weaviate t2v-transformers
docker network rm document-manager-net
# ベクトルDBのデータ自体を消したい場合のみ(通常は残してよい)
docker volume rm weaviate_data
```

## 運用サーバ(podman + Apacheリバースプロキシ)へのcompose導入

既に `podman run` で単体運用しているサーバに、セマンティック検索(Weaviate)を足してcompose運用へ移す場合の手順。
[deploy/compose.yml](deploy/compose.yml) と [deploy/compose.sh](deploy/compose.sh) を用意してある(リポジトリ直下の
`docker-compose.yml` は開発・お試し用で、ソースからビルドしWeaviateのポートもホストへ公開する)。

運用向けの構成として、次の点を変えてある。

- アプリはビルドせず公開イメージ(`docker.io/earce9000/document-manager`)を使う
- **Weaviate・推論サーバーはホストにポートを公開しない**(内部ネットワークのみ)。Weaviateは匿名アクセス有効のため、公開すると外部から触れてしまう
- **アプリは既存の外部ネットワークに固定IPで参加する**ため、**Apache側の設定変更は不要**
- データはホストのディレクトリに置く(文書・SQLite: 既存のまま / Weaviate: `/var/db/weaviate`)

```bash
# 1. 設定ファイルを用意する(サイト固有の値。リポジトリにはコミットしない)
cp deploy/compose.env.example /etc/application-auth/document-manager.env
chmod 600 /etc/application-auth/document-manager.env
vi /etc/application-auth/document-manager.env   # ドメイン・固定IP・データの場所・シークレットを記入

# 2. Weaviateのデータ用ディレクトリ(初回のみ。パスは上の設定に合わせる)
mkdir -p /var/lib/document-manager/weaviate

# 3. podman-compose(未導入なら)
dnf install -y podman-compose   # または pip install podman-compose

# 4. 起動(既存の podman run 版コンテナは停止・削除しておく)
podman rm -f document_manager
./deploy/compose.sh up

# 5. 変換サービスを使う場合は、隔離が実際に効いているか確かめる
#    (podman-composeの版によっては internal: true が反映されないため、設定だけでは保証にならない)
./deploy/check-converter-isolation.sh
```

- **サイト固有の値(ドメイン・内部IP・データの場所・シークレット)はリポジトリに置かない**。`deploy/compose.env.example` をコピーしてサーバ上のGit管理外の場所(既定は `/etc/application-auth/document-manager.env`、権限は600)に置き、そこに書く。置き場所は `DOCUMENT_MANAGER_ENV` で変更できる
- 既に `/etc/application-auth/*.sh` 等で `OIDC_*` を `export` している場合は、それを `source` してから `./deploy/compose.sh up` を呼んでもよい(環境変数が優先される)
- 必須の値(`OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_REDIRECT_URI` / `SESSION_SECRET` / `DOCUMENT_MANAGER_IP`)が欠けている場合は起動せずにエラーを出す
- 切り戻したい場合はイメージのタグを指定する: `DOCUMENT_MANAGER_TAG=<日時タグ> ./deploy/compose.sh up`
- SELinuxが有効(`getenforce` が `Enforcing`)なホストでは、ボリュームの `:z` が必要(compose.ymlには付けてある)
- 外部ネットワーク(`application_network`)はcomposeでは作成しない(`external: true`)。既存のものをそのまま使うため、Apacheのリバースプロキシ設定は変更不要
- **更新は `./deploy/compose.sh up` を実行するだけ**(`pull` → `up -d` → 入れ替わったかの確認、まで行う)。`podman-compose`の版によっては、タグが同じ(`latest`)だと新しいイメージを取得しても`up -d`がコンテナを作り直さず、**古いイメージのまま成功したように見える**。そのため`up`の最後に、動いているコンテナのイメージIDと取得したイメージのIDを突き合わせ、食い違っていればそのコンテナだけ作り直す(関係ないサービスは止めないので、Weaviate等は動いたまま)。それでも入れ替わらなければ終了コード1で終わる
- 変更せずに確認だけしたい場合は `./deploy/compose.sh verify`。動作中のアプリの版・リビジョン(イメージに焼き込んだ`/app/VERSION.json`)も表示する
- 展開できたかどうかは、画面右上の歯車(管理)→「サーバー」タブの**ビルド時刻**、または認証不要の `GET /api/version` でも分かる。更新したはずなのに変わっていなければ入れ替わっていない
- 変換サービス(converter)は`depends_on`に入れていない。イメージの取得や起動に失敗しても、アプリまで起動しなくなることは無い(体裁つき表示だけが使えなくなる)

導入後、**既存の文書がバックグラウンドで順次索引付けされる**(1件あたり数秒。実測で約5.5秒/件)。進行状況は画面の「ベクトル索引」から確認できる。索引付け中はCPUを複数コア使い切るため、同居サービスがある場合は業務時間外に始めるか、`compose.yml` の `cpus`/`mem_limit` で上限を設けるとよい。

必要なメモリの目安は、Weaviate本体が数百MB、推論サーバーが約1.0〜1.4GB(負荷に応じて増減)。

## 性能検証結果(実測)

Docker Desktop(Windows 11、GPU無し)の実機で、SQLite単体・ベクトル検索の2パターンを実測した記録。テストデータは実際の文学作品106件(青空文庫スタイルの日本語作品+Project Gutenbergの英語原文、合計約1.1MB・平均約10KB/件)。合成的な短文ではなく実文書での結果である点に注意。

> 検索結果のリランキング(クロスエンコーダによる再スコアリング)は、CPU実行時に候補1件あたり約400〜550ms(実文書では約1.7〜1.8秒)かかり、既定の候補数(`limit×3`)ではWeaviateの30秒タイムアウトを超えて検索結果が空で返ることを実測で確認した。加えて、Weaviate公式のプリビルドイメージで多言語対応かつ非中国系のクロスエンコーダが存在しなかったため、機能自体を実装から削除している。

### アップロードAPI応答時間・バックグラウンド索引付け・検索速度・メモリ・CPU

| パターン | アップロードAPI応答時間 | 検索速度 | 追加メモリ | CPU |
|---|---|---|---|---|
| ① SQLite単体 | 約4.1秒/件(帯域幅・Windowsのbind-mount I/O込み) | **148ms** | +0MB | - |
| ② ベクトル検索のみ(`mpnet-base-v2`) | **約510ms/件**(SQLite単体とほぼ同水準。埋め込み計算の完了は待たない) | **約340ms**(索引付けが同時進行していない場合) | weaviate + t2v-transformersで約+1.0〜1.4GB(負荷に応じて増減、主にt2v-transformers) | t2v-transformersはピーク約380〜413%・平均約245〜280%(複数コアを使い切る負荷) |

②は現在の既定モデル(`sentence-transformers-paraphrase-multilingual-mpnet-base-v2`)、かつ[索引付けの非同期化](#文書管理)後の実測値。アップロードAPI自体は非同期化によりSQLite単体とほぼ同じ速度まで回復した一方、**Weaviate側への実際の登録(埋め込み計算)は約5.5秒/件のスループットでバックグラウンド処理される**(106件で約8分)。索引付けがバックグラウンドで進行中は検索速度も低下する(実測で640ms〜1.3秒。同じCPUリソースを取り合うため)。旧既定モデル(MiniLM-L12-v2、約2.3秒/件・アイドル時828MB)と比べてモデルサイズが大きい分、埋め込み計算のスループット・メモリ・CPU負荷はいずれも増加しているが、[既知の制約](#既知の制約-多言語埋め込みモデルのクロスリンガル性能)にある通りクロスリンガル検索精度が大きく向上するためのトレードオフとして採用している。

### 既知の制約: 多言語埋め込みモデルのクロスリンガル性能

埋め込みモデルは、**クエリと文書で言語が異なる場合に精度が落ちる**傾向がある。当初の既定モデル(`sentence-transformers-paraphrase-multilingual-MiniLM-L12-v2`)で実測したところ、同一の英語文書(`Alice's Adventures in Wonderland`の一節、体が小さくなる場面を含む)に対して、日本語クエリの距離(0.810)が英語クエリの距離(0.470)よりも大きく悪化する現象を確認した。106件中に日本語訳ではなく英語原文で登録されたAlice関連文書があったところ、日本語クエリでは他の日本語文書に押しのけられて上位に出てこなかった。

このため、Weaviate公式のプリビルドイメージの中から代替候補を比較検証した(候補の選定にあたっては、地政学的リスクを避ける観点から中国系の開発元(BAAI等)のモデルは除外している)。

| モデル | 開発元 | JP/EN距離差 | 日本語クエリでのAlice順位(全10文書中、日本語文書8件との混在) |
|---|---|---|---|
| MiniLM-L12-v2(旧既定) | UKP Lab(独) | 0.810 / 0.470(差0.34) | 候補にすら入らないことがあった |
| Microsoft `multilingual-e5-large` | Microsoft(米) | 0.183 / 0.166(差0.017) | 9〜10位(最下位) |
| **mpnet-base-v2(新既定)** | UKP Lab(独) | 0.422 / 0.361(差0.06) | **1〜2位** |

意外なことに、クロスリンガルの距離差が最も小さいe5-largeは、実際のランキングでは依然として同一言語の文書を優先する「言語クラスタリング」の影響を強く受け、Alice文書を最下位に沈めた。一方、**現行モデルと同じ開発元(UKP Lab)による上位版のmpnet-base-v2は、実際のランキングでAlice文書を1〜2位に正しく押し上げた**ため、こちらを新しい既定モデルとして採用した。この問題への対応が引き続き重要な場合は、`WEAVIATE_VECTORIZER=text2vec-cohere`等、より高精度な外部APIへの切り替えも検討できる。

### チャンクサイズの実測(モデルの最大シーケンス長との関係)

既定モデル(mpnet-base-v2)の最大シーケンス長は128トークンだが、旧既定のチャンクサイズ(400文字)で実際に生成されるチャンクをトークナイザーで実測したところ、106件のサンプル文書全体で**25.4%のチャンクが128トークンを超過**していた(日本語は約2.0文字/トークンで、英語よりトークン効率が悪いため)。

推論サーバーに直接問い合わせて確認したところ、128トークンを超えても内容が単純に切り捨てられるわけではない(共通の100トークン分の前置きに対し、200トークン超の異なる続きを持つ2つの文章を投げたところ、埋め込みベクトルは明確に異なる結果になった)。ただし、モデルは128トークン程度の短い文を想定して学習されているため、それを大きく超える長さを平均プーリングすると、embeddingの識別力が薄まる(検索精度が下がる)懸念がある。

複数のチャンクサイズを実際のサンプル文書(106件)で比較した結果:

| チャンクサイズ/オーバーラップ | 128トークン超過率 | p90トークン数 |
|---|---|---|
| 400文字/50文字(旧既定) | 25.4% | 241 |
| 250文字/30文字 | 18.6% | 159 |
| **180文字/20文字(新既定)** | **6.2%** | **119** |

180文字/20文字を新しい既定値とした。これでもp99(183トークン)・最大(197〜349トークン、文書による)は128を超えることがあるが、日本語・英語が混在するコーパスで文字数ベースの分割を使う以上、全チャンクを128トークン以内に完全に収めるにはチャンクサイズをかなり小さくする必要があり、今度は1チャンクあたりの意味的なまとまりが失われるトレードオフが生じる。既定値は「大半のチャンクを設計上の範囲に収めつつ、極端に小さくしすぎない」バランスを取ったものであり、チャンクサイズ・オーバーラップは環境変数または「ベクトル索引」画面から用途に応じて調整できる。

**実際の検索精度でも検証済み**: 106件の文書それぞれから抜粋した一節を検索クエリとして使い(「自分自身を検索して見つかるか」というセルフリトリーバル評価)、複数のチャンクサイズでRecall@5(上位5件に正解文書が入る割合)とMRR(平均逆順位)を比較した。

| チャンクサイズ/オーバーラップ | Recall@5 | Recall@10 | MRR |
|---|---|---|---|
| **180文字/20文字(既定値)** | **100.0%** | **100.0%** | **0.979** |
| 250文字/30文字 | 96.2% | 96.2% | 0.948 |
| 300文字/40文字 | 94.3% | 94.3% | 0.909 |
| 400文字/50文字(旧既定) | 92.5% | 94.3% | 0.855 |

チャンクサイズが小さいほど一貫して精度が向上し、180文字/20文字が最良の結果(Recall@5=100%)だった。トークン予算の理論的な推測と実際の検索精度の両面から、この値が妥当であることを確認している。

なお、この検証の過程で`chunkText`(段落分割)の実バグを発見した。Windows形式の改行(`\r\n`)を含む文書では、段落境界を検出する正規表現(`/\n{2,}/`)が一致せず、**文書全体が1つの段落として扱われ、文脈を無視した固定長分割にフォールバックしてしまっていた**(修正済み)。このバグの影響下では、逆にチャンクサイズを小さくするとかえって検索精度が悪化する現象が見られたため、チャンクサイズを調整する場合は最新版で改行コードの問題が修正されていることを前提にすること。

## DockerHubから利用する

ビルド済みイメージは [earce9000/document-manager](https://hub.docker.com/r/earce9000/document-manager) として公開している(`linux/amd64`/`linux/arm64`対応)。`main`ブランチへのpushのたびに、`latest`と`YYYYMMDD_HHmmss`(JST、ビルド日時)タグが自動的にビルド・公開される([.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml))。特定時点のビルドに固定したい場合は日時タグでpullする。

```bash
docker pull earce9000/document-manager:latest

# Windows + Git Bashの場合はMSYS_NO_PATHCONV=1を付けること(「Dockerビルド・起動」の注意点参照)
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

`Dockerfile` は `node:22-alpine` ベースの2ステージ構成。依存のインストール(`npm install`)はビルドホスト本来のアーキテクチャで動く`deps`ステージ(`--platform=$BUILDPLATFORM`)で行い、`npm`の`--os`/`--cpu`/`--libc`でターゲット向けのパッケージを選んでから、`node_modules`だけを実行用イメージへコピーする。arm64イメージをamd64のCIでビルドする際、QEMUエミュレーション上でnodeを動かすとIllegal instruction(exit code 132)で落ちることがあるため、エミュレーション下ではnodeを一切実行しない構成にしている。`better-sqlite3` は全プラットフォームのprebuiltバイナリを同梱しているため、ビルドツール(python3/make/g++)は不要。**npmでインストールすること**(yarn classicはprebuiltバイナリの検出ロジックを持たず、常にソースビルドを試みて失敗する)。

### CI/CD(GitHub Actions)

| ワークフロー | きっかけ | 内容 |
|---|---|---|
| [docker-publish.yml](.github/workflows/docker-publish.yml) | `main`へのpush | Dockerイメージ(`linux/amd64`/`linux/arm64`)をビルドし、Docker Hubへ`latest`と`YYYYMMDD_HHmmss`タグで公開 |
| [skill-package.yml](.github/workflows/skill-package.yml) | Skill関連ファイルを変更したpush/PR、手動実行 | Skillのクライアントの結合テスト・ZIP作成を行い、アーティファクト`document-manager-skill`として保存 |
| 同上 | タグ`skill-v*`のpush | 上記に加えて、ZIPを添付したGitHub Releaseを作成 |

## License

[MIT License](LICENSE)

依存パッケージ(直接依存・間接依存を含む)は MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / 0BSD / BlueOak-1.0.0 のみで構成されており、コピーレフト系ライセンス(GPL/AGPL/LGPL等)は含まれない。

同梱している第三者のファイル:

| ファイル | 出典 | ライセンス |
|---|---|---|
| [app/static/vendor/drawio/viewer-static.min.js](app/static/vendor/drawio/viewer-static.min.js) | [jgraph/drawio](https://github.com/jgraph/drawio) v31.4.6 | Apache-2.0([全文](app/static/vendor/drawio/LICENSE)) |
