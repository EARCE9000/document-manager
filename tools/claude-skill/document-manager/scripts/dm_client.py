#!/usr/bin/env python3
"""
dm_client.py : Document Manager の API クライアント(Python 3.8+ / 標準ライブラリのみ)

AIエージェント(Claude Code / Codex / Antigravity)の Skill から呼び出す想定のコマンドラインツール。結果は JSON で標準出力へ出す。

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
  python dm_client.py watch [--count N] [--timeout 秒] [--action upload,revise,...] [--all]
                                       操作の通知(SSE)を待ち受け、1イベント1行のJSONで出力する
"""

import argparse
import json
import mimetypes
import os
import socket
import sys
import threading
import time
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


# SSEはサーバーが30秒ごとにハートビートを送るため、それより十分長く無通信なら切れたとみなして再接続する
WATCH_IDLE_TIMEOUT = 75
WATCH_ACTIVITY_EVENT = "document-activity"


def iter_sse_events(res):
    """SSEのレスポンスから (event名, dataの文字列) を順に返す。コメント行(:heartbeat 等)は読み捨てる"""
    event, data = "message", []
    while True:
        line = res.readline()
        if not line:
            return  # サーバー側で切断された
        line = line.decode("utf-8").rstrip("\r\n")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())


def shutdown_socket(res):
    """レスポンスの下にあるソケットを shutdown し、ブロック中の読み取りを即座に終わらせる"""
    try:
        sock = socket.socket(fileno=res.fileno())
        try:
            sock.shutdown(socket.SHUT_RDWR)
        finally:
            sock.detach()  # fdの所有権は元のレスポンス側に残す(二重closeを避ける)
    except (OSError, ValueError):
        pass


def cmd_watch(args):
    """操作の通知を待ち受けて、1イベント1行のJSON(NDJSON)で標準出力へ流す。
    切断されたら自動で再接続する(切断中のイベントは再送されない)"""
    base_url, api_key = load_config()
    actions = {a.strip() for a in args.action.split(",") if a.strip()} if args.action else None
    deadline = time.monotonic() + args.timeout if args.timeout else None
    printed = 0
    backoff = 1
    while True:
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            print("タイムアウトしました", file=sys.stderr)
            return None
        req = urllib.request.Request(urllib.parse.urljoin(base_url, "api/documents/events"),
                                     headers={"Authorization": f"Bearer {api_key}", "Accept": "text/event-stream"})
        timer = None
        try:
            with urllib.request.urlopen(req, timeout=WATCH_IDLE_TIMEOUT) as res:
                backoff = 1
                if remaining is not None:
                    # 全体の期限が来たら接続を切って、待ち受け中の読み取りを終わらせる
                    # (別スレッドからの close() ではWindowsで読み取りが解除されないため、ソケットをshutdownする)
                    timer = threading.Timer(remaining, shutdown_socket, args=(res,))
                    timer.daemon = True
                    timer.start()
                for event, data in iter_sse_events(res):
                    if event != WATCH_ACTIVITY_EVENT and not args.all:
                        continue
                    try:
                        payload = json.loads(data) if data else {}
                    except ValueError:
                        payload = {"data": data}
                    if event == WATCH_ACTIVITY_EVENT and actions is not None and payload.get("action") not in actions:
                        continue
                    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)
                    printed += 1
                    if args.count and printed >= args.count:
                        return None
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise DmError(json.dumps({"status": err.code, "error": err.read().decode("utf-8", "replace")}, ensure_ascii=False)) from None
            print(f"接続エラー(HTTP {err.code})。再接続します", file=sys.stderr)
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError, ValueError, AttributeError) as err:
            if deadline is not None and time.monotonic() >= deadline:
                print("タイムアウトしました", file=sys.stderr)
                return None
            if args.no_reconnect:
                raise DmError(f"接続が切れました: {err}") from None
            print(f"接続が切れました({err})。{backoff}秒後に再接続します", file=sys.stderr)
        else:
            if deadline is not None and time.monotonic() >= deadline:
                print("タイムアウトしました", file=sys.stderr)
                return None
            if args.no_reconnect:
                raise DmError("サーバーが接続を閉じました")
        finally:
            if timer is not None:
                timer.cancel()
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)


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
    p = sub.add_parser("watch", help="操作の通知(SSE)を待ち受ける")
    p.add_argument("--count", type=int, help="この件数のイベントを受け取ったら終了する")
    p.add_argument("--timeout", type=float, help="この秒数が経ったら終了する")
    p.add_argument("--action", help="通知する操作の種類(カンマ区切り): upload,revise,tags,archive,restore")
    p.add_argument("--all", action="store_true", help="一覧の変更通知(documents-changed/projects-changed)も出力する")
    p.add_argument("--no-reconnect", action="store_true", help="切断されたら再接続せずに終了する")
    p.set_defaults(func=cmd_watch, streaming=True)

    # Windows(cp932等)のコンソールでも日本語のJSON・エラーメッセージが化けないようUTF-8で出す
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = parser.parse_args()
    try:
        result = args.func(args)
    except DmError as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    if getattr(args, "streaming", False):
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
