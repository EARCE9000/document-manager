# Document Manager Skill (Claude Code 用)

Claude Code から Document Manager へ、ファイルのアップロード・新しい版の登録・検索・版履歴の確認・ダウンロードを行うための Skill です。
「この資料アップして」「前の版を置き換えて」「Document Manager で〜を探して」と話しかけるだけで、Claude Code が同梱のクライアントを使って API を呼び出します。

```
document-manager/
├── SKILL.md              … Skill本体(Claude Codeが読む指示書。名前・発動条件・使い方)
├── README.md             … このファイル(人間向けの導入手順)
└── scripts/
    ├── dm_client.py      … Pythonクライアント(Python 3.8+、標準ライブラリのみ)
    └── dm_client.mjs     … Node.jsクライアント(Node.js 18+、外部依存なし)
```

## 1. 事前準備: APIキーの発行

1. Document Manager にブラウザでログインし、画面右上の「APIキー管理」を開きます。
2. ロールは `readwrite` を選びます。有効期限は、Claude Code から継続して使う場合は「無期限」がおすすめです。
3. 発行されたキー(`dm_...`)を控えておきます。キーは発行直後にしか表示されません。

無期限キーは、失効操作をするまで使い続けられます。漏れた場合は、同じ画面ですぐに失効させてください。

## 2. Skill として登録する

Claude Code の Skill は、`SKILL.md` を含むフォルダを所定の場所に置くだけで認識されます。

| 置き場所 | 有効範囲 |
|---|---|
| `~/.claude/skills/document-manager/` (Windows: `%USERPROFILE%\.claude\skills\document-manager\`) | 自分のすべてのプロジェクト |
| `<プロジェクト>/.claude/skills/document-manager/` | そのプロジェクトのみ(git にコミットすればチームで共有できる) |

### 方法A: ZIP を Claude Code のチャットに渡して登録してもらう(おすすめ)

1. `document-manager-skill.zip` を用意します。Document Manager の画面右上「APIキー管理」→「Claude Code 用 Skill」の「SkillのZIPをダウンロード」から取得できます(リポジトリから作る場合は「4. ZIP の作り方」を参照)。同じ場所の「登録依頼文をコピー」を使うと、接続先URL入りの依頼文をそのまま貼り付けられます。
2. Claude Code のチャットに ZIP を添付するかパスを貼り付け、次のように依頼します。

   ```
   このZIPをClaude CodeのSkillとして登録して(~/.claude/skills/ に展開)。
   Document ManagerのURLは https://docs.example.com/ 、APIキーは後で聞いて。
   ```

3. Claude Code が ZIP を `~/.claude/skills/` に展開します。ZIP の中身は `document-manager/` フォルダ 1 つです。
4. 続けて URL と API キーを渡すと、`~/.document-manager.json` に保存されます。

### 方法B: 手動でコピーする

ZIP を展開して、`document-manager` フォルダを上の表のどちらかの場所に置きます。

```bash
mkdir -p ~/.claude/skills
unzip document-manager-skill.zip -d ~/.claude/skills/
```

Windows(PowerShell)の場合:

```powershell
Expand-Archive document-manager-skill.zip -DestinationPath "$env:USERPROFILE\.claude\skills"
```

リポジトリをクローン済みなら、`tools/claude-skill/document-manager` をそのままコピーしても同じです。

### 登録の確認

Claude Code を再起動(または新しいセッションを開始)し、`/skills` で `document-manager` が一覧に出れば完了です。
「Document Managerで〇〇を探して」と話しかけると、この Skill が使われます。

## 3. 接続情報の設定

接続情報は次のどちらかで与えます。Skill を初めて使うときに未設定であれば、Claude Code から入力を求められます。

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
python scripts/dm_client.py upload ./report.md --tags 経理,2026年度   # 新規アップロード
python scripts/dm_client.py upload ./report.md --previous-id <旧版ID> # 新しい版として登録(旧版はアーカイブ)
python scripts/dm_client.py upload ./report.md --replace-same-name   # 同名文書があればその新しい版に
python scripts/dm_client.py upload ./構成図.drawio --preview ./構成図.svg
python scripts/dm_client.py versions <文書ID>                        # 版履歴
python scripts/dm_client.py download <文書ID> -o ./downloads/

node scripts/dm_client.mjs search 設計書                             # Node.js版も同じ
```

新しい版として登録すると、旧版は自動でアーカイブされます。タグと、プロジェクトへの登録(フォルダ・並び順)は新しい版へ引き継がれます。

## 4. ZIP の作り方

リポジトリ直下で次を実行すると、`tools/claude-skill/dist/document-manager-skill.zip` ができます。

```bash
python tools/claude-skill/build_skill_zip.py
```

ZIP の中身は `document-manager/` フォルダ 1 つです。claude.ai の Skill アップロード(設定 → 機能 → Skills)にもそのまま使える形式です。
ただし claude.ai 上ではネットワーク制限により社内の Document Manager に届かないことがあるため、主な用途は Claude Code です。

## カスタマイズ

- 発動のしかたを変えたい場合は、`SKILL.md` 冒頭の `description` を編集します。Claude はこの文を見て、いつ Skill を使うかを判断します。
- 手順(新規か新しい版かの判断、報告内容など)を変えたい場合は、`SKILL.md` の本文を編集します。
