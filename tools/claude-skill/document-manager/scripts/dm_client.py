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
  python dm_client.py search [検索語] [--archived] 一覧・全文検索(--archivedでアーカイブ済みを対象にする)
  python dm_client.py search <検索語> --semantic [--limit N]   意味検索(言い換え・表記ゆれを含む)
  python dm_client.py get <文書ID>                 文書1件の情報(アーカイブ済みも可)
  python dm_client.py versions <文書ID>            版履歴(古い順)
  python dm_client.py upload <ファイル> [--previous-id ID | --replace-same-name]
                                       [--preview 画像(.drawioの代替表示用。通常は不要)] [--tags タグ1,タグ2]
                                       [--project プロジェクト] [--folder フォルダ]
  python dm_client.py download <文書ID> [-o 保存先]
  python dm_client.py tags <文書ID> [--add A,B | --remove A,B | --set A,B]   タグの確認・変更
  python dm_client.py memo <文書ID> <メモ本文>     メモの更新(全文置き換え)
  python dm_client.py archive <文書ID>             アーカイブ(論理削除。restoreで戻せる)
  python dm_client.py restore <文書ID>             アーカイブから元に戻す
  python dm_client.py links <文書ID>               関連文書の一覧
  python dm_client.py link <文書ID> <相手の文書ID> 関連文書として紐づける(対等な紐付け)
  python dm_client.py unlink <文書ID> <相手の文書ID>
  python dm_client.py link-previous <新版ID> <旧版ID>   後から旧版として紐づける(旧版はアーカイブされる)
  python dm_client.py unlink-previous <文書ID>     版の紐付けを解除する
  python dm_client.py projects [--archived]        プロジェクト一覧
  python dm_client.py project-create <名前>        プロジェクトの作成
  python dm_client.py folder-create <プロジェクト> <名前> [--parent 親フォルダ]
  python dm_client.py tree <プロジェクト>          フォルダ階層と文書の配置
  python dm_client.py place <プロジェクト> <文書ID> [--folder フォルダ]   プロジェクトへ登録・移動
  python dm_client.py unplace <プロジェクト> <文書ID>   プロジェクトから外す(文書自体は残る)
  python dm_client.py watch [--count N] [--timeout 秒] [--action upload,revise,...] [--all]
                                       操作の通知(SSE)を待ち受け、1イベント1行のJSONで出力する
  python dm_client.py spec [--openapi]             APIの仕様(既定はAI向けMarkdown)をそのまま出力する
  python dm_client.py --version                    このクライアントのバージョン

プロジェクト・フォルダはIDでも名前でも指定できる(同じ名前が複数あるときはIDで指定する)。
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

# このクライアント(Skill)のバージョン。dm_client.mjs と必ず揃える(結合テストで検証している)。
# 変更したらタグ skill-v<この値> を打つと、CIがGitHub Releaseを作る
CLIENT_VERSION = "1.0.0"
USER_AGENT = f"document-manager-skill/{CLIENT_VERSION} (python {sys.version_info.major}.{sys.version_info.minor})"


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
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT}
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


def quote_id(value):
    return urllib.parse.quote(str(value), safe="")


def split_list(value):
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def resolve_project(value):
    """プロジェクトをIDでも名前でも指定できるようにする(一覧に出た名前をそのまま渡せる)"""
    projects = request("GET", "api/projects")
    for project in projects:
        if project.get("id") == value:
            return project
    matches = [project for project in projects if project.get("name") == value]
    if len(matches) > 1:
        raise DmError(json.dumps({
            "error": "同じ名前のプロジェクトが複数あります。IDで指定してください",
            "candidates": [{"id": p["id"], "name": p.get("name")} for p in matches]
        }, ensure_ascii=False))
    if not matches:
        raise DmError(f"プロジェクトが見つかりません: {value}")
    return matches[0]


def resolve_folder(project_id, value):
    """フォルダをIDでも名前でも指定できるようにする。未指定ならプロジェクト直下(None)"""
    if not value:
        return None
    folders = request("GET", f"api/projects/{quote_id(project_id)}/tree").get("folders", [])
    for folder in folders:
        if folder.get("id") == value:
            return folder["id"]
    matches = [folder for folder in folders if folder.get("name") == value]
    if len(matches) > 1:
        raise DmError(json.dumps({
            "error": "同じ名前のフォルダが複数あります。IDで指定してください",
            "candidates": [{"id": f["id"], "name": f.get("name")} for f in matches]
        }, ensure_ascii=False))
    if not matches:
        raise DmError(f"フォルダが見つかりません: {value}")
    return matches[0]["id"]


def place_document(project_value, document_id, folder_value):
    project = resolve_project(project_value)
    folder_id = resolve_folder(project["id"], folder_value)
    request("PUT", f"api/projects/{quote_id(project['id'])}/documents/{quote_id(document_id)}", body={"folderId": folder_id})
    return {"projectId": project["id"], "projectName": project.get("name"), "folderId": folder_id}


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
    return {
        "clientVersion": CLIENT_VERSION,
        "baseUrl": base_url,
        "apiKey": api_key[:6] + "..." if api_key else None,
        "configPath": CONFIG_PATH
    }


