# Document Manager Skill (Claude Code / Codex / Antigravity 用)

AIエージェントから Document Manager へ、ファイルのアップロード・新しい版の登録・検索・版履歴の確認・ダウンロードを行うための Skill です。
「この資料アップして」「前の版を置き換えて」「Document Manager で〜を探して」と話しかけるだけで、エージェントが同梱のクライアントを使って API を呼び出します。

Skill の形式(`SKILL.md` + `scripts/`)は Claude Code・OpenAI Codex・Google Antigravity で共通のため、**同じZIP(同じフォルダ)をそのまま使えます**。違うのは置き場所だけです。

```
document-manager/
├── SKILL.md              … Skill本体(エージェントが読む指示書。名前・発動条件・使い方)
├── README.md             … このファイル(人間向けの導入手順)
└── scripts/
    ├── dm_client.py      … Pythonクライアント(Python 3.8+、標準ライブラリのみ)
    └── dm_client.mjs     … Node.jsクライアント(Node.js 18+、外部依存なし)
```

## 1. 事前準備: APIキーの発行

1. Document Manager にブラウザでログインし、画面右上の「APIキー管理」を開きます。
2. ロールは `readwrite` を選びます。有効期限は最長1年です。AIエージェントから継続して使う場合は「1年」を選び、切れたら発行し直してください。
3. 発行されたキー(`dm_...`)を控えておきます。キーは発行直後にしか表示されません。

キーが漏れた場合は、同じ画面ですぐに失効させてください。

## 2. Skill として登録する

どのエージェントも、`SKILL.md` を含むフォルダを所定の場所に置くだけで認識します。ZIP の中身は `document-manager/` フォルダ 1 つなので、下表の「展開先」に展開すれば `…/document-manager/SKILL.md` の形になります。

| エージェント | 展開先(自分の全プロジェクトで有効) | プロジェクト単位の展開先 | 確認方法 |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `<プロジェクト>/.claude/skills/` | `/skills` |
| Codex (CLI / IDE拡張 / アプリ) | `~/.agents/skills/` | `<プロジェクト>/.agents/skills/` | `/skills` または `$` で候補表示 |
| Antigravity (IDE / 2.0) | `~/.gemini/config/skills/` | `<プロジェクト>/.agents/skills/` | `/document-manager` で明示呼び出し |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/` | `<プロジェクト>/.agents/skills/` | 同上 |

- Windows では `~` を `%USERPROFILE%` (PowerShell では `$env:USERPROFILE`) に読み替えます。
- Codex と Antigravity はプロジェクト単位の置き場所(`.agents/skills/`)が共通です。リポジトリにコミットすれば、両方の利用者で共有できます。
- 古いバージョンの Codex は `~/.codex/skills/`、古い Antigravity は `~/.gemini/antigravity/skills/` を見ます。上表の場所で認識されない場合はこちらに置いてください。

### 方法A: ZIP をエージェントのチャットに渡して登録してもらう(おすすめ)

1. `document-manager-skill.zip` を用意します。Document Manager の画面右上「APIキー管理」→「AIエージェント用 Skill」の「SkillのZIPをダウンロード」から取得できます(リポジトリから作る場合は「4. ZIP の作り方」を参照)。
2. 同じ画面で使うエージェント(Claude Code / Codex / Antigravity)を選び、「登録依頼文をコピー」を押します。接続先URLと、そのエージェント用の展開先が入った依頼文がコピーされます。
3. エージェントのチャットに ZIP を添付するかパスを貼り付け、コピーした依頼文を貼り付けて送ります。手で書く場合は次のように依頼します(展開先は上表を参照)。

   ```
   このZIPをSkillとして登録して(~/.agents/skills/ に展開)。
   Document ManagerのURLは https://docs.example.com/ 、APIキーは後で聞いて。
   ```

4. エージェントが ZIP を展開します。続けて API キーを渡すと、`~/.document-manager.json` に保存されます。

### 方法B: 手動でコピーする

ZIP を上の表の展開先に展開します。例は Codex の場合です。Claude Code なら `.claude/skills`、Antigravity なら `.gemini/config/skills` に読み替えてください。

```bash
mkdir -p ~/.agents/skills
unzip document-manager-skill.zip -d ~/.agents/skills/
```

Windows(PowerShell)の場合:

```powershell
Expand-Archive document-manager-skill.zip -DestinationPath "$env:USERPROFILE\.agents\skills"
```

リポジトリをクローン済みなら、`tools/claude-skill/document-manager` をそのままコピーしても同じです。

### 登録の確認

新しいセッションを開始し、上表の「確認方法」で `document-manager` が出れば完了です。表示されない場合はエージェントを再起動してください。
「Document Managerで〇〇を探して」と話しかけると、この Skill が使われます。

### Codex を使う場合の注意

Codex の既定のサンドボックスでは、コマンドからのネットワークアクセスが制限されていることがあります。
その場合、アップロードや検索の実行時にネットワークアクセスの承認を求められるので、許可してください。
毎回の承認を省きたい場合は、Codex の設定でサンドボックスのネットワークアクセスを有効にします。

## 3. 接続情報の設定

接続情報は次のどちらかで与えます。Skill を初めて使うときに未設定であれば、エージェントから入力を求められます。
設定はエージェント共通です。一度保存すれば、Claude Code・Codex・Antigravity のどれからでも使えます。

設定ファイル `~/.document-manager.json`(Windows: `%USERPROFILE%\.document-manager.json`)を作る場合:

```json
{"baseUrl": "https://docs.example.com/", "apiKey": "dm_xxxxxxxx"}
```

環境変数で与える場合(設定ファイルより優先されます):

```bash
export DM_BASE_URL="https://docs.example.com/"
export DM_API_KEY="dm_xxxxxxxx"
```

- `baseUrl` は Document Manager のトップ画面の URL です。リバースプロキシのサブパス配下で動かしている場合は、そのパスまで含めます。
- 設定ファイルの場所を変えたい場合は、環境変数 `DM_CONFIG` にパスを指定します。
- API キーは平文で保存されます。共有PCでは環境変数を使うか、ファイルの権限を絞ってください。

## クライアント単体での使い方

Skill を使わず、スクリプトやターミナルから直接呼ぶこともできます。Python 版と Node.js 版は、コマンドも出力(JSON)も同じです。

```bash
python scripts/dm_client.py config                                   # 接続先の確認
python scripts/dm_client.py search 設計書                            # 検索
python scripts/dm_client.py search 設計書 --archived                 # アーカイブ済み(復元可能)から検索
python scripts/dm_client.py upload ./report.md --tags 経理,2026年度   # 新規アップロード
python scripts/dm_client.py upload ./report.md --previous-id <旧版ID> # 新しい版として登録(旧版はアーカイブ)
python scripts/dm_client.py upload ./report.md --replace-same-name   # 同名文書があればその新しい版に
python scripts/dm_client.py upload ./構成図.drawio --preview ./構成図.svg
python scripts/dm_client.py versions <文書ID>                        # 版履歴
python scripts/dm_client.py download <文書ID> -o ./downloads/
python scripts/dm_client.py watch                                    # 操作の通知を待ち受け(Ctrl+Cで終了)
python scripts/dm_client.py watch --count 1 --timeout 300 --action upload,revise  # 次のアップロードを1件待つ

