#!/usr/bin/env python3
"""
ci_smoke_test.py : Skill 同梱クライアント(dm_client.py / dm_client.mjs)と配布ZIPの結合テスト

CI(.github/workflows/skill-package.yml)とローカルの両方で使う。
テストサーバ(test/api/serve.js)を起動して、Python版・Node.js版のクライアントを実際に動かし、
続けて build_skill_zip.py で作ったZIPとサーバーが配信するZIP(api/claude-skill.zip)の中身を検証する。

実行(リポジトリ直下。app/ の依存は npm install 済みであること):
  python tools/claude-skill/ci_smoke_test.py
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SKILL_DIR = os.path.join(HERE, "document-manager")
BACKLOG_DIR = os.path.join(HERE, "backlog")
BACKLOG_CLIENT = os.path.join(BACKLOG_DIR, "scripts", "backlog_client.py")
PY_CLIENT = os.path.join(SKILL_DIR, "scripts", "dm_client.py")
NODE_CLIENT = os.path.join(SKILL_DIR, "scripts", "dm_client.mjs")
KEYS_FILE = os.path.join(REPO, "test", "api", ".auth-keys.json")
PORT = int(os.environ.get("SKILL_TEST_PORT", "18095"))
BASE_URL = f"http://127.0.0.1:{PORT}/"

failures = []


def check(cond, message):
    print(("  ok   " if cond else "  FAIL ") + message)
    if not cond:
        failures.append(message)


def run_client(kind, args, env, expect_ok=True):
    cmd = [sys.executable, PY_CLIENT] if kind == "python" else ["node", NODE_CLIENT]
    proc = subprocess.run(cmd + args, env=env, capture_output=True, text=True, encoding="utf-8")
    if expect_ok and proc.returncode != 0:
        raise AssertionError(f"{kind} {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip()}")
    return proc


def check_skill_md(skill_dir=SKILL_DIR):
    """
    Skillとして読み込まれる形になっているか。AIエージェントは説明書の冒頭(フロントマター)の
    name と description を見て、どのSkillを使うかを決める。ここが崩れると、Skillとして認識されないか、
    使ってほしい場面で選ばれない。配っているSkillはすべて同じ決まりで確かめる
    """
    skill = os.path.basename(skill_dir)
    print(f"[SKILL.md: {skill}]")
    text = open(os.path.join(skill_dir, "SKILL.md"), encoding="utf-8").read()
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    check(m is not None, "YAMLフロントマターがある")
    fields = dict(re.findall(r"^(\w+):\s*(.+)$", m.group(1), re.M)) if m else {}
    check(fields.get("name") == skill, f"name がフォルダ名({skill})と一致する")
    check(re.fullmatch(r"[a-z0-9-]{1,64}", fields.get("name", "")) is not None, "name は小文字・数字・ハイフンのみ(64文字以内)")
    description = fields.get("description", "")
    check(0 < len(description) <= 1024, f"description が1〜1024文字 ({len(description)}文字)")


def check_zip(data, label, skill="document-manager", required=("SKILL.md", "README.md", "scripts/dm_client.py", "scripts/dm_client.mjs")):
    print(f"[ZIP: {label}]")
    skill_dir = os.path.join(HERE, skill)
    zf = zipfile.ZipFile(io.BytesIO(data))
    check(zf.testzip() is None, "CRCエラーが無い")
    names = zf.namelist()
    check(all(n.startswith(f"{skill}/") for n in names), f"中身が {skill}/ フォルダ1つにまとまっている")
    for name in required:
        check(f"{skill}/{name}" in names, f"{name} を含む")
    check(not any("__pycache__" in n for n in names), "Pythonの一時ファイル(__pycache__)を含まない")
    for info in zf.infolist():
        mode = (info.external_attr >> 16) & 0o777
        expected = 0o755 if info.filename.startswith(f"{skill}/scripts/") else 0o644
        check(mode == expected, f"{info.filename} のパーミッションが {oct(expected)} ({oct(mode)})")
    # 配布物がリポジトリの内容と一致すること(古いファイルや余計なファイルが混ざっていない)
    for name in names:
        src = os.path.join(skill_dir, *name.split("/")[1:])
        check(os.path.isfile(src) and open(src, "rb").read() == zf.read(name), f"{name} がリポジトリと同一")
    return {n: zf.read(n) for n in names}


def check_referenced_scripts(skill_dir):
    """
    説明書(SKILL.md)が案内しているクライアントが、実際に入っていること。
    Backlog の説明書が、入っていない Node.js 版を案内していたことがある(AIが探して失敗する)
    """
    text = open(os.path.join(skill_dir, "SKILL.md"), encoding="utf-8").read()
    for script in sorted(set(re.findall(r"scripts/([A-Za-z0-9_]+\.(?:py|mjs))", text))):
        check(os.path.isfile(os.path.join(skill_dir, "scripts", script)), f"SKILL.md が案内する scripts/{script} が入っている")


# ---- 接続情報の登録(setup) ----
# APIキーをチャットに貼らずに済ませるためのもの。エディタの代わりに、キーを書き込んで保存する
# 小さなスクリプトを使う(利用者がメモ帳で貼り付けて保存するのと同じことが起きる)
FAKE_EDITOR = """
import json, os, sys
path = sys.argv[-1]
data = json.load(open(path, encoding="utf-8-sig"))
assert "apiKey" in data, "ひな形に apiKey の欄が無い"
if os.environ.get("FAKE_PASTED_KEY"):
    data["apiKey"] = os.environ["FAKE_PASTED_KEY"]