def cmd_search(args):
    if args.semantic:
        # 意味検索。キーワードの一致ではなく内容が近いものをスコア順に返す
        # (サーバー側でベクトル検索が無効なら503になる)
        if not args.query:
            raise DmError("意味検索には検索語が必要です")
        query = {"q": args.query}
        if args.limit:
            query["limit"] = args.limit
        return request("GET", "api/documents/search/vector", query=query)
    # --archived はアーカイブ(論理削除)済みの一覧・検索。完全削除ではなく復元できる文書
    path = "api/documents/archived" if args.archived else "api/documents"
    return request("GET", path, query={"q": args.query} if args.query else None)


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
        tags = list(dict.fromkeys(uploaded.get("tags", []) + split_list(args.tags)))
        uploaded["tags"] = request("PUT", f"api/documents/{quote_id(uploaded['id'])}/tags", body={"tags": tags})["tags"]
    if args.project:
        # 新しい版として登録した場合、配置は旧版から自動で引き継がれる(その上で移動したいときに使う)
        uploaded["project"] = place_document(args.project, uploaded["id"], args.folder)
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


def cmd_tags(args):
    """タグの確認・変更。タグAPIは一式置き換えのため、--add/--remove はこちらで現在のタグと合成する"""
    doc_id = quote_id(args.id)
    current = request("GET", f"api/documents/{doc_id}").get("tags", [])
    if args.set is None and args.add is None and args.remove is None:
        return {"id": args.id, "tags": current}
    if args.set is not None:
        tags = split_list(args.set)
    else:
        tags = list(current)
        for tag in split_list(args.add):
            if tag not in tags:
                tags.append(tag)
        removing = set(split_list(args.remove))
        tags = [tag for tag in tags if tag not in removing]
    return request("PUT", f"api/documents/{doc_id}/tags", body={"tags": tags})


def cmd_memo(args):
    return request("PUT", f"api/documents/{quote_id(args.id)}/memo", body={"memo": args.text})


def cmd_archive(args):
    request("DELETE", f"api/documents/{quote_id(args.id)}")
    return {"id": args.id, "archived": True, "note": "完全削除ではありません。restore で元に戻せます"}


def cmd_restore(args):
    request("POST", f"api/documents/{quote_id(args.id)}/restore")
    return {"id": args.id, "archived": False}


def cmd_links(args):
    return request("GET", f"api/documents/{quote_id(args.id)}/links")


def cmd_link(args):
    request("PUT", f"api/documents/{quote_id(args.id)}/links/{quote_id(args.related_id)}")
    return {"id": args.id, "relatedId": args.related_id, "linked": True}


def cmd_unlink(args):
    request("DELETE", f"api/documents/{quote_id(args.id)}/links/{quote_id(args.related_id)}")
    return {"id": args.id, "relatedId": args.related_id, "linked": False}


def cmd_link_previous(args):
    """既に別々に登録された文書同士を、後から新旧の版として紐づける。旧版はアーカイブされる"""
    return request("PUT", f"api/documents/{quote_id(args.id)}/previous", body={"previousId": args.previous_id})


def cmd_unlink_previous(args):
    request("DELETE", f"api/documents/{quote_id(args.id)}/previous")
    return {"id": args.id, "previousId": None, "note": "アーカイブされた旧版は元に戻りません。必要なら restore してください"}


def cmd_projects(args):
    return request("GET", "api/projects/archived" if args.archived else "api/projects")


def cmd_project_create(args):
    return request("POST", "api/projects", body={"name": args.name})


def cmd_folder_create(args):
    project = resolve_project(args.project)
    parent_folder_id = resolve_folder(project["id"], args.parent)
    folder = request("POST", f"api/projects/{quote_id(project['id'])}/folders",
                     body={"name": args.name, "parentFolderId": parent_folder_id})
    return {"projectId": project["id"], "projectName": project.get("name"), **(folder or {})}


def cmd_tree(args):
    project = resolve_project(args.project)
    tree = request("GET", f"api/projects/{quote_id(project['id'])}/tree")
    return {"projectId": project["id"], "projectName": project.get("name"), **tree}


def cmd_place(args):
    placed = place_document(args.project, args.id, args.folder)
    return {"documentId": args.id, **placed}


def cmd_unplace(args):
    project = resolve_project(args.project)
    request("DELETE", f"api/projects/{quote_id(project['id'])}/documents/{quote_id(args.id)}")
    return {"projectId": project["id"], "projectName": project.get("name"), "documentId": args.id, "removed": True}


