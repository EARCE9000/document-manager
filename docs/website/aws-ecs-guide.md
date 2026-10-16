<!--
www.earce.biz に投稿する構築ガイド(AWS 編)の下書き。

状態: **未検証の下書き**。実際に構築して、末尾の「公開前に確かめること」をすべて埋めてから公開する。
確かめた日付とイメージのタグを本文冒頭の「この記事について」に書き入れる。

本文中の環境変数・S3 の操作・ヘルスチェックのパスなどは、リポジトリの実装(app/server.js、
app/lib/storage.js、app/lib/datastore.js)と README の「環境変数」「マルチクラウド構成の要点」から
拾ったもの。それらを変えたら、この記事も見直す。
-->

# Document Manager を AWS で動かす(ECS Fargate + S3 + RDS for PostgreSQL)

## この記事について

Document Manager を AWS のマネージドサービスだけで動かす手順です。サーバーの面倒を見ずに済み、利用者が増えたらコンテナの数を増やせる構成になります。

- 確認した日: **(記入)**
- 使ったイメージ: `earce9000/document-manager:` **(タグを記入)**
- リージョン: **(記入。例: ap-northeast-1)**

この記事では**最小構成**を扱います。Office 文書の体裁つき表示・PDF でダウンロード(変換サービス)と、意味検索(Weaviate)は入れません。どちらも無くても、文書の登録・プレビュー・全文検索・版管理・AI エージェントからの操作はすべて使えます。

## できあがる構成

```
利用者のブラウザ / AI エージェント
        │ HTTPS
        ▼
Application Load Balancer(パブリックサブネット、ACM の証明書)
        │ HTTP :8080
        ▼
ECS on Fargate: document-manager(プライベートサブネット)
        ├──▶ RDS for PostgreSQL(プライベートサブネット) … 文書の情報・タグ・セッション
        ├──▶ S3 バケット(ゲートウェイ型 VPC エンドポイント経由) … 文書ファイル本体
        └──▶ NAT ゲートウェイ → インターネット … OpenID Connect のプロバイダ、イメージの取得
```

**(図を描いて差し替える)**

| 役割 | 使うサービス | アプリ側の設定 |
|---|---|---|
| アプリ | ECS on Fargate | Docker Hub のイメージをそのまま使う |
| 文書の情報・セッション | RDS for PostgreSQL | `DATABASE_BACKEND=postgres` |
| 文書ファイル | S3 | `STORAGE_BACKEND=s3` |
| 入口 | Application Load Balancer + ACM | — |
| 秘密情報 | Secrets Manager | タスク定義の `secrets` で渡す |

### Aurora ではなく RDS for PostgreSQL を選ぶ理由

Document Manager は、誰かが文書を上げたりタグを付けたりすると、他の人の画面を自動で更新します。コンテナが複数台あるとき、この通知は PostgreSQL の `LISTEN/NOTIFY` で台をまたいで届けています。**Aurora PostgreSQL はこの機能に対応していない**ため、複数台にすると、別の台につながっている人の画面が自動では更新されなくなります(データ自体は正しく共有されます)。1台で動かすなら Aurora でも問題ありませんが、あとで台数を増やすことを考えると、最初から RDS for PostgreSQL にしておくのが無難です。

## 事前に用意するもの

- **公開するドメイン名**と、ACM で発行した証明書(例: `docs.example.com`)
- **OpenID Connect のプロバイダ**(Entra ID・Google・Cognito など)で作ったクライアント
  - コールバック URL に `https://docs.example.com/login` を登録する
  - クライアント ID とクライアントシークレットを控えておく
- **最初の管理者のメールアドレス**(`ADMIN_EMAIL` に使う)

## 手順

### 1. ネットワーク(VPC)

- パブリックサブネットとプライベートサブネットを、それぞれ 2 つのアベイラビリティゾーンに作る
- **NAT ゲートウェイ**を置き、プライベートサブネットから外に出られるようにする。アプリはログインのたびに OpenID Connect のプロバイダと通信するため、外への通信が必要です
- **S3 のゲートウェイ型 VPC エンドポイント**を作り、プライベートサブネットのルートテーブルに関連付ける。文書ファイルの読み書きが NAT を通らなくなり、転送料がかかりません

セキュリティグループは 3 つ用意します。

| 名前 | 受け付ける通信 |
|---|---|
| `dm-alb` | インターネットから 443 |
| `dm-app` | `dm-alb` から 8080 だけ |
| `dm-db` | `dm-app` から 5432 だけ |

### 2. S3 バケット

- バケットを作る(例: `example-document-manager`)。**パブリックアクセスはすべてブロック**のままにする
- 文書は `documents/` の下に置かれます(`S3_PREFIX` で変えられます)
- アプリは「アーカイブ」で論理削除するだけで、ファイルを消すことはほとんどありません。誤操作に備えるなら、バージョニングを有効にしておくと安心です

### 3. RDS for PostgreSQL

- エンジンは PostgreSQL、配置はプライベートサブネット、セキュリティグループは `dm-db`
- 最初のデータベース名を `document_manager` などにしておく
- テーブルは**アプリが起動時に自動で作ります**。手で SQL を流す必要はありません
- 接続文字列を Secrets Manager に保存する(次の手順)

### 4. Secrets Manager

次の 3 つを保存します。

| 名前(例) | 中身 |
|---|---|
| `dm/database-url` | `postgres://<ユーザー>:<パスワード>@<RDSのエンドポイント>:5432/document_manager` |
| `dm/oidc-client-secret` | OpenID Connect のクライアントシークレット |
| `dm/session-secret` | `openssl rand -hex 32` で作った値 |

`SESSION_SECRET` は必ず固定の値を渡してください。渡さないと、コンテナが入れ替わるたびに全員がログアウトされます。

