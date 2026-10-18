<!--
www.earce.biz(WordPress / Twenty Seventeen)に載せる Document Manager の紹介の原稿。
機能を追加したら docs/dockerhub-overview.md と一緒にここも見直し、WordPress 側へ反映する。

いまのサイト(2026-10-17 時点):
- フロントページは固定ページ「痒いところに手を・・・」(page_id=2855)。本文は (A) の入口と、
  その下の「ツール」見出し + 「孫の手を取る」ボタン(`/?page_id=35` へ)だけ。
  末尾には、開いて1秒後に本文までスクロールするスクリプト(カスタムHTMLブロック)がある。
  これが無いとヘッダー画像だけが画面いっぱいに出るので、本文を差し替えるときに消さないこと。
- 以前のトップ(ツールのリンク一覧)は「孫の手で、とりあえずひと掻きを・・・」(page_id=35)に改題して残してある。
  ツールを足したらこちらの一覧を直す。既存の [Tool] ページの親もこのページのまま。
- 紹介ページ「Document Manager」(page_id=2854、スラッグ `document-manager`)。
  その子に構築ガイド(AWS 編、page_id=2867、下書き)。サイトでは投稿機能は使わず、すべて固定ページで作る。
- フッター(2026-10-18): フッター1 は「© 2019-2026 EARCE.NET」の段落ブロック(block-8)。年が変わったら直す。
  フッター2 は SSL サーバー証明書のサイトシール(block-7。消さない)。以前フッター1 にあった
  restricted_area へのリンク(block-3)は、使用停止中のウィジェットに移してある。
  トップメニューの場所には何も割り当てていない(「メインメニュー」は中身が空なので外した。メニュー自体は残っている)。
- プライバシーポリシー(page_id=2876、スラッグ `privacy-policy`、下書き)。ツールが入力をサーバーに送るかどうかを
  書いているので、サーバーで処理するツールを足したら「3」を直す。

置き方:
- (A) はフロントページの本文の**先頭**に置く入口。
  Twenty Seventeen の「フロントページセクション」(カスタマイザー → テーマオプション)は本文の**下**に
  出るため、上部に置きたいこの用途には使わない。
- (B) は紹介ページ本体。既存ページと同じく `/?pagename=document-manager` でリンクする。
- どちらもブロックエディタの「コードエディター」(右上の︙ → コードエディター)に貼る。
  色や文字の大きさは指定せず、テーマのダーク配色をそのまま使う。

画像は GitHub の raw URL を直接参照している(npm run screenshots で撮り直して push すれば、
サイト側も自動で新しくなる)。表示速度や外部依存が気になるなら、メディアライブラリへ
アップロードして URL を差し替える。本文の幅はおよそ 740px なので、画像は全幅表示で十分読める。
-->

# (A) トップページ上部の入口

```html
<!-- wp:group {"className":"dm-intro"} -->
<div class="wp-block-group dm-intro">
<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Document Manager(オープンソース)</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>社内の資料を1か所に集めて、探して、ダウンロードせずにそのままブラウザで読む。セルフホスト型の文書管理サービスです。Docker で起動するだけで動き、MIT ライセンスで自由に使えます。</p>
<!-- /wp:paragraph -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"custom"} -->
<figure class="wp-block-image size-large"><a href="/?pagename=document-manager"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/document-list.png" alt="Document Manager の文書一覧とプレビュー"/></a></figure>
<!-- /wp:image -->

<!-- wp:list -->
<ul class="wp-block-list">
<li>Markdown・PDF・draw.io・Excel/Word/PowerPoint など、よく使う形式をブラウザでそのまま閲覧</li>
<li>版の管理、タグとプロジェクトでの整理、全文検索と意味検索</li>
<li>Claude Code・Codex などの AI エージェントから「この資料アップして」で登録・検索</li>
<li>Miro のボードへ、資料を並べて書き出し(任意)</li>
</ul>
<!-- /wp:list -->

<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/?pagename=document-manager">詳しく見る</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="https://github.com/EARCE9000/document-manager">GitHub</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="https://hub.docker.com/r/earce9000/document-manager">Docker Hub</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

<!-- wp:separator -->
<hr class="wp-block-separator has-alpha-channel-opacity"/>
<!-- /wp:separator -->
</div>
<!-- /wp:group -->
```

# (B) 紹介ページ「Document Manager」

