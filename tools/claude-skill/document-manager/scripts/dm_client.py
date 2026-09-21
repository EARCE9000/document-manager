#!/usr/bin/env python3
"""
dm_client.py : Document Manager の API クライアント(Python 3.8+ / 標準ライブラリのみ)

Claude Code の Skill から呼び出す想定のコマンドラインツール。結果は JSON で標準出力へ出す。

接続情報(いずれか。上から優先):
  1. 環境変数 DM_BASE_URL / DM_API_KEY
  2. 設定ファイル ~/.document-manager.json  {"baseUrl": "https://.../", "apiKey": "dm_..."}
     (環境変数 DM_CONFIG で別パスを指定可)

使い方:
  python dm_client.py config                       接続先の確認(キーは伏せて表示)
  python dm_client.py search [検索語]              一覧・全文検索(アーカイブ済みは除く)
  python dm_client.py get <文書ID>                 文書1件の情報(アーカイブ済みも可)
  python dm_client.py versions <文書ID>            版履歴(古い順)
  python dm_client.py upload <ファイル> [--previous-id ID | --replace-same-name]
                                       [--preview 画像] [--tags タグ1,タグ2]
  python dm_client.py download <文書ID> [-o 保存先]
"""

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONFIG_PATH = os.environ.get("DM_CONFIG") or os.path.join(os.path.expanduser("~"), ".document-manager.json")


class DmError(Exception):
    pass


def load_config():
    base_url = os.environ.get("DM_BASE_URL")
    api_key = os.environ.get("DM_API_KEY")
    if (not base_url or not api_key) and os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        base_url = base_url or data.get("baseUrl")
        api_key = api_key or data.get("apiKey")
    if not base_url or not api_key:
        raise DmError(
            "接続情報がありません。環境変数 DM_BASE_URL / DM_API_KEY を設定するか、"
            f"{CONFIG_PATH} に {{\"baseUrl\": \"...\", \"apiKey\": \"dm_...\"}} を作成してください"
        )
    # BASE_PATH配下(例: https://host/docs/)でも相対パスで正しく結合できるよう末尾を / に揃える
    if not base_url.endswith("/"):
        base_url += "/"
    return base_url, api_key


def request(method, path, *, query=None, body=None, content_type=None, raw=False):
    base_url, api_key = load_config()
    url = urllib.parse.urljoin(base_url, path)
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"Authorization": f"Bearer {api_key}"}
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            data = body
            headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            payload = res.read()
            if raw:
                return payload, res.headers
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            detail = json.loads(text)
        except ValueError:
            detail = {"error": text}
        raise DmError(json.dumps({"status": err.code, **detail}, ensure_ascii=False)) from None
    except urllib.error.URLError as err:
        raise DmError(f"接続できません: {url} ({err.reason})") from None


def build_multipart(fields, files):
    """fields: {name: str}, files: {name: path}。ファイル名は UTF-8 のまま送る(サーバー側で復元される)"""
    boundary = f"----dmclient{uuid.uuid4().hex}"
    chunks = []
    for name, value in fields.items():
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
        )
    for name, path in files.items():
        filename = os.path.basename(path).replace('"', "_")
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            content = f.read()
        chunks.append(
            (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
             f"Content-Type: {mime}\r\n\r\n").encode("utf-8") + content + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def find_same_name_document(filename):
    """アーカイブされていない文書の中から、ファイル名が完全一致するものを探す(新しい版の自動判定用)"""
    docs = request("GET", "api/documents", query={"q": filename})
    matches = [d for d in docs if d.get("entryFile") == filename]
    if len(matches) > 1:
        raise DmError(json.dumps({
            "error": "同じファイル名の文書が複数あるため旧版を特定できません。--previous-id で指定してください",
            "candidates": [{"id": d["id"], "entryFile": d["entryFile"], "modified": d.get("modified")} for d in matches]
        }, ensure_ascii=False))
    return matches[0] if matches else None


def cmd_config(_args):
    base_url, api_key = load_config()
    return {"baseUrl": base_url, "apiKey": api_key[:6] + "..." if api_key else None, "configPath": CONFIG_PATH}


def cmd_search(args):
    return request("GET", "api/documents", query={"q": args.query} if args.query else None)


def cmd_get(args):
    return request("GET", f"api/documents/{urllib.parse.quote(args.id, safe='')}")


def cmd_versions(args):
    return request("GET", f"api/documents/{urllib.parse.quote(args.id, safe='')}/versions")


def cmd_upload(args):
    if not os.path.isfile(args.file):
        raise DmError(f"ファイルがありません: {args.file}")
    previous_id = args.previous_id
    if previous_id is None and args.replace_same_name:
        same = find_same_name_document(os.path.basename(args.file))
        previous_id = same["id"] if same else None
    fields = {"previousId": previous_id} if previous_id else {}
    files = {"uploadfile": args.file}
    if args.preview:
        files["previewfile"] = args.preview
    body, content_type = build_multipart(fields, files)
    uploaded = request("POST", "api/documents", body=body, content_type=content_type)
    if args.tags:
        # 旧版から引き継いだタグは残したまま追加する(タグAPIは一式置き換えのため和集合を送る)
        extra = [t.strip() for t in args.tags.split(",") if t.strip()]
        tags = list(dict.fromkeys(uploaded.get("tags", []) + extra))
        uploaded["tags"] = request("PUT", f"api/documents/{urllib.parse.quote(uploaded['id'], safe='')}/tags", body={"tags": tags})["tags"]
    return uploaded


def cmd_download(args):
    doc = cmd_get(args)
    payload, _headers = request("GET", f"api/documents/{urllib.parse.quote(args.id, safe='')}/file", query={"download": "1"}, raw=True)
    out = args.output or doc["entryFile"]
    if os.path.isdir(out):
        out = os.path.join(out, doc["entryFile"])
    with open(out, "wb") as f:
        f.write(payload)
    return {"id": doc["id"], "entryFile": doc["entryFile"], "savedTo": os.path.abspath(out), "size": len(payload)}


def main():
    parser = argparse.ArgumentParser(description="Document Manager API client")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("config", help="接続先の確認").set_defaults(func=cmd_config)
    p = sub.add_parser("search", help="一覧・検索")
    p.add_argument("query", nargs="?")
    p.set_defaults(func=cmd_search)
    p = sub.add_parser("get", help="文書1件の情報")
    p.add_argument("id")
    p.set_defaults(func=cmd_get)
    p = sub.add_parser("versions", help="版履歴")
    p.add_argument("id")
    p.set_defaults(func=cmd_versions)
    p = sub.add_parser("upload", help="アップロード")
    p.add_argument("file")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--previous-id", help="旧版の文書ID(新しい版として登録し、旧版はアーカイブされる)")
    group.add_argument("--replace-same-name", action="store_true", help="同名の既存文書があれば、その新しい版として登録する")
    p.add_argument("--preview", help=".drawio 用のプレビュー画像(svg/png/jpg)")
    p.add_argument("--tags", help="追加するタグ(カンマ区切り)")
    p.set_defaults(func=cmd_upload)
    p = sub.add_parser("download", help="ダウンロード")
    p.add_argument("id")
    p.add_argument("-o", "--output", help="保存先(ファイルまたはディレクトリ。省略時はカレントに元のファイル名で保存)")
    p.set_defaults(func=cmd_download)

    # Windows(cp932等)のコンソールでも日本語のJSON・エラーメッセージが化けないようUTF-8で出す
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = parser.parse_args()
    try:
        result = args.func(args)
    except DmError as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
