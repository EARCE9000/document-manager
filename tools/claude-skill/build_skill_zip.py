#!/usr/bin/env python3
"""
build_skill_zip.py : Claude Code 用 Skill(document-manager/)を ZIP にまとめる

実行: リポジトリ直下で `python tools/claude-skill/build_skill_zip.py`
出力: tools/claude-skill/dist/document-manager-skill.zip

ZIP の中身は `document-manager/` フォルダ1つ(~/.claude/skills/ にそのまま展開でき、
claude.ai の Skill アップロード形式とも一致する)。scripts/ 配下には実行ビットを付けて格納する。
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_NAME = "document-manager"
SKILL_DIR = os.path.join(HERE, SKILL_NAME)
DIST_DIR = os.path.join(HERE, "dist")
OUTPUT = os.path.join(DIST_DIR, f"{SKILL_NAME}-skill.zip")

EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git"}


def main():
    os.makedirs(DIST_DIR, exist_ok=True)
    entries = []
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(SKILL_DIR):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
            for name in sorted(files):
                src = os.path.join(root, name)
                arcname = os.path.join(SKILL_NAME, os.path.relpath(src, SKILL_DIR)).replace(os.sep, "/")
                info = zipfile.ZipInfo.from_file(src, arcname)
                info.compress_type = zipfile.ZIP_DEFLATED
                # Windowsで作っても展開先(macOS/Linux)でスクリプトを直接実行できるよう、
                # scripts/ 配下は 0755、それ以外は 0644 で格納する
                mode = 0o755 if arcname.startswith(f"{SKILL_NAME}/scripts/") else 0o644
                info.external_attr = (0o100000 | mode) << 16
                with open(src, "rb") as f:
                    zf.writestr(info, f.read())
                entries.append(arcname)
    print(f"created: {OUTPUT}")
    for arcname in entries:
        print(f"  {arcname}")


if __name__ == "__main__":
    main()
