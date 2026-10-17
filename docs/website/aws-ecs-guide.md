<!--
www.earce.biz に載せる構築ガイド(AWS 編)の原稿。紹介ページ「Document Manager」の子の固定ページ
(page_id=2867、スラッグ `document-manager-aws`、下書き)として入れてある。サイトでは投稿機能は使わない。

状態: **未検証**。テンプレート(deploy/aws/document-manager-ecs.yaml)は cfn-lint を通しているが、
実際にスタックを作って確かめてはいない。末尾の「公開前に確かめること」を埋めてから公開する。

図とテンプレートは GitHub の raw URL で参照している(push すればサイト側にも出る)。
- 図: docs/website/aws-ecs-architecture.svg を直して PNG を作り直す(2 倍で書き出す)
- テンプレート: deploy/aws/document-manager-ecs.yaml

本文の値・動き(PG* 環境変数、s3:ListBucket が要る理由、/_ping、LISTEN/NOTIFY)は、
app/server.js・app/lib/storage.js・app/lib/datastore.js と README から拾ったもの。変えたら見直す。
-->

# Document Manager を AWS で動かす(ECS Fargate + S3 + RDS for PostgreSQL)

## この記事について

Document Manager を AWS のマネージドサービスで動かす手順です。用意した CloudFormation テンプレートで、ネットワークからアプリ・データベース・証明書・DNS まで一度に作れます。サーバーの面倒を見る必要がなく、利用者が増えたらコンテナの台数を増やすだけで対応できます。

- 確認した日: **(記入)**
- 確認したイメージのタグ: **(記入)**

この記事では**最小構成**を扱います。Office 文書の体裁つき表示・PDF でダウンロード(変換サービス)と、意味検索(Weaviate)は入れません。どちらも無くても、文書の登録・プレビュー・全文検索・版管理・AI エージェントからの操作はすべて使えます。

## できあがる構成

![Document Manager の AWS 構成](https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/website/aws-ecs-architecture.png)

| 役割 | 使うサービス | 中身 |
|---|---|---|
| 入口 | Application Load Balancer + ACM | HTTPS で受けて、アプリへ転送する。証明書は自動で発行・更新される |
| アプリ | ECS on Fargate | Docker Hub の公式イメージをそのまま動かす。プライベートサブネットに置き、外から直接は届かない |
| 文書の情報・セッション | RDS for PostgreSQL 17 | 文書の名前・タグ・版・ログイン状態などを持つ |
| 文書ファイル | S3 | アップロードされたファイル本体。VPC エンドポイント経由で読み書きする |
| 秘密情報 | Secrets Manager | DB のパスワード、セッションの署名鍵、OpenID Connect のクライアントシークレット |
| ログ | CloudWatch Logs | アプリのログを 30 日残す |
| 名前 | Route 53 | 公開するホスト名を ALB に向ける |

### Aurora ではなく RDS for PostgreSQL にしている理由

Document Manager は、誰かが文書を上げたりタグを付けたりすると、ほかの人の画面を自動で更新します。コンテナが複数台あるとき、この通知は PostgreSQL の `LISTEN/NOTIFY` で台をまたいで届けています。**Aurora PostgreSQL はこの機能に対応していない**ため、台数を増やすと、別の台につながっている人の画面が自動では更新されなくなります(データ自体は正しく共有されます)。

## 始める前に用意するもの

1. **Route 53 のホストゾーン**
   公開するホスト名を管理しているホストゾーンが、同じ AWS アカウントの Route 53 にあること。テンプレートが、このゾーンに証明書の検証用レコードと、ALB へのレコードを自動で作ります。
2. **OpenID Connect のクライアント**
   Entra ID・Google・Cognito など、使っている認証基盤でクライアント(アプリの登録)を作ります。
   - コールバック URL(リダイレクト URI)に `https://<公開するホスト名>/login` を登録する
   - クライアント ID とクライアントシークレットを控えておく
   - issuer の URL を控えておく(Entra ID なら `https://login.microsoftonline.com/<テナント ID>/v2.0`)
3. **AWS アカウントの権限**
   VPC・ECS・RDS・S3・IAM ロール・Secrets Manager・ACM・Route 53 を作れる権限。

