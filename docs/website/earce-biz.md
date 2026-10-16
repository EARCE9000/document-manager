<!--
www.earce.biz(WordPress / Twenty Seventeen)に載せる Document Manager の紹介の原稿。
機能を追加したら docs/dockerhub-overview.md と一緒にここも見直し、WordPress 側へ反映する。

置き方:
- (A) はフロントページ「痒いところに手を・・・」の本文の**先頭**に足す入口。ツール一覧より上に出る。
  Twenty Seventeen の「フロントページセクション」(カスタマイザー → テーマオプション)は本文の**下**に
  出るため、上部に置きたいこの用途には使わない。
- (B) は紹介ページ本体。固定ページ「Document Manager」として作り、親ページはフロントページにする
  (既存の [Tool] ページと同じ並び)。スラッグは `document-manager`(既存ページと同じく `/?pagename=スラッグ` でリンクする)。
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