```html
<!-- wp:paragraph -->
<p>社内の資料を1か所に集めて、探して、ダウンロードせずにそのままブラウザで読むための文書管理サービスです。自分たちのサーバーやクラウドに置いて使うセルフホスト型で、ソースコードは MIT ライセンスで公開しています。</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://github.com/EARCE9000/document-manager">GitHub</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="https://hub.docker.com/r/earce9000/document-manager">Docker Hub</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/document-list.png" alt="文書一覧とプレビュー"/></figure>
<!-- /wp:image -->

<!-- wp:heading -->
<h2 class="wp-block-heading">開くだけで読める</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>HTML・Markdown・PDF・画像・CSV・draw.io・Mermaid・Excel/Word/PowerPoint など、1ファイルで完結する文書をアップロードすると、ダウンロードせずにブラウザ上で閲覧できます。draw.io と Mermaid は図として描画し、Office 文書はシートの表・見出しと段落・スライドごとの本文を表示します。中身の文字はすべて検索の対象になります。</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">版で管理して、タグとプロジェクトで整理する</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>修正した資料を「新しい版」として上げると、古い版は自動でアーカイブされ、タグとプロジェクトは新しい版へ引き継がれます。プロジェクトはフォルダ階層を持てて、1つの文書を複数のプロジェクトに置くこともできます。削除はなく、アーカイブした資料はいつでも元に戻せます。</p>
<!-- /wp:paragraph -->

<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/projects.png" alt="プロジェクト"/></figure>
<!-- /wp:image -->

<!-- wp:heading -->
<h2 class="wp-block-heading">「おしながき」で案件の資料を渡す</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>プロジェクトに揃っている資料と、それぞれが何なのかを1枚の一覧にします。説明はその場で書け、Markdown でコピーしてメールや議事録に貼れます。引き継ぎやレビュー依頼に向いています。</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">探せる</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>ファイル名・タグ・メモ・本文を対象に、日本語でも単語の区切りを気にせず探せます。スペースで区切ればすべてを含む資料に絞り込めます。ベクトルDB(Weaviate)を併せて起動すると、言い換えや表記ゆれを含めて近い資料を探す意味検索も使えます。</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">AI エージェントから使える</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>画面から API キーを発行でき、Claude Code・OpenAI Codex・Google Antigravity 用の Skill もダウンロードできます。「この資料アップして」「前の版を置き換えて」「〜を探して」と話しかけるだけで操作できます。AI が作った画面案(Web ページ一式)をそのまま登録して、動く状態で確認する「モックアップ管理」もあります。</p>
<!-- /wp:paragraph -->

<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/tools.png" alt="AI エージェント用 Skill の配布"/></figure>
<!-- /wp:image -->

<!-- wp:heading -->
<h2 class="wp-block-heading">Miro のボードに書き出す</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>打ち合わせで使う Miro のボードに、資料を並べて書き出せます(任意の機能)。書き出すのは頼まれたときだけで、ボードが知らないうちに変わることはありません。</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list">
<li>ボードに置いた目印の付箋(「[DM]名前」と向き)の横に、書き出すたびに新しいフレームを作って並べます。前に書き出したフレームには触りません</li>
<li>向きは右・左・上・下・斜めの 8 方向と十字。十字ではタグで 4 つに分けて、目印の斜め 4 か所に出します</li>
<li>PDF・画像はそのまま、HTML・Markdown・draw.io は PDF に、Office は体裁つきの PDF にして出し、各資料に「Document Manager で開く」リンクを付けます</li>
<li>AI エージェントに「この資料を Miro に書き出して」と頼むか、文書のプレビューのアイコンから 1 件ずつ書き出します。画面の上の「Miro」で目印を置き、書き出しの履歴を見られます</li>
</ul>
<!-- /wp:list -->

<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/screenshots/miro.png" alt="Miro の画面(ボードの目印と書き出しの履歴)"/></figure>
<!-- /wp:image -->

<!-- wp:heading -->
<h2 class="wp-block-heading">社内に置いても安心な作り</h2>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list">
<li><strong>外部へ出ない</strong>: draw.io・Mermaid の描画ライブラリは同梱しており、CDN を使いません。どの資料がいつ見られたかが第三者に伝わりません</li>
<li><strong>ログインは OpenID Connect</strong>: Entra ID・Cognito・Google などを設定で差し替えられます。使えるのは許可リストの人だけで、権限は管理者・読み書き・閲覧のみの3種類です</li>
<li><strong>危ないものは置かせない</strong>: 鍵や証明書(.env・.pem など)は、検索に載って全員に読まれないよう、あえて受け付けません</li>
<li><strong>変換は閉じ込めて行う</strong>: Office や HTML の変換サービスは、インターネットにも他のサービスにも出られない専用ネットワークで動かします</li>
<li><strong>操作は記録に残る</strong>: 誰が何をしたかは操作履歴で確認でき、不審なときは利用者のセッションをまとめて切断できます</li>
</ul>
<!-- /wp:list -->

<!-- wp:heading -->
<h2 class="wp-block-heading">構成</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>既定では1コンテナで完結します(メタデータは SQLite、ファイルはローカルディスク)。環境変数を変えるだけで、メタデータを PostgreSQL に、ファイルを S3・GCS に移せるので、AWS や Google Cloud で複数台構成にもできます。変換サービスや意味検索は任意で、無くても動きます。</p>
<!-- /wp:paragraph -->

<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="https://raw.githubusercontent.com/EARCE9000/document-manager/main/docs/architecture.png" alt="システム構成"/></figure>
<!-- /wp:image -->

<!-- wp:heading -->
<h2 class="wp-block-heading">はじめかた</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>OpenID Connect のクライアントを用意して、Docker イメージを起動します。手順と設定の一覧は GitHub の README と Docker Hub のページにまとめています。</p>
<!-- /wp:paragraph -->

<!-- wp:code -->
<pre class="wp-block-code"><code>docker pull earce9000/document-manager:latest</code></pre>
<!-- /wp:code -->

<!-- wp:buttons -->
<div class="wp-block-buttons">
<!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://github.com/EARCE9000/document-manager#dockerhubから利用する">導入手順(GitHub)</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="https://hub.docker.com/r/earce9000/document-manager">Docker Hub</a></div>
<!-- /wp:button -->
</div>
<!-- /wp:buttons -->

<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">ライセンス: MIT License © EARCE.NET。不具合や要望は GitHub の Issues へお寄せください。</p>
<!-- /wp:paragraph -->
```