def cmd_spec(args):
    """APIの仕様をそのまま出力する(同梱コマンドに無い操作を直接呼ぶときの参照用)"""
    payload, _headers = request("GET", "api/openapi.json" if args.openapi else "api/usage.md", raw=True)
    sys.stdout.write(payload.decode("utf-8", "replace"))
    return None


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
                                     headers={"Authorization": f"Bearer {api_key}", "Accept": "text/event-stream",
                                              "User-Agent": USER_AGENT})
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
    parser.add_argument("-V", "--version", action="version", version=f"dm_client.py {CLIENT_VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("config", help="接続先の確認").set_defaults(func=cmd_config)
    p = sub.add_parser("search", help="一覧・検索")
    p.add_argument("query", nargs="?")
    p.add_argument("--archived", action="store_true", help="アーカイブ済み(復元可能)の文書を対象にする")
    p.add_argument("--semantic", action="store_true", help="意味検索(言い換え・表記ゆれを含めて内容が近いものを返す)")
    p.add_argument("--limit", type=int, help="意味検索の取得件数(既定20)")
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
    p.add_argument("--preview", help=".drawio の代替プレビュー画像(svg/png/jpg)。通常は不要(画面が.drawioをそのまま描画する)")
    p.add_argument("--tags", help="追加するタグ(カンマ区切り)")
    p.add_argument("--project", help="登録先のプロジェクト(IDまたは名前)")
    p.add_argument("--folder", help="登録先のフォルダ(IDまたは名前。省略時はプロジェクト直下)")
    p.set_defaults(func=cmd_upload)
    p = sub.add_parser("download", help="ダウンロード")
    p.add_argument("id")
    p.add_argument("-o", "--output", help="保存先(ファイルまたはディレクトリ。省略時はカレントに元のファイル名で保存)")
    p.set_defaults(func=cmd_download)
    p = sub.add_parser("tags", help="タグの確認・変更")
    p.add_argument("id")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--set", help="タグを丸ごと置き換える(カンマ区切り。空文字で全解除)")
    group.add_argument("--add", help="追加するタグ(カンマ区切り)")
    group.add_argument("--remove", help="外すタグ(カンマ区切り)")
    p.set_defaults(func=cmd_tags)
    p = sub.add_parser("memo", help="メモの更新(全文置き換え)")
    p.add_argument("id")
    p.add_argument("text")
    p.set_defaults(func=cmd_memo)
    p = sub.add_parser("archive", help="アーカイブ(論理削除。restoreで戻せる)")
    p.add_argument("id")
    p.set_defaults(func=cmd_archive)
    p = sub.add_parser("restore", help="アーカイブから元に戻す")
    p.add_argument("id")
    p.set_defaults(func=cmd_restore)
    p = sub.add_parser("links", help="関連文書の一覧")
    p.add_argument("id")
    p.set_defaults(func=cmd_links)
    p = sub.add_parser("link", help="関連文書として紐づける")
    p.add_argument("id")
    p.add_argument("related_id")
    p.set_defaults(func=cmd_link)
    p = sub.add_parser("unlink", help="関連文書の紐付けを解除する")
    p.add_argument("id")
    p.add_argument("related_id")
    p.set_defaults(func=cmd_unlink)
    p = sub.add_parser("link-previous", help="後から旧版として紐づける(旧版はアーカイブされる)")
    p.add_argument("id", help="新しい版の文書ID")
    p.add_argument("previous_id", help="旧版の文書ID")
    p.set_defaults(func=cmd_link_previous)
    p = sub.add_parser("unlink-previous", help="版の紐付けを解除する")
    p.add_argument("id")
    p.set_defaults(func=cmd_unlink_previous)
    p = sub.add_parser("projects", help="プロジェクト一覧")
    p.add_argument("--archived", action="store_true", help="アーカイブ済みのプロジェクトを対象にする")
    p.set_defaults(func=cmd_projects)
    p = sub.add_parser("project-create", help="プロジェクトの作成")
    p.add_argument("name")
    p.set_defaults(func=cmd_project_create)
    p = sub.add_parser("folder-create", help="プロジェクト内にフォルダを作る")
    p.add_argument("project", help="プロジェクトのIDまたは名前")
    p.add_argument("name")
    p.add_argument("--parent", help="親フォルダのIDまたは名前(省略時はプロジェクト直下)")
    p.set_defaults(func=cmd_folder_create)
    p = sub.add_parser("tree", help="プロジェクトのフォルダ階層と文書の配置")
    p.add_argument("project", help="プロジェクトのIDまたは名前")
    p.set_defaults(func=cmd_tree)
    p = sub.add_parser("place", help="文書をプロジェクトへ登録・移動する")
    p.add_argument("project", help="プロジェクトのIDまたは名前")
    p.add_argument("id", help="文書ID")
    p.add_argument("--folder", help="フォルダのIDまたは名前(省略時はプロジェクト直下)")
    p.set_defaults(func=cmd_place)
    p = sub.add_parser("unplace", help="プロジェクトから文書を外す(文書自体は残る)")
    p.add_argument("project", help="プロジェクトのIDまたは名前")
    p.add_argument("id", help="文書ID")
    p.set_defaults(func=cmd_unplace)
    p = sub.add_parser("spec", help="APIの仕様を出力する(同梱コマンドに無い操作を呼ぶとき)")
    p.add_argument("--openapi", action="store_true", help="OpenAPI 3.1のJSONを出力する(既定はAI向けMarkdown)")
    p.set_defaults(func=cmd_spec, streaming=True)
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
