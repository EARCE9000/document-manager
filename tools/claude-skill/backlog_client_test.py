#!/usr/bin/env python3
"""
backlog_client_test.py : Backlog用クライアントの、通信しない部分のテスト

実行(リポジトリ直下):
  python tools/claude-skill/backlog_client_test.py

Backlogの実スペースが無くても確かめられるところだけを見る。中身は主に2つ。

  1. **接続先の絞り込み**。スペース名は設定から来るが、設定は環境変数でも渡せるため、
     取り違え・書き間違い・悪意のある指定でAPIキーが別のホストへ飛ぶことを防ぐ
  2. **保存先の正規化**。添付のファイル名を決めるのは添付した人であって、こちらではない。
     区切り文字が混じった名前をそのまま使うと、作業場所の外へ書き込める

どちらも「静かに間違ったことをする」たぐいなので、目で見て気づけない。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "backlog", "scripts"))

import backlog_client as bc  # noqa: E402

failures = []


def check(cond, message):
    print(("  ok   " if cond else "  FAIL ") + message)
    if not cond:
        failures.append(message)


def expect_error(func, message):
    try:
        func()
    except bc.BacklogError:
        check(True, message)
        return
    check(False, message)


print("■ スペースの指定")
for given, expected in [
    ("example.backlog.jp", "example.backlog.jp"),
    ("https://example.backlog.jp/", "example.backlog.jp"),
    ("https://example.backlog.jp", "example.backlog.jp"),
    ("  example.backlog.com  ", "example.backlog.com"),
    ("example.backlogtool.com", "example.backlogtool.com"),
]:
    check(bc.normalize_space(given) == expected, f"{given!r} → {expected}")

print("■ 受け付けないスペース(APIキーの送り先が変わるため)")
for given in [
    "evil.example.com",
    "example.backlog.jp.evil.com",   # 後ろに足して似せたもの
    "user:pw@example.backlog.jp",    # 認証情報を混ぜたもの
    "example.backlog.jp:8080",       # ポートを足したもの
    "http://127.0.0.1/",
    "backlog.jp",                    # スペース名が無い
    "",
]:
    if given == "":
        check(bc.normalize_space(given) is None, "空文字は未設定として扱う")
    else:
        expect_error(lambda g=given: bc.normalize_space(g), f"{given!r} を拒否する")

print("■ 添付の保存先(受け取った名前をそのまま使わない)")
for given, expected in [
    ("../../etc/passwd", "passwd"),
    ("..\\..\\windows\\win.ini", "win.ini"),
    ("/etc/shadow", "shadow"),
    ("ふつうの名前.png", "ふつうの名前.png"),
    ("", "attachment"),
    ("...", "attachment"),
]:
    got = bc.safe_local_filename(given)
    check(got == expected, f"{given!r} → {expected!r}(実際: {got!r})")

check(":" not in bc.safe_local_filename("C:evil.txt"), "ドライブ指定を持ち込ませない")

print("■ 名前からIDへの引き直し")
items = [{"id": 1, "name": "未対応"}, {"id": 2, "name": "処理中"}, {"id": 3, "name": "処理中"}]
check(bc.pick_by_name(items, "未対応", "状態") == 1, "名前で引ける")
check(bc.pick_by_name(items, "2", "状態") == 2, "IDを渡したらそのまま通す")
expect_error(lambda: bc.pick_by_name(items, "処理中", "状態"), "同じ名前が複数あるときは選ばずに止める")
expect_error(lambda: bc.pick_by_name(items, "存在しない", "状態"), "無い名前は候補を添えて止める")

print("■ 課題キーからプロジェクトキー")
check(bc.project_of_issue("PROJ-123") == "PROJ", "PROJ-123 → PROJ")
check(bc.project_of_issue("A-B-42") == "A-B", "ハイフンを含むキーは最後で切る")
expect_error(lambda: bc.project_of_issue("PROJ"), "課題キーの形でなければ止める")

print("■ raw のキー=値")
check(bc.parse_pairs(["a=1"], "--query") == {"a": "1"}, "1つなら素の値")
check(bc.parse_pairs(["a=1", "a=2"], "--query") == {"a": ["1", "2"]}, "同じキーは配列にする")
check(bc.parse_pairs(["a=x=y"], "--query") == {"a": "x=y"}, "値に = が入っていてもよい")
expect_error(lambda: bc.parse_pairs(["a"], "--query"), "= が無ければ止める")

print("■ 送り方")
body, content_type = bc.build_multipart({}, [("file", os.path.abspath(__file__))])
check(content_type.startswith("multipart/form-data; boundary="), "multipartで送る")
check(b'name="file"' in body, "Backlogが求める name=\"file\" で送る")

print("■ バージョン")
check(bc.CLIENT_VERSION.count(".") == 2, "x.y.z の形")

print()
if failures:
    print(f"失敗 {len(failures)} 件")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("すべて成功しました")