### 5. IAM ロール

**タスク実行ロール**(ECS がコンテナを起動するときに使う):
- `AmazonECSTaskExecutionRolePolicy`
- 上の Secrets Manager の値を読む権限(`secretsmanager:GetSecretValue`)

**タスクロール**(アプリが S3 を読み書きするときに使う)。アプリは AWS SDK の標準の方法で認証するので、アクセスキーを渡す必要はありません。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::example-document-manager/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::example-document-manager"
    }
  ]
}
```

`s3:ListBucket` は一覧を取るためではありません。アプリは「ファイルがあるか」を確かめるときに、存在しなければ 404 が返ることを前提にしています。この権限が無いと、S3 は 404 の代わりに 403 を返すため、ファイルが無いだけなのにエラー扱いになります。

### 6. イメージの置き場所

Docker Hub から直接取得することもできますが、**ECR のプルスルーキャッシュ**を使って ECR 経由で取得するのがおすすめです。Docker Hub の匿名での取得回数の制限を気にしなくてよくなり、起動も安定します。

### 7. ECS のタスク定義

- 起動タイプ: Fargate、OS は Linux(イメージは x86_64 と ARM64 の両方を用意しています)
- CPU・メモリ: **(実測して記入。まずは 1 vCPU / 2 GB から)**
- ポート: 8080
- ヘルスチェック: イメージに組み込み済み(`/_ping`)

環境変数:

| 変数 | 値 |
|---|---|
| `BASE_PATH` | `/` |
| `DATABASE_BACKEND` | `postgres` |
| `DATABASE_SSL` | `true` |
| `STORAGE_BACKEND` | `s3` |
| `S3_BUCKET` | `example-document-manager` |
| `S3_REGION` | `ap-northeast-1` |
| `OIDC_ISSUER` | プロバイダの issuer URL |
| `OIDC_CLIENT_ID` | クライアント ID |
| `OIDC_REDIRECT_URI` | `https://docs.example.com/login` |
| `ADMIN_EMAIL` | 最初の管理者のメールアドレス |

`secrets`(Secrets Manager から渡す):

| 変数 | 参照先 |
|---|---|
| `DATABASE_URL` | `dm/database-url` |
| `OIDC_CLIENT_SECRET` | `dm/oidc-client-secret` |
| `SESSION_SECRET` | `dm/session-secret` |

永続ボリュームは不要です。文書の情報は RDS、ファイルは S3 にあるため、コンテナを作り直しても何も失われません。

### 8. ロードバランサーとサービス

- ALB をパブリックサブネットに作り、443 のリスナーに ACM の証明書を付ける。80 は 443 へリダイレクトする
- ターゲットグループ: ターゲットタイプ `ip`、ポート 8080、ヘルスチェックのパス `/_ping`
- ECS サービスをプライベートサブネットに作り、このターゲットグループにつなぐ。パブリック IP は付けない
- まずは**タスク数 1** で始める
- Route 53 で `docs.example.com` を ALB に向ける

### 9. 最初のログイン

`https://docs.example.com/` を開くと、ログイン画面へ移ります。`ADMIN_EMAIL` のアドレスでログインすると、その人が管理者として登録されます。そのあと、画面右上の利用者アイコンから、使う人のメールアドレスを許可リストに足してください。

## 動いたら確かめること

- 文書をアップロードして、S3 の `documents/` の下にファイルができる
- PDF を開いて、ページ送りができる(S3 からの部分取得が動いている)
- 2 つのブラウザで開き、片方でタグを付けると、もう片方の画面が自動で更新される
- タスクを停止して作り直しても、ログインしたままで、文書も残っている

## 台数を増やすとき

ECS サービスのタスク数を 2 以上にするだけです。セッションは RDS に保存されているので、どのコンテナにつながってもログインしたままになります。ALB のスティッキーセッションも不要です。

ひとつだけ制約があります。文書の索引付けの順番待ちはコンテナごとに管理しているため、同じ文書への操作が別々のコンテナに届くと、索引付けが二重に走ることがあります。結果が壊れることはありません。

## 費用の目安

**(実際の請求額を見て記入)**

最小構成では、NAT ゲートウェイ・ALB・RDS の時間課金が費用の大部分を占めます。S3 と Fargate は、使った分だけかかります。

## 次の記事

- 変換サービスを足す(Office 文書の体裁つき表示・PDF でダウンロード)。外に出られない場所で動かす必要があります
- 意味検索を足す(Weaviate Cloud、または Bedrock の埋め込みモデル)

<!--
## 公開前に確かめること(実際に構築して埋める。終わったらこの節ごと消す)

- [ ] 上の手順どおりに作って、最初のログインまで通る
- [ ] RDS で DATABASE_SSL=true が必要か(PostgreSQL 15 以降の既定は rds.force_ssl=1 のはず)
- [ ] DATABASE_URL のパスワードに記号があるとき、URL エンコードが要るか
- [ ] s3:ListBucket を外すと本当にエラーになるか(記事の説明が正しいか)
- [ ] タスクのサイズ(CPU・メモリ)。Office 文書や大きな PDF を上げたときのメモリの山
- [ ] ALB のアイドルタイムアウト(既定 60 秒)で、画面の自動更新(SSE)が切れないか
      アプリは 30 秒ごとに heartbeat を送っているので切れないはず
- [ ] 256MB のファイルのアップロードが ALB 経由で通るか、時間はどれくらいか
- [ ] trust proxy は 1 段の前提。ALB だけなら正しく利用者の IP が取れる。
      CloudFront を前に置く構成は 2 段になるので、この記事では扱わない
- [ ] ECR プルスルーキャッシュの設定手順(Docker Hub の認証情報が要るか)
- [ ] 1 か月動かした費用
- [ ] 構成図
-->