## 最初に決める値

スタックを作るときに入力するのは、次の値だけです。バケット名・DB のパスワード・セッションの署名鍵などは、テンプレートが自動で作ります。

| パラメーター | 入れるもの | 既定値 |
|---|---|---|
| `DomainName` | 利用者が開くホスト名。`HostedZoneId` のゾーンの中の名前にする | — |
| `HostedZoneId` | そのホスト名を管理している Route 53 のホストゾーン | — |
| `OidcIssuer` | OpenID Connect の issuer URL | — |
| `OidcClientId` | クライアント ID | — |
| `OidcClientSecret` | クライアントシークレット(画面には表示されない) | — |
| `AdminEmail` | 最初の管理者のメールアドレス | — |
| `ImageTag` | イメージのタグ。版を固定するなら日付のタグを入れる | `latest` |
| `DesiredCount` | コンテナの台数 | `1` |
| `TaskCpu` / `TaskMemory` | コンテナ 1 台の CPU とメモリ | `1024` / `2048` |
| `DbInstanceClass` | RDS のインスタンスクラス | `db.t4g.micro` |
| `DbAllocatedStorage` | RDS のストレージ(GiB) | `20` |
| `DbMultiAz` | RDS をマルチ AZ にするか | `false` |

## 手順

### 1. テンプレートを取得する

