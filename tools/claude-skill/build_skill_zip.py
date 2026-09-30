#!/usr/bin/env python3
"""
build_skill_zip.py : Claude Code 用 Skill を ZIP にまとめる

実行(リポジトリ直下):
  python tools/claude-skill/build_skill_zip.py                 全部まとめる
  python tools/claude-skill/build_skill_zip.py backlog         指定したものだけ

出力: tools/claude-skill/dist/<Skill名>-skill.zip

ZIP の中身は `<Skill名>/` フォルダ1つ(~/.claude/skills/ にそのまま展開でき、
claude.ai の Skill アップロード形式とも一致する)。scripts/ 配下には実行ビットを付けて格納する。

Skillは document-manager だけではない。Backlog のように**接続先が別のサービス**のものも
同じ形で置いており(tools/claude-skill/<名前>/)、どれも同じ手順でZIPにできるようにしている。
"""

import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(HERE, "dist")

EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git"}


def available_skills():
    """SKILL.md を持つフォルダを Skill とみなす(増やしてもここを直さなくてよい)"""
    return sorted(
        name for name in os.listdir(HERE)
        if os.path.isfile(os.path.join(HERE, name, "SKILL.md"))
    )


def build(skill_name):
    skill_dir = os.path.join(HERE, skill_name)
    output = os.path.join(DIST_DIR, f"{skill_name}-skill.zip")
    os.makedirs(DIST_DIR, exist_ok=True)
    entries = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(skill_dir):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
            for name in sorted(files):
                src = os.path.join(root, name)
                arcname = os.path.join(skill_name, os.path.relpath(src, skill_dir)).replace(os.sep, "/")
                info = zipfile.ZipInfo.from_file(src, arcname)
                info.compress_type = zipfile.ZIP_DEFLATED
                # Windowsで作っても展開先(macOS/Linux)でスクリプトを直接実行できるよう、
                # scripts/ 配下は 0755、それ以外は 0644 で格納する
                mode = 0o755 if arcname.startswith(f"{skill_name}/scripts/") else 0o644
                info.external_attr = (0o100000 | mode) << 16
                with open(src, "rb") as f:
                    zf.writestr(info, f.read())
                entries.append(arcname)
    print(f"created: {output}")
    for arcname in entries:
        print(f"  {arcname}")
    return output


def main():
    skills = available_skills()
    wanted = sys.argv[1:] or skills
    for name in wanted:
        if name not in skills:
            print(f"そのSkillはありません: {name}(あるのは: {', '.join(skills)})", file=sys.stderr)
            sys.exit(1)
    for name in wanted:
        build(name)


if __name__ == "__main__":
    main()