node scripts/dm_client.mjs search 設計書                             # Node.js版も同じ
```

新しい版として登録すると、旧版は自動でアーカイブされます。タグと、プロジェクトへの登録(フォルダ・並び順)は新しい版へ引き継がれます。

`watch` は、画面右下のポップアップ通知と同じ内容(誰が・どの文書に・何をしたか)を、1件ずつ1行の JSON で出力します。
接続が切れても自動で再接続しますが、切れている間の通知は再送されません。スクリプトから使う場合は、例えば次のように次の処理へ渡せます。

```bash
python scripts/dm_client.py watch --action upload,revise | while read -r line; do
  echo "$line"   # ここで通知(Slack送信など)や後続処理を行う
done
```

## 4. ZIP の作り方

リポジトリ直下で次を実行すると、`tools/claude-skill/dist/document-manager-skill.zip` ができます。

```bash
python tools/claude-skill/build_skill_zip.py
```

### CI/CD(GitHub Actions)

`.github/workflows/skill-package.yml` で、Skill の検証と ZIP 作成を自動で行います。

| きっかけ | 実行内容 |
|---|---|
| `main` への push / Pull Request(Skill・関連ファイルの変更時) | クライアントの構文チェック → テストサーバーに対する結合テスト(Python版・Node.js版の両方) → ZIP 作成・検証 → Actions のアーティファクト `document-manager-skill` として保存 |
| タグ `skill-v*` の push | 上記に加えて、GitHub Release を作成して ZIP を添付・公開 |
| 手動実行(Actions 画面の「Run workflow」) | push 時と同じ |

リリースの例:

```bash
git tag skill-v1.0.0
git push origin skill-v1.0.0
```

結合テストは `tools/claude-skill/ci_smoke_test.py` です。ローカルでも同じように実行できます(`app/` で `npm install` 済みであること)。

```bash
python tools/claude-skill/ci_smoke_test.py
```

このテストでは次の点も確認します。

- `SKILL.md` の `name` / `description` が Agent Skills の制約(小文字・ハイフン、1024 文字以内)を満たしている
- ZIP の中身が `document-manager/` フォルダ 1 つで、リポジトリのファイルと同一である
- `scripts/` 配下に実行ビットが付いている
- CI で作った ZIP と、サーバーが画面から配信する ZIP(`api/claude-skill.zip`)の中身が一致している

ZIP の中身は `document-manager/` フォルダ 1 つです。claude.ai の Skill アップロード(設定 → 機能 → Skills)にもそのまま使える形式です。
ただし claude.ai 上ではネットワーク制限により社内の Document Manager に届かないことがあるため、主な用途はローカルで動くエージェント(Claude Code / Codex / Antigravity)です。

## カスタマイズ

- 発動のしかたを変えたい場合は、`SKILL.md` 冒頭の `description` を編集します。どのエージェントも、この文を見ていつ Skill を使うかを判断します。
- 手順(新規か新しい版かの判断、報告内容など)を変えたい場合は、`SKILL.md` の本文を編集します。