[document-manager-ecs.yaml](https://raw.githubusercontent.com/EARCE9000/document-manager/main/deploy/aws/document-manager-ecs.yaml) を保存します(GitHub リポジトリの `deploy/aws/` にあります)。

### 2. スタックを作る

**マネジメントコンソールで作る場合**

1. 使うリージョンで CloudFormation を開き、「スタックの作成」→「新しいリソースを使用(標準)」を選ぶ
2. 「テンプレートファイルのアップロード」で、保存した `document-manager-ecs.yaml` を選ぶ
3. スタック名を入れる(英小文字とハイフンで短く。秘密情報やログの名前の先頭に使われます)
4. 「最初に決める値」を入力する
5. 最後の画面で「AWS CloudFormation によって IAM リソースが作成される場合があることを承認します」にチェックを入れて、作成する

**AWS CLI で作る場合**

```
aws cloudformation deploy \
  --stack-name <スタック名> \
  --template-file document-manager-ecs.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    DomainName=<公開するホスト名> \
    HostedZoneId=<ホストゾーン ID> \
    OidcIssuer=<issuer の URL> \
    OidcClientId=<クライアント ID> \
    OidcClientSecret=<クライアントシークレット> \
    AdminEmail=<最初の管理者のメールアドレス>
```

できあがるまで **(実測して記入)** 分ほどかかります。時間がかかるのは主に RDS と証明書の検証です。

### 3. 開いてみる

スタックの「出力」に `Url` が出ます。開くとログイン画面へ移ります。

`AdminEmail` のアドレスでログインすると、その人が管理者として登録されます。そのあと、画面右上の利用者アイコンから、使う人のメールアドレスを許可リストに足してください。権限は、管理者・読み書き・閲覧のみから選べます。

### 4. 動いていることを確かめる

- 文書をアップロードして、出力の `DocumentBucketName` のバケットの `documents/` の下にファイルができる
- PDF を開いて、ページ送りができる(S3 からの部分取得が動いている)
- 2 つのブラウザで開き、片方でタグを付けると、もう片方の画面が自動で更新される
- ECS のタスクを停止しても、新しいタスクが立ち上がり、ログインしたままで文書も残っている

うまく動かないときは、出力の `LogGroupName` のロググループでアプリのログを確認します。

## テンプレートの中身で知っておきたいこと

### 秘密情報は環境変数に平文で書かない

DB のユーザー名とパスワード、セッションの署名鍵、クライアントシークレットは Secrets Manager に置き、コンテナの起動時に ECS が取り出して渡します。DB への接続は `PGHOST`・`PGUSER`・`PGPASSWORD` などの標準の環境変数で渡すので、パスワードを接続文字列(URL)に埋め込むことはありません。

DB のパスワードは自動ローテーションしません。動いているコンテナは起動時に受け取った値を使い続けるため、途中でパスワードが変わると DB に接続できなくなるからです。

### S3 の権限に ListBucket が入っている理由

アプリが S3 に対して行うのは、ファイルの読み書きと削除だけです。それでも `s3:ListBucket` を付けているのは一覧を取るためではありません。アプリは「ファイルがあるか」を確かめるときに、存在しなければ 404 が返ることを前提にしています。この権限が無いと、S3 は 404 の代わりに 403 を返すため、ファイルが無いだけなのにエラー扱いになります。

### 外への通信は NAT ゲートウェイを通る

アプリはプライベートサブネットにあり、外へはNAT ゲートウェイを通って出ます。外へ出るのは、ログインのときの OpenID Connect のプロバイダとの通信と、起動時の Docker Hub からのイメージの取得です。文書ファイルの読み書きは S3 のゲートウェイ型 VPC エンドポイントを通るので、NAT を通らず、転送料もかかりません。

費用を抑えるため、NAT ゲートウェイは 1 つにしています。NAT ゲートウェイのある AZ に障害が起きると、その間はログインとコンテナの起動ができなくなります。

### スタックを消しても文書は残る

S3 バケットはスタックを削除しても残り、RDS は削除する前にスナップショットを取ります。誤ってスタックを消しても、文書は失われません。完全に片付けたいときは、バケットとスナップショットを別に削除してください。

## 運用

### 新しい版にする

`ImageTag` に新しいタグを入れて、スタックを更新します。ECS が新しいコンテナを立ち上げ、正常に動いたのを確かめてから古いコンテナを止めます。新しいコンテナが正常に動かなかったときは、自動で元の版に戻ります。

`latest` のまま使っている場合は、ECS のサービスで「新しいデプロイの強制」を実行すると、最新のイメージに入れ替わります。

### 台数を増やす

`DesiredCount` を 2 以上にしてスタックを更新します。ログイン状態は RDS に保存されているので、どのコンテナにつながってもログインしたままです。ALB のスティッキーセッションも要りません。

ひとつだけ制約があります。文書の索引付けの順番待ちはコンテナごとに管理しているため、同じ文書への操作が別々のコンテナに届くと、索引付けが二重に走ることがあります。結果が壊れることはありません。

## 費用の目安

**(実際の請求額を見て記入)**

最小構成では、NAT ゲートウェイ・ALB・RDS の時間課金が費用の大部分を占めます。S3 と Fargate は、使った分だけかかります。

## 次の記事

- 変換サービスを足す(Office 文書の体裁つき表示・PDF でダウンロード)。外に出られない場所で動かす必要があります
- 意味検索を足す(Weaviate Cloud、または Bedrock の埋め込みモデル)

<!--
## 公開前に確かめること(実際に構築して埋める。終わったらこの節ごと消す)

- [ ] テンプレートでスタックを作り、最初のログインまで通る。かかった時間を本文に書く
- [ ] EngineVersion "17"(メジャー版だけ)で RDS が作れる
- [ ] RDS で DATABASE_SSL=true のまま接続できる(rejectUnauthorized:false なので証明書の検証はしない)
- [ ] 起動時にスキーマが自動で作られる(pg_trgm の拡張を dm_admin で作れる)
- [ ] s3:ListBucket を外すと本当にエラーになるか(記事の説明が正しいか)
- [ ] タスクのサイズ(1 vCPU / 2 GB で足りるか)。Office 文書や大きな PDF を上げたときのメモリの山
- [ ] Dockerfile の VOLUME /data が Fargate で問題にならない(STORAGE_BACKEND=s3 なら書き込まないはず)
- [ ] 画面の自動更新(SSE)が ALB のアイドルタイムアウト(60 秒)で切れない。アプリは 30 秒ごとに heartbeat を送る
- [ ] 256MB のファイルのアップロードが ALB 経由で通る
- [ ] ImageTag を変えてスタックを更新すると、新しい版に入れ替わる
- [ ] DesiredCount=2 で、別のタスクにつながっている画面にも自動更新が届く
- [ ] スタックを削除すると、バケットとスナップショットが残る
- [ ] 1 か月動かした費用
-->
