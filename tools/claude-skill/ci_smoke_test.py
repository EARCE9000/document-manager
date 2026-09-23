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


def check_skill_md():
    print("[SKILL.md]")
    text = open(os.path.join(SKILL_DIR, "SKILL.md"), encoding="utf-8").read()
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    check(m is not None, "YAMLフロントマターがある")
    fields = dict(re.findall(r"^(\w+):\s*(.+)$", m.group(1), re.M)) if m else {}
    check(fields.get("name") == "document-manager", "name がフォルダ名(document-manager)と一致する")
    check(re.fullmatch(r"[a-z0-9-]{1,64}", fields.get("name", "")) is not None, "name は小文字・数字・ハイフンのみ(64文字以内)")
    description = fields.get("description", "")
    check(0 < len(description) <= 1024, f"description が1〜1024文字 ({len(description)}文字)")


def check_zip(data, label):
    print(f"[ZIP: {label}]")
    zf = zipfile.ZipFile(io.BytesIO(data))
    check(zf.testzip() is None, "CRCエラーが無い")
    names = zf.namelist()
    check(all(n.startswith("document-manager/") for n in names), "中身が document-manager/ フォルダ1つにまとまっている")
    for required in ("SKILL.md", "README.md", "scripts/dm_client.py", "scripts/dm_client.mjs"):
        check(f"document-manager/{required}" in names, f"{required} を含む")
    for info in zf.infolist():
        mode = (info.external_attr >> 16) & 0o777
        expected = 0o755 if info.filename.startswith("document-manager/scripts/") else 0o644
        check(mode == expected, f"{info.filename} のパーミッションが {oct(expected)} ({oct(mode)})")
    # 配布物がリポジトリの内容と一致すること(古いファイルや余計なファイルが混ざっていない)
    for name in names:
        src = os.path.join(SKILL_DIR, *name.split("/")[1:])
        check(os.path.isfile(src) and open(src, "rb").read() == zf.read(name), f"{name} がリポジトリと同一")
    return {n: zf.read(n) for n in names}


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

        smoke_edit_commands(kind, env, v2["id"], v1["id"])
        smoke_project_commands(kind, env, workdir, v2["id"])
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

        check_skill_md()
        smoke_clients(env, workdir)

        built = subprocess.run([sys.executable, os.path.join(HERE, "build_skill_zip.py")], capture_output=True, text=True, encoding="utf-8")
        check(built.returncode == 0, "build_skill_zip.py でZIPを作成できる")
        built_files = check_zip(open(os.path.join(HERE, "dist", "document-manager-skill.zip"), "rb").read(), "build_skill_zip.py")

        req = urllib.request.Request(BASE_URL + "api/claude-skill.zip", headers={"Authorization": f"Bearer {keys['readonly']}"})
        served_files = check_zip(urllib.request.urlopen(req).read(), "api/claude-skill.zip")
        check(built_files == served_files, "CIで作ったZIPとサーバーが配信するZIPの中身が一致する")
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