json.dump(data, open(path, "w", encoding="utf-8"))
"""


def smoke_setup(name, command, env_prefix, workdir, real_key, extra):
    """
    name: 表示名 / command: クライアントの起動コマンド / env_prefix: DM か BACKLOG
    real_key: 利用者が貼り付けるキー / extra: setup --edit に付ける引数(接続先)
    """
    print(f"[setup: {name}]")
    config_path = os.path.join(workdir, f"setup-{name}.json")
    editor_script = os.path.join(workdir, "fake_editor.py")
    open(editor_script, "w", encoding="utf-8").write(FAKE_EDITOR)
    # 環境変数の接続情報は外し、設定ファイルだけで動かす
    base = {k: v for k, v in os.environ.items() if not k.startswith(env_prefix + "_")}
    base[f"{env_prefix}_CONFIG"] = config_path
    run = lambda args, env, **kw: subprocess.run(command + args, env=env, capture_output=True, text=True, encoding="utf-8", **kw)

    not_yet = run(["config"], base)
    check(not_yet.returncode == 1 and "setup" in not_yet.stderr, "未設定なら、setup で設定するよう案内する")

    # エディタは「キーを貼り付けて保存する」利用者の代わり。開いたファイルにひな形があること自体も確かめる
    # (パスに空白が無い前提で、空白区切りで渡す。テスト用の一時ディレクトリなので問題ない)
    editor = f"{sys.executable} {editor_script}"
    with_editor = {**base, f"{env_prefix}_EDITOR": editor, "FAKE_PASTED_KEY": real_key}
    opened = run(["setup", "--edit"] + extra, with_editor)
    result = json.loads(opened.stdout or "{}")
    check(opened.returncode == 0 and result.get("created") is True and result.get("opened") is True, f"setup --edit: ひな形を作ってエディタで開く ({opened.stderr.strip()[:120]})")
    check(real_key not in opened.stdout + opened.stderr, "setup --edit: キーを画面(AIが読む出力)に出さない")
    saved = json.load(open(config_path, encoding="utf-8-sig"))
    check(saved.get("apiKey") == real_key, "setup --edit: 利用者が書き込んだキーで保存されている")
    if os.name != "nt":
        check(os.stat(config_path).st_mode & 0o077 == 0, "設定ファイルは本人以外が読めない(600)")

    shown = run(["config"], base)
    check(shown.returncode == 0 and real_key not in shown.stdout, "config: 保存した設定で動き、キーは伏せて表示する")

    # 既にある設定を開き直しても、書き込んだキーを消さない
    reopened = run(["setup", "--edit"], {**base, f"{env_prefix}_EDITOR": f"{editor}"})
    check(json.loads(reopened.stdout or "{}").get("created") is False, "setup --edit: 既存の設定を開き直せる")
    check(json.load(open(config_path, encoding="utf-8-sig")).get("apiKey") == real_key, "setup --edit: 開き直してもキーを消さない")

    # AIエージェントが setup を実行しても、入力待ちで止まらずに断る(利用者に実行してもらうよう伝える)
    started = time.monotonic()
    refused = run(["setup"] + extra[:0], base, stdin=subprocess.DEVNULL, timeout=30)
    check(refused.returncode == 1 and "コードブロック" in refused.stderr and time.monotonic() - started < 20,
          "setup: AIエージェントから実行すると、止まらずに断り、利用者に実行してもらうよう伝える")
    piped = run(["setup"], base, input="dm_should_not_be_read\n", timeout=30)
    check(piped.returncode == 1 and json.load(open(config_path, encoding="utf-8-sig")).get("apiKey") == real_key,
          "setup: パイプで渡されたキーは読まない(チャット経由のキーを受け付けない)")

    # エディタが開けなかったときは、そうと伝えて場所を示す
    os.remove(config_path)
    failed = run(["setup", "--edit"], {**base, f"{env_prefix}_EDITOR": f"{editor}-no-such-editor"})
    failed_result = json.loads(failed.stdout or "{}")
    check(failed_result.get("opened") is False and config_path.replace("/", os.sep) in failed_result.get("next", "").replace("/", os.sep),
          "setup --edit: エディタを開けなければ、そうと伝えてファイルの場所を示す")
    broken = open(config_path, "w", encoding="utf-8").write('{"apiKey": "x", ')
    bad = run(["config"], base)
    check(bad.returncode == 1 and "JSON" in bad.stderr, "壊れた設定ファイルは、直し方を案内する(落ちない)")


def smoke_clients(env, workdir):
    client_versions = set()
    for kind in ("python", "node"):
        print(f"[client: {kind}]")
        name = f"smoke-{kind}.md"
        path = os.path.join(workdir, name)
        open(path, "w", encoding="utf-8").write(f"# {kind} v1 スモーク\n")

        config = json.loads(run_client(kind, ["config"], env).stdout)
        check(config["baseUrl"] == BASE_URL, "config: 接続先を環境変数から読める")

        # バージョンはPython版・Node.js版で必ず揃える(片方だけ更新される事故を防ぐ)
        printed = run_client(kind, ["--version"], env).stdout.strip()
        check(printed.endswith(config["clientVersion"]), f"--version と config のバージョンが一致する ({printed})")
        client_versions.add(config["clientVersion"])

        v1 = json.loads(run_client(kind, ["upload", path, "--tags", "smoke"], env).stdout)
        check(v1["entryFile"] == name and v1["tags"] == ["smoke"], "upload: 新規アップロード+タグ")

        open(path, "w", encoding="utf-8").write(f"# {kind} v2 スモーク\n")
        v2 = json.loads(run_client(kind, ["upload", path, "--replace-same-name", "--tags", "v2"], env).stdout)
        check(v2["previousId"] == v1["id"], "upload --replace-same-name: 同名文書の新しい版になる")
        check(set(v2["tags"]) == {"smoke", "v2"}, "upload: 旧版のタグを引き継ぎつつ追加できる")

        versions = json.loads(run_client(kind, ["versions", v2["id"]], env).stdout)
        check([v["id"] for v in versions] == [v1["id"], v2["id"]], "versions: 古い順に版が並ぶ")
        check([v["archived"] for v in versions] == [True, False], "versions: 旧版はアーカイブ済み")

        found = json.loads(run_client(kind, ["search", f"smoke-{kind}"], env).stdout)
        check([d["id"] for d in found] == [v2["id"]], "search: 最新版だけがヒットする")

        archived = json.loads(run_client(kind, ["search", f"smoke-{kind}", "--archived"], env).stdout)
        check([d["id"] for d in archived] == [v1["id"]], "search --archived: アーカイブ済みの旧版がヒットする")

        outdir = os.path.join(workdir, f"dl-{kind}")
        os.makedirs(outdir)
        run_client(kind, ["download", v2["id"], "-o", outdir], env)
        check(open(os.path.join(outdir, name), encoding="utf-8").read() == f"# {kind} v2 スモーク\n", "download: 最新版の中身を保存できる")

        conflict = run_client(kind, ["upload", path, "--previous-id", v1["id"]], env, expect_ok=False)
        check(conflict.returncode == 1 and '"status"' in conflict.stderr and "409" in conflict.stderr, "upload: 最新でない旧版の指定はエラー(409)")

        bad = run_client(kind, ["search"], {**env, "DM_API_KEY": "dm_invalid"}, expect_ok=False)
        check(bad.returncode == 1 and "401" in bad.stderr, "不正なキーはエラー(401)")
        # 期限切れ・無効なキーでは、利用者が実行して登録し直すコマンドを添える(AIはそれを示すだけでよい)
        detail = json.loads(bad.stderr.strip().splitlines()[-1])
        check(detail.get("status") == 401 and "setup --base-url" in detail.get("setupCommand", "")
              and BASE_URL in detail.get("setupCommand", "") and "チャットで受け取らない" in detail.get("hint", ""),
              "401: 登録し直すためのコマンド(setupCommand)と、進め方(hint)を返す")

        smoke_edit_commands(kind, env, v2["id"], v1["id"])
        smoke_project_commands(kind, env, workdir, v2["id"])
        smoke_manifest_commands(kind, env, v2["id"])
        smoke_mockup_commands(kind, env, workdir)
        smoke_update_notice(kind, env)
        smoke_render(kind, env, workdir)
        smoke_pdf(kind, env, workdir)
        smoke_spec(kind, env)
        smoke_watch(kind, env, workdir)

    check(len(client_versions) == 1, f"Python版とNode.js版のバージョンが一致する ({sorted(client_versions)})")
    # SKILL.md にも同じバージョンを書いておく(エージェントが「どの版か」を答えられるように)
    skill_md = open(os.path.join(SKILL_DIR, "SKILL.md"), encoding="utf-8").read()
    check(f"バージョン: {next(iter(client_versions))}" in skill_md, "SKILL.md のバージョン表記がクライアントと一致する")


def smoke_edit_commands(kind, env, doc_id, archived_id):
    """タグ・メモ・関連文書・アーカイブ/復元。いずれも文書の状態を読み直して結果を確かめる"""
    tags = json.loads(run_client(kind, ["tags", doc_id, "--add", "追加タグ"], env).stdout)["tags"]
    check(set(tags) == {"smoke", "v2", "追加タグ"}, "tags --add: 既存のタグを残して追加する")
    tags = json.loads(run_client(kind, ["tags", doc_id, "--remove", "追加タグ,v2"], env).stdout)["tags"]
    check(tags == ["smoke"], "tags --remove: 指定したタグだけ外す")
    tags = json.loads(run_client(kind, ["tags", doc_id], env).stdout)["tags"]
    check(tags == ["smoke"], "tags: 変更オプション無しなら現在のタグを返す")

    run_client(kind, ["memo", doc_id, "スモークテストのメモ"], env)
    check(json.loads(run_client(kind, ["get", doc_id], env).stdout).get("memo") == "スモークテストのメモ", "memo: メモを更新できる")

    run_client(kind, ["link", doc_id, archived_id], env)
    links = json.loads(run_client(kind, ["links", doc_id], env).stdout)
    check([link["id"] for link in links] == [archived_id], "link/links: 関連文書として紐づけて一覧できる")
    run_client(kind, ["unlink", doc_id, archived_id], env)
    check(json.loads(run_client(kind, ["links", doc_id], env).stdout) == [], "unlink: 関連文書の紐付けを解除できる")

    run_client(kind, ["archive", doc_id], env)
    check(json.loads(run_client(kind, ["get", doc_id], env).stdout)["archived"] is True, "archive: アーカイブできる(文書は残る)")
    run_client(kind, ["restore", doc_id], env)
    check(json.loads(run_client(kind, ["get", doc_id], env).stdout)["archived"] is False, "restore: アーカイブから戻せる")


def smoke_project_commands(kind, env, workdir, doc_id):
    """プロジェクト・フォルダはIDでも名前でも指定できる(AIが一覧の名前をそのまま渡せる)"""
    project_name = f"smoke-project-{kind}"
    project = json.loads(run_client(kind, ["project-create", project_name], env).stdout)
    folder = json.loads(run_client(kind, ["folder-create", project_name, "設計"], env).stdout)
    check(folder.get("name") == "設計", "folder-create: プロジェクト名を指定してフォルダを作れる")

    placed = json.loads(run_client(kind, ["place", project_name, doc_id, "--folder", "設計"], env).stdout)
    check(placed["projectId"] == project["id"] and placed["folderId"] == folder["id"], "place: 名前で指定したプロジェクト・フォルダへ登録できる")
    tree = json.loads(run_client(kind, ["tree", project_name], env).stdout)
    check([(d["documentId"], d["folderId"]) for d in tree["documents"]] == [(doc_id, folder["id"])], "tree: 配置がツリーに反映される")

    run_client(kind, ["unplace", project_name, doc_id], env)
    check(json.loads(run_client(kind, ["tree", project_name], env).stdout)["documents"] == [], "unplace: プロジェクトから外せる")
    check(json.loads(run_client(kind, ["get", doc_id], env).stdout)["id"] == doc_id, "unplace: 文書自体は残る")

    missing = run_client(kind, ["place", "存在しないプロジェクト", doc_id], env, expect_ok=False)
    check(missing.returncode == 1 and "プロジェクトが見つかりません" in missing.stderr, "place: 存在しないプロジェクト名はエラー")

    # アップロードと同時に配置する(新規登録の定番の流れ)
    name = f"in-project-{kind}.md"
    path = os.path.join(workdir, name)
    open(path, "w", encoding="utf-8").write("# プロジェクト直下\n")
    uploaded = json.loads(run_client(kind, ["upload", path, "--project", project_name], env).stdout)
    check(uploaded["project"]["projectId"] == project["id"] and uploaded["project"]["folderId"] is None,
          "upload --project: アップロードと同時にプロジェクト直下へ登録できる")


def smoke_manifest_commands(kind, env, doc_id):
    """おしながき: 資料一覧に説明書きを付けて、人に渡せる形で出せること"""
    project_name = f"smoke-manifest-{kind}"
    run_client(kind, ["project-create", project_name], env)
    run_client(kind, ["place", project_name, doc_id], env)

    written = json.loads(run_client(kind, ["note", project_name, "この案件では前提資料です。", "--id", doc_id], env).stdout)
    check(written["note"] == "この案件では前提資料です。", "note: 資料に説明書きを書ける")

    manifest = json.loads(run_client(kind, ["manifest", project_name], env).stdout)
    check(manifest["documentCount"] == 1, "manifest: 資料の件数が返る")
    check(manifest["rootDocuments"][0]["note"] == "この案件では前提資料です。", "manifest: 説明書きが載る")

    # --markdown はJSONで包まず、そのまま人に渡せる形で出す
    markdown = run_client(kind, ["manifest", project_name, "--markdown"], env).stdout
    check(markdown.startswith(f"# {project_name} おしながき"), "manifest --markdown: 見出しから始まるMarkdownをそのまま出す")
    check("この案件では前提資料です。" in markdown, "manifest --markdown: 説明書きが含まれる")

    # 人に渡す文面なので、各資料を「そこから開けるリンク」にして出す(名前だけだと、受け取った人が探し直すことになる)
    alias = json.loads(run_client(kind, ["alias", doc_id], env).stdout)["alias"]
    check(f"]({BASE_URL}api/documents/alias/{alias}/viewer)" in markdown, "manifest --markdown: 各資料に共有リンクが付く")
    plain = run_client(kind, ["manifest", project_name, "--markdown", "--no-links"], env).stdout
    check("](" not in plain and "http" not in plain and "この案件では前提資料です。" in plain, "manifest --markdown --no-links: リンクなしにできる")

    # プロジェクトそのものを渡すURL。おしながきの見出しの下に入るものと同じであること
    project_id = next(p["id"] for p in json.loads(run_client(kind, ["projects"], env).stdout) if p["name"] == project_name)
    linked = json.loads(run_client(kind, ["project-url", project_name], env).stdout)
    check(linked["projectUrl"] == f"{BASE_URL}?project={project_id}" and linked["projectId"] == project_id,
          f"project-url: プロジェクトを開くURLを返す ({linked['projectUrl']})")
    check(f"プロジェクトを開く: <{linked['projectUrl']}>" in markdown, "project-url: おしながきに入るURLと同じ")
    by_id = json.loads(run_client(kind, ["project-url", project_id], env).stdout)
    check(by_id["projectUrl"] == linked["projectUrl"], "project-url: IDでも名前でも指定できる")
    missing = run_client(kind, ["project-url", "そんなプロジェクトは無い"], env, expect_ok=False)
    check(missing.returncode == 1, "project-url: 無いプロジェクトはエラーにする(URLを作らない)")

    # 章だけを切り出せること(案件全体ではなく「この章だけ渡したい」ことがある)
    folder = json.loads(run_client(kind, ["folder-create", project_name, "要件"], env).stdout)
    run_client(kind, ["place", project_name, doc_id, "--folder", "要件"], env)
    scoped = json.loads(run_client(kind, ["manifest", project_name, "--folder", "要件"], env).stdout)
    check(scoped["folderName"] == "要件", "manifest --folder: その章だけを切り出せる")
    scoped_md = run_client(kind, ["manifest", project_name, "--markdown", "--folder", "要件"], env).stdout
    check("› 要件 おしながき" in scoped_md, "manifest --folder --markdown: どの章かが見出しに出る")

    # フォルダの並び替え(おしながきの章の順番になる)
    run_client(kind, ["folder-create", project_name, "参考"], env)
    reordered = json.loads(run_client(kind, ["folder-reorder", project_name, "参考,要件"], env).stdout)
    order = [f["name"] for f in sorted(reordered["folders"], key=lambda f: f["sortOrder"]) if f["parentFolderId"] is None]
    check(order[:2] == ["参考", "要件"], f"folder-reorder: 章の順番を変えられる(実際: {order[:2]})")

    # 説明書きは文書ではなくプロジェクトへの紐づけに付く(文書側のメモを侵さない)
    memo = json.loads(run_client(kind, ["get", doc_id], env).stdout).get("memo")
    check(memo != "この案件では前提資料です。", "note: 文書そのもののメモは書き換えない")


def smoke_mockup_commands(kind, env, workdir):
    """モックアップ: ディレクトリをそのまま渡して登録でき、開くURLが返ること"""
    site = os.path.join(workdir, f"mockup-{kind}")
    os.makedirs(os.path.join(site, "assets"), exist_ok=True)
    open(os.path.join(site, "index.html"), "w", encoding="utf-8").write(
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="./assets/s.css"></head>'
        '<body><h1 id="t">画面案</h1><script src="./app.js"></script></body></html>')
    open(os.path.join(site, "app.js"), "w", encoding="utf-8").write('document.getElementById("t").textContent="動いた";')
    open(os.path.join(site, "assets", "s.css"), "w", encoding="utf-8").write("h1{color:green}")

    created = json.loads(run_client(kind, ["mockup-upload", site, "--name", f"smoke-mockup-{kind}"], env).stdout)
    check(created["fileCount"] == 3, "mockup-upload: ディレクトリをZIPに固めて登録できる")
    check(created["entryFile"] == "index.html", "mockup-upload: 直下のindex.htmlが入口になる")
    check(created["zipFile"].endswith(".zip") and not created["zipFile"].startswith("tmp"),
          "mockup-upload: ZIPの名前がディレクトリ名から付く")
    check(created["viewUrl"].endswith(f"/api/mockups/{created['id']}/view"),
          "mockup-upload: 利用者に渡す表示URLを返す")

    # 入口が無いまま登録すると「登録できたのに開けない」ものが出来る。送る前に止める
    broken = os.path.join(workdir, f"mockup-broken-{kind}")
    os.makedirs(broken, exist_ok=True)
    open(os.path.join(broken, "main.html"), "w", encoding="utf-8").write("<html></html>")
    failed = run_client(kind, ["mockup-upload", broken], env, expect_ok=False)
    check(failed.returncode == 1 and "index.html" in failed.stderr, "mockup-upload: 入口が無ければ送る前に止める")

    found = json.loads(run_client(kind, ["mockups", "--q", "画面案"], env).stdout)
    check(any(m["id"] == created["id"] for m in found), "mockups --q: 中のHTMLのテキストで探せる")

    renamed = json.loads(run_client(kind, ["mockup-rename", created["id"], f"改名-{kind}"], env).stdout)
    check(renamed["name"] == f"改名-{kind}", "mockup-rename: 名前を変えられる")
    memo = json.loads(run_client(kind, ["mockup-memo", created["id"], "確認してほしい点"], env).stdout)
    check(memo["memo"] == "確認してほしい点", "mockup-memo: メモを書ける")

    saved = json.loads(run_client(kind, ["mockup-download", created["id"], "-o", os.path.join(workdir, f"dl-{kind}.zip")], env).stdout)
    check(saved["bytes"] > 0, "mockup-download: 原本のZIPを取得できる")

    archived = json.loads(run_client(kind, ["mockup-archive", created["id"]], env).stdout)
    check(archived["archived"] is True, "mockup-archive: アーカイブできる")
    listed = json.loads(run_client(kind, ["mockups", "--archived"], env).stdout)
    check(any(m["id"] == created["id"] for m in listed), "mockups --archived: アーカイブ済みを一覧できる")
    restored = json.loads(run_client(kind, ["mockup-restore", created["id"]], env).stdout)
    check(restored["archived"] is False, "mockup-restore: 元に戻せる")


def smoke_update_notice(kind, env):
    """サーバーに新しいクライアントがあるとき、更新方法つきで知らせる(AIが利用者へ伝えられるように)"""
    # テストサーバーは SKILL_CLIENT_VERSION=9.9.9 を名乗る(serve.js参照)
    proc = run_client(kind, ["search"], env)
    check("[更新のお知らせ]" in proc.stderr, "古いクライアントには更新のお知らせが出る")
    check("api/claude-skill.zip" in proc.stderr, "更新方法(ZIPの取得先)が示される")
    check("9.9.9" in proc.stderr, "サーバー側の版が示される")
    check(proc.returncode == 0, "お知らせが出ても、コマンド自体は成功する")
    check(proc.stdout.lstrip().startswith("["), "お知らせは標準エラーに出す(標準出力のJSONを壊さない)")


def smoke_render(kind, env, workdir):
    """Office文書の体裁つきPDF。テストサーバーには変換サービスのスタブが繋がっている"""
    fixture = os.path.join(REPO, "test", "fixtures", "office", "sample.xlsx")
    uploaded = json.loads(run_client(kind, ["upload", fixture], env).stdout)
    # 変換は裏で走るため、状態が確定するまで待つ
    status = None
    for _ in range(50):
        status = json.loads(run_client(kind, ["get", uploaded["id"]], env).stdout).get("renderStatus")
        if status == "ok":
            break
        time.sleep(0.2)
    check(status == "ok", f"upload: Office文書は体裁つきPDFが用意される (renderStatus={status})")

    out = os.path.join(workdir, f"rendered-{kind}.pdf")
    run_client(kind, ["download", uploaded["id"], "--render", "-o", out], env)
    with open(out, "rb") as f:
        head = f.read(5)
    check(head == b"%PDF-", "download --render: PDFとして保存される")

    plain = json.loads(run_client(kind, ["upload", os.path.join(workdir, f"smoke-{kind}.md")], env).stdout)
    denied = run_client(kind, ["download", plain["id"], "--render"], env, expect_ok=False)
    check(denied.returncode == 1 and "体裁つき" in denied.stderr, "download --render: 対象外の文書ははっきり断る")


# HTML→PDFの変換サービスのスタブ(test/api/serve.js が、Office用のスタブの10番あとで起動している)
PDF_STUB_URL = f"http://127.0.0.1:{int(os.environ.get('CONVERTER_STUB_PORT', '18096')) + 10}"


def control_pdf_stub(**control):
    req = urllib.request.Request(
        PDF_STUB_URL + "/__control", data=json.dumps(control).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req).read()


def smoke_pdf(kind, env, workdir):
    """HTML・Markdown・MHTMLをPDFにして取得する(人に渡すための形)。変換サービスにはスタブが繋がっている"""
    control_pdf_stub(mode="ok", blocked=0, reset=True)
    markdown = json.loads(run_client(kind, ["upload", os.path.join(workdir, f"smoke-{kind}.md")], env).stdout)

    # 保存先にディレクトリを渡すと、元の名前の拡張子を .pdf に替えた名前で保存される
    out_dir = os.path.join(workdir, f"pdf-{kind}")
    os.makedirs(out_dir, exist_ok=True)
    result = json.loads(run_client(kind, ["download", markdown["id"], "--pdf", "-o", out_dir], env).stdout)
    check(result.get("pdf") is True and result.get("rendered") is False, "download --pdf: PDFにしたことが結果で分かる")
    check(os.path.basename(result["savedTo"]) == f"smoke-{kind}.pdf", f"download --pdf: 保存名は拡張子を .pdf に替えたもの ({os.path.basename(result['savedTo'])})")
    with open(result["savedTo"], "rb") as f:
        check(f.read(5) == b"%PDF-", "download --pdf: PDFとして保存される")
    check(result.get("blockedRequests") == 0 and "warning" not in result, "download --pdf: 外部の部品が無ければ警告は出ない")

    # 変換サービスへ渡っているのは、整えたプレビュー(原本のMarkdownではない)
    sent = json.loads(urllib.request.urlopen(PDF_STUB_URL + "/__requests").read())
    check(len(sent) == 1 and sent[0]["path"] == "/convert" and "<h1" in sent[0]["bodyHead"], "download --pdf: 整えたプレビューがPDFになる")

    # 外部の画像が入らなかったときは、エージェントが利用者に伝えられるよう結果に出す
    control_pdf_stub(blocked=2)
    warned = json.loads(run_client(kind, ["download", markdown["id"], "--pdf", "-o", out_dir], env).stdout)
    check(warned.get("blockedRequests") == 2 and "2 件" in warned.get("warning", ""), "download --pdf: 外部の画像が入らなかった件数と警告を返す")
    control_pdf_stub(blocked=0)

    # 取り違えたときは、正しいほうを案内する
    office = json.loads(run_client(kind, ["upload", os.path.join(REPO, "test", "fixtures", "office", "sample.docx")], env).stdout)
    denied = run_client(kind, ["download", office["id"], "--pdf"], env, expect_ok=False)
    check(denied.returncode == 1 and "--render" in denied.stderr, "download --pdf: Office文書には --render を案内する")
    swapped = run_client(kind, ["download", markdown["id"], "--render"], env, expect_ok=False)
    check(swapped.returncode == 1 and "--pdf" in swapped.stderr, "download --render: HTML・Markdownには --pdf を案内する")
    both = run_client(kind, ["download", markdown["id"], "--render", "--pdf"], env, expect_ok=False)
    check(both.returncode == 1 and "同時に指定できません" in both.stderr, "download: --render と --pdf は同時に指定できない")

    # 変換サービスが不調のときは、理由が分かるエラーにする(黙って原本を保存しない)
    control_pdf_stub(mode="fail", status=500)
    before = set(os.listdir(out_dir))
    failed = run_client(kind, ["download", markdown["id"], "--pdf", "-o", os.path.join(out_dir, "failed.pdf")], env, expect_ok=False)
    check(failed.returncode == 1 and "502" in failed.stderr and "変換サービス" in failed.stderr, "download --pdf: 変換に失敗したら理由を返す(502)")
    check(set(os.listdir(out_dir)) == before, "download --pdf: 失敗したときは何も保存しない")
    control_pdf_stub(mode="ok", status=500, reset=True)


def smoke_spec(kind, env):
    """同梱コマンドに無い操作を呼ぶための、サーバー配信のAPI仕様"""
    usage = run_client(kind, ["spec"], env).stdout
    check(usage.startswith("# Document Manager API"), "spec: AI向け利用ガイド(Markdown)を取得できる")
    check("Authorization: Bearer" in usage, "spec: 認証の説明を含む")
    openapi = json.loads(run_client(kind, ["spec", "--openapi"], env).stdout)
    check(openapi.get("openapi", "").startswith("3.1"), "spec --openapi: OpenAPI 3.1のJSONを取得できる")
    create_key = openapi["paths"]["/api/apikeys"]["post"]
    check(create_key.get("x-api-key-usable") is False, "spec --openapi: APIキーの発行はAPIキーからは実行不可と示される")


def start_watch(kind, args, env):
    cmd = [sys.executable, PY_CLIENT] if kind == "python" else ["node", NODE_CLIENT]
    return subprocess.Popen(cmd + ["watch"] + args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")


def smoke_watch(kind, env, workdir):
    # --action upload で絞り込み、タグ変更は無視してアップロードだけを1件受け取って終了する
    watcher = start_watch(kind, ["--count", "1", "--timeout", "30", "--action", "upload"], env)
    time.sleep(2)  # SSE接続が張られるのを待つ(接続前のイベントは届かない)
    name = f"watch-{kind}.txt"
    path = os.path.join(workdir, name)
    open(path, "w", encoding="utf-8").write("watch")
    target = json.loads(run_client(kind, ["upload", path], env).stdout)
    run_client(kind, ["upload", path, "--replace-same-name"], env)  # revise は --action で除外される
    out, err = watcher.communicate(timeout=40)
    lines = [json.loads(line) for line in out.splitlines() if line.strip()]
    check(watcher.returncode == 0 and len(lines) == 1, f"watch: --count 1 で1件受け取って終了する ({err.strip()})")
    event = lines[0] if lines else {}
    check(event.get("event") == "document-activity" and event.get("action") == "upload"
          and event.get("documentId") == target["id"] and event.get("entryFile") == name, "watch: アップロードの通知内容(操作・文書ID・ファイル名)")
    check(event.get("viaApiKey") is True, "watch: APIキー経由の操作として通知される")

    started = time.monotonic()
    idle = start_watch(kind, ["--timeout", "2"], env)
    idle.communicate(timeout=20)
    elapsed = time.monotonic() - started
    check(idle.returncode == 0 and elapsed < 10, f"watch: --timeout で期限どおりに終了する ({elapsed:.1f}秒)")

    denied = start_watch(kind, ["--timeout", "5"], {**env, "DM_API_KEY": "dm_invalid"})
    _, denied_err = denied.communicate(timeout=20)
    check(denied.returncode == 1 and "401" in denied_err, "watch: 不正なキーは再接続せずエラー(401)")


def main():
    data_dir = tempfile.mkdtemp(prefix="dm-skill-smoke-")
    workdir = tempfile.mkdtemp(prefix="dm-skill-work-")
    server_env = {
        **os.environ,
        "DATABASE_BACKEND": "sqlite",
        "STORAGE_BACKEND": "local",
        "DATA_DIR": data_dir,
        "LISTEN_PORT": str(PORT),
        "SESSION_SECRET": "skill-smoke",
        # モックアップは既定Off。クライアントのコマンドを試すため開けておく
        "MOCKUPS_ENABLED": "true",
        "LOG_LEVEL": "warn"
    }
    server = subprocess.Popen(["node", os.path.join(REPO, "test", "api", "serve.js")], cwd=REPO, env=server_env)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(BASE_URL + "_ping", timeout=1)
                break
            except OSError:
                if server.poll() is not None:
                    raise SystemExit("テストサーバが起動できませんでした")
                time.sleep(0.5)
        else:
            raise SystemExit("テストサーバの起動待ちがタイムアウトしました")

        keys = json.load(open(KEYS_FILE, encoding="utf-8"))
        env = {**os.environ, "DM_BASE_URL": BASE_URL, "DM_API_KEY": keys["readwrite"], "DM_CONFIG": os.path.join(workdir, "none.json")}

        for skill_dir in (SKILL_DIR, BACKLOG_DIR):
            check_skill_md(skill_dir)
            check_referenced_scripts(skill_dir)
        # Backlogのクライアントは本物のBacklogが無いと動かせる操作が少ない。起動できて版を名乗れることだけ確かめる
        backlog_version = subprocess.run([sys.executable, BACKLOG_CLIENT, "--version"], capture_output=True, text=True, encoding="utf-8")
        printed = (backlog_version.stdout + backlog_version.stderr).strip()
        check(backlog_version.returncode == 0 and re.search(r"\d+\.\d+\.\d+", printed) is not None,
              f"backlog_client.py: 起動でき、版を名乗れる ({printed})")
        smoke_clients(env, workdir)
        smoke_setup("python", [sys.executable, PY_CLIENT], "DM", workdir, keys["readwrite"], ["--base-url", BASE_URL])
        smoke_setup("node", ["node", NODE_CLIENT], "DM", workdir, keys["readwrite"], ["--base-url", BASE_URL])
        smoke_setup("backlog", [sys.executable, BACKLOG_CLIENT], "BACKLOG", workdir, "backlogkey1234567890", ["--space", "example.backlog.jp"])

        built = subprocess.run([sys.executable, os.path.join(HERE, "build_skill_zip.py")], capture_output=True, text=True, encoding="utf-8")
        check(built.returncode == 0, "build_skill_zip.py でZIPを作成できる")
        built_files = check_zip(open(os.path.join(HERE, "dist", "document-manager-skill.zip"), "rb").read(), "build_skill_zip.py")

        req = urllib.request.Request(BASE_URL + "api/claude-skill.zip", headers={"Authorization": f"Bearer {keys['readonly']}"})
        served_files = check_zip(urllib.request.urlopen(req).read(), "api/claude-skill.zip")
        check(built_files == served_files, "CIで作ったZIPとサーバーが配信するZIPの中身が一致する")

        # 関連するSkill(Backlog)も、同じ画面から配る
        backlog_required = ("SKILL.md", "scripts/backlog_client.py")
        built_backlog = check_zip(open(os.path.join(HERE, "dist", "backlog-skill.zip"), "rb").read(), "build_skill_zip.py(backlog)", "backlog", backlog_required)
        req = urllib.request.Request(BASE_URL + "api/related-skills/backlog.zip", headers={"Authorization": f"Bearer {keys['readonly']}"})
        served_backlog = check_zip(urllib.request.urlopen(req).read(), "api/related-skills/backlog.zip", "backlog", backlog_required)
        check(built_backlog == served_backlog, "CIで作ったBacklogのZIPと、サーバーが配信するZIPの中身が一致する")
    finally:
        server.terminate()
        server.wait(timeout=10)
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(data_dir, ignore_errors=True)

    if failures:
        print(f"\n{len(failures)} 件失敗しました")
        sys.exit(1)
    print("\nすべて成功しました")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
