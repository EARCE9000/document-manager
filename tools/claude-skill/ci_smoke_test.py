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
    for kind in ("python", "node"):
        print(f"[client: {kind}]")
        name = f"smoke-{kind}.md"
        path = os.path.join(workdir, name)
        open(path, "w", encoding="utf-8").write(f"# {kind} v1 スモーク\n")

        config = json.loads(run_client(kind, ["config"], env).stdout)
        check(config["baseUrl"] == BASE_URL, "config: 接続先を環境変数から読める")

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

        outdir = os.path.join(workdir, f"dl-{kind}")
        os.makedirs(outdir)
        run_client(kind, ["download", v2["id"], "-o", outdir], env)
        check(open(os.path.join(outdir, name), encoding="utf-8").read() == f"# {kind} v2 スモーク\n", "download: 最新版の中身を保存できる")

        conflict = run_client(kind, ["upload", path, "--previous-id", v1["id"]], env, expect_ok=False)
        check(conflict.returncode == 1 and '"status"' in conflict.stderr and "409" in conflict.stderr, "upload: 最新でない旧版の指定はエラー(409)")

        bad = run_client(kind, ["search"], {**env, "DM_API_KEY": "dm_invalid"}, expect_ok=False)
        check(bad.returncode == 1 and "401" in bad.stderr, "不正なキーはエラー(401)")


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
