#!/usr/bin/env python3
"""
backlog_client.py : Backlog の API クライアント(Python 3.8+ / 標準ライブラリのみ)

AIエージェント(Claude Code / Codex / Antigravity)の Skill から呼び出す想定のコマンドラインツール。
結果は JSON で標準出力へ出す。

Backlog には MCP もあるが、**ファイル(画像・資料)の添付ができない**。このクライアントは
そこを埋めることを主目的にしている。添付が絡む操作は `--attach` で一気に済ませられる。

接続情報(いずれか。上から優先):
  1. 環境変数 BACKLOG_SPACE / BACKLOG_API_KEY
  2. 設定ファイル ~/.backlog.json  {"space": "example.backlog.jp", "apiKey": "..."}
     (環境変数 BACKLOG_CONFIG で別パスを指定可)

  space は `example.backlog.jp` のようなホスト名。`https://example.backlog.jp/` の形でも受け付ける。
  .backlog.com / .backlogtool.com も同じ。APIキーは Backlog の「個人設定 > API」で発行する。

使い方:
  python backlog_client.py config                          接続先の確認(キーは伏せて表示)
  python backlog_client.py myself                          自分の情報(疎通確認にも使える)
  python backlog_client.py projects [--all]                参加しているプロジェクト(--allで全件)
  python backlog_client.py project <プロジェクトキー>      プロジェクト1件
  python backlog_client.py issues [--project KEY] [--keyword 語] [--status 名前|ID]
                                  [--assignee 名前|ID] [--type 名前|ID] [--category 名前]
                                  [--milestone 名前] [--parent-child 条件] [--count N]
                                  [--order asc|desc] [--sort 項目] [--created-since YYYY-MM-DD]
  python backlog_client.py issue <課題キー>                課題1件(例: PROJ-123)
  python backlog_client.py issue-create --project KEY --summary 件名 --type 種別
                                  [--priority 優先度] [--description 本文] [--assignee 担当者]
                                  [--due-date YYYY-MM-DD] [--category 名前] [--milestone 名前]
                                  [--parent 親課題キー] [--attach ファイル ...]
  python backlog_client.py issue-update <課題キー> [--summary ...] [--description ...]
                                  [--status 名前] [--assignee 名前] [--priority 名前]
                                  [--due-date YYYY-MM-DD] [--comment 本文] [--attach ファイル ...]
  python backlog_client.py issue-delete <課題キー>
  python backlog_client.py comments <課題キー> [--count N] [--order asc|desc]
  python backlog_client.py comment-add <課題キー> <本文> [--attach ファイル ...]
  python backlog_client.py attach <ファイル> [...]         添付だけ先に送ってIDを得る(低レベル)
  python backlog_client.py attachments <課題キー>          課題に付いている添付の一覧
  python backlog_client.py attachment-download <課題キー> <添付ID> [-o 保存先]
  python backlog_client.py statuses --project KEY          状態の一覧
  python backlog_client.py issue-types --project KEY       種別の一覧
  python backlog_client.py categories --project KEY        カテゴリーの一覧
  python backlog_client.py milestones --project KEY        マイルストーンの一覧
  python backlog_client.py priorities                      優先度の一覧(スペース共通)
  python backlog_client.py users [--project KEY]           ユーザーの一覧
  python backlog_client.py raw <METHOD> <パス> [--query k=v ...] [--body JSON] [--form k=v ...]
                                  同梱していないAPIを直接呼ぶ(例: raw GET /api/v2/wikis --query projectIdOrKey=PROJ)
  python backlog_client.py --version                       このクライアントのバージョン

名前で指定できるもの(状態・種別・優先度・カテゴリー・マイルストーン・担当者)は、内部でIDへ引き直す。
同じ名前が複数あるときは曖昧だと伝えて止まるので、IDで指定すること。
"""

import argparse
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONFIG_PATH = os.environ.get("BACKLOG_CONFIG") or os.path.join(os.path.expanduser("~"), ".backlog.json")

# このクライアント(Skill)のバージョン。backlog_client.mjs と必ず揃える(結合テストで検証している)
CLIENT_VERSION = "1.0.0"
USER_AGENT = f"backlog-skill/{CLIENT_VERSION} (python {sys.version_info.major}.{sys.version_info.minor})"

# Backlogのスペースとして受け付けるホスト。ここを緩めると、APIキーを別のサーバーへ送れてしまう
ALLOWED_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*\.(backlog\.(jp|com)|backlogtool\.com)$")


class BacklogError(Exception):
    pass


# ---------------------------------------------------------------- 接続情報

def normalize_space(value):
    """`https://example.backlog.jp/` でも `example.backlog.jp` でも受け付けてホスト名に揃える"""
    text = str(value or "").strip()
    if text == "":
        return None
    if "//" in text:
        text = urllib.parse.urlparse(text).netloc or text
    text = text.strip("/").split("/")[0]
    # ポート番号や認証情報が混じった指定は受け付けない(正規のスペースには付かない)
    if "@" in text or ":" in text:
        raise BacklogError(f"スペースの指定が不正です: {value!r}")
    if not ALLOWED_HOST.match(text):
        raise BacklogError(
            f"Backlogのスペースとして扱えません: {text!r}\n"
            "  `example.backlog.jp` のような形で指定してください"
            "(.backlog.jp / .backlog.com / .backlogtool.com のみ)"
        )
    return text


def load_config():
    space = os.environ.get("BACKLOG_SPACE")
    api_key = os.environ.get("BACKLOG_API_KEY")
    if (not space or not api_key) and os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        space = space or data.get("space")
        api_key = api_key or data.get("apiKey")
    if not space or not api_key:
        raise BacklogError(
            "接続情報がありません。環境変数 BACKLOG_SPACE / BACKLOG_API_KEY を設定するか、"
            f"{CONFIG_PATH} に {{\"space\": \"example.backlog.jp\", \"apiKey\": \"...\"}} を作成してください\n"
            "  APIキーは Backlog の「個人設定 > API」で発行できます"
        )
    return normalize_space(space), api_key


# ---------------------------------------------------------------- 通信

def request(method, path, *, query=None, body=None, form=None, files=None, raw=False):
    """
    BacklogのAPIを呼ぶ。

    APIキーはクエリ文字列でも送れるが、**ヘッダー(Backlog-API-Key)で送る**。
    URLに入れるとシェルの履歴・プロキシのログ・エラーメッセージに残るため。
    """
    space, api_key = load_config()
    url = f"https://{space}{path if path.startswith('/') else '/' + path}"
    if query:
        # 同じ名前を繰り返す形(statusId[]=1&statusId[]=2)があるため doseq を使う
        url += "?" + urllib.parse.urlencode(query, doseq=True)

    headers = {"Backlog-API-Key": api_key, "User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if files:
        data, content_type = build_multipart(form or {}, files)
        headers["Content-Type"] = content_type
    elif form is not None:
        data = urllib.parse.urlencode(form, doseq=True).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            payload = res.read()
            if raw:
                return payload, res.headers
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as err:
        raise BacklogError(describe_http_error(err, method, path)) from None
    except urllib.error.URLError as err:
        raise BacklogError(f"接続できません: https://{space} ({err.reason})") from None


def describe_http_error(err, method, path):
    """Backlogのエラー応答({"errors":[{"message":...}]})を読める形にする。キーは出さない"""
    text = err.read().decode("utf-8", "replace")
    try:
        detail = json.loads(text)
    except ValueError:
        detail = {"message": text[:500]}
    messages = []
    for item in (detail.get("errors") or []):
        if isinstance(item, dict) and item.get("message"):
            messages.append(item["message"])
    summary = {"status": err.code, "method": method, "path": path}
    if messages:
        summary["errors"] = messages
    elif detail:
        summary["detail"] = detail
    if err.code == 401:
        summary["hint"] = "APIキーが違うか失効しています。Backlogの「個人設定 > API」で確認してください"
    elif err.code == 403:
        summary["hint"] = "このAPIキーの権限では行えない操作です"
    elif err.code == 404:
        summary["hint"] = "プロジェクトキー・課題キー・IDを確認してください"
    elif err.code == 429:
        summary["hint"] = "Backlog側の回数制限に当たりました。少し待ってからやり直してください"
    return json.dumps(summary, ensure_ascii=False)


def build_multipart(fields, files):
    """files: [(name, path)]。Backlogの添付は name="file" の1ファイル/1リクエスト"""
    boundary = f"----backlogclient{uuid.uuid4().hex}"
    chunks = []
    for name, value in fields.items():
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
        )
    for name, path in files:
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


# ---------------------------------------------------------------- 名前 → ID

def pick_by_name(items, wanted, label):
    """
    一覧から名前(またはID)で1件選ぶ。

    IDで指定されたらそのまま通す。名前が複数当たったら**選ばずに止める**。
    勝手に片方を選ぶと、別の課題を書き換えてしまう
    """
    text = str(wanted).strip()
    if text.isdigit():
        return int(text)
    matched = [item for item in items if str(item.get("name", "")) == text]
    if not matched:
        names = " / ".join(str(item.get("name")) for item in items)
        raise BacklogError(f"{label}に「{text}」がありません。指定できるのは: {names}")
    if len(matched) > 1:
        raise BacklogError(f"{label}の「{text}」が複数あります。IDで指定してください")
    return matched[0]["id"]


def resolve_user(project_key, wanted):
    text = str(wanted).strip()
    if text.isdigit():
        return int(text)
    users = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}/users")
    for item in users:
        if text in (item.get("name"), item.get("userId"), item.get("mailAddress")):
            return item["id"]
    raise BacklogError(f"プロジェクト {project_key} に「{text}」という参加者がいません")


def project_of_issue(issue_key):
    """課題キー(PROJ-123)からプロジェクトキーを取り出す"""
    text = str(issue_key).strip()
    if "-" not in text:
        raise BacklogError(f"課題キーの形ではありません: {text!r}(例: PROJ-123)")
    return text.rsplit("-", 1)[0]


def upload_attachments(paths):
    """
    ファイルを先に送って添付IDの一覧を得る。

    Backlogの添付は2段構え(ここで送る → 課題やコメントにIDで紐づける)。
    **紐づけないまま1時間経つとファイルは消える**ので、送ったら必ず続けて紐づけること。
    """
    ids = []
    for path in paths:
        if not os.path.isfile(path):
            raise BacklogError(f"ファイルがありません: {path}")
        result = request("POST", "/api/v2/space/attachment", files=[("file", path)])
        ids.append(result["id"])
    return ids


# ---------------------------------------------------------------- コマンド

def cmd_config(args):
    space, api_key = load_config()
    return {
        "space": space,
        "apiKey": f"{api_key[:4]}…{api_key[-2:]}" if len(api_key) > 8 else "(短すぎます)",
        "configPath": CONFIG_PATH if os.path.exists(CONFIG_PATH) else None,
        "clientVersion": CLIENT_VERSION
    }


def cmd_myself(args):
    return request("GET", "/api/v2/users/myself")


def cmd_projects(args):
    return request("GET", "/api/v2/projects", query={"all": "true"} if args.all else None)


def cmd_project(args):
    return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.key, safe='')}")


def cmd_issues(args):
    query = {}
    project_key = args.project
    if project_key:
        project = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}")
        query["projectId[]"] = [project["id"]]
    if args.keyword:
        query["keyword"] = args.keyword
    if args.status:
        if not project_key:
            raise BacklogError("--status を使うときは --project も指定してください(状態はプロジェクトごとのため)")
        statuses = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}/statuses")
        query["statusId[]"] = [pick_by_name(statuses, args.status, "状態")]
    if args.type:
        if not project_key:
            raise BacklogError("--type を使うときは --project も指定してください(種別はプロジェクトごとのため)")
        types = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}/issueTypes")
        query["issueTypeId[]"] = [pick_by_name(types, args.type, "種別")]
    if args.assignee:
        if not project_key:
            raise BacklogError("--assignee を使うときは --project も指定してください")
        query["assigneeId[]"] = [resolve_user(project_key, args.assignee)]
    if args.category:
        categories = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}/categories")
        query["categoryId[]"] = [pick_by_name(categories, args.category, "カテゴリー")]
    if args.milestone:
        versions = request("GET", f"/api/v2/projects/{urllib.parse.quote(project_key, safe='')}/versions")
        query["milestoneId[]"] = [pick_by_name(versions, args.milestone, "マイルストーン")]
    if args.created_since:
        query["createdSince"] = args.created_since
    if args.count:
        query["count"] = args.count
    if args.order:
        query["order"] = args.order
    if args.sort:
        query["sort"] = args.sort
    return request("GET", "/api/v2/issues", query=query or None)


def cmd_issue(args):
    return request("GET", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}")


def cmd_issue_create(args):
    project_key = args.project
    quoted = urllib.parse.quote(project_key, safe='')
    project = request("GET", f"/api/v2/projects/{quoted}")
    types = request("GET", f"/api/v2/projects/{quoted}/issueTypes")

    form = {
        "projectId": project["id"],
        "summary": args.summary,
        "issueTypeId": pick_by_name(types, args.type, "種別")
    }
    priorities = request("GET", "/api/v2/priorities")
    # 優先度は必須。指定が無ければ「中」に相当するものを選ぶ(Backlogの既定と同じ考え方)
    form["priorityId"] = pick_by_name(priorities, args.priority, "優先度") if args.priority \
        else next((p["id"] for p in priorities if p.get("name") == "中"), priorities[len(priorities) // 2]["id"])

    if args.description:
        form["description"] = args.description
    if args.assignee:
        form["assigneeId"] = resolve_user(project_key, args.assignee)
    if args.due_date:
        form["dueDate"] = args.due_date
    if args.category:
        categories = request("GET", f"/api/v2/projects/{quoted}/categories")
        form["categoryId[]"] = [pick_by_name(categories, args.category, "カテゴリー")]
    if args.milestone:
        versions = request("GET", f"/api/v2/projects/{quoted}/versions")
        form["milestoneId[]"] = [pick_by_name(versions, args.milestone, "マイルストーン")]
    if args.parent:
        parent = request("GET", f"/api/v2/issues/{urllib.parse.quote(args.parent, safe='')}")
        form["parentIssueId"] = parent["id"]
    if args.attach:
        form["attachmentId[]"] = upload_attachments(args.attach)
    return request("POST", "/api/v2/issues", form=form)


def cmd_issue_update(args):
    project_key = project_of_issue(args.key)
    quoted_project = urllib.parse.quote(project_key, safe='')
    form = {}
    if args.summary:
        form["summary"] = args.summary
    if args.description is not None:
        form["description"] = args.description
    if args.status:
        statuses = request("GET", f"/api/v2/projects/{quoted_project}/statuses")
        form["statusId"] = pick_by_name(statuses, args.status, "状態")
    if args.assignee:
        form["assigneeId"] = resolve_user(project_key, args.assignee)
    if args.priority:
        form["priorityId"] = pick_by_name(request("GET", "/api/v2/priorities"), args.priority, "優先度")
    if args.due_date:
        form["dueDate"] = args.due_date
    if args.comment:
        form["comment"] = args.comment
    if args.attach:
        form["attachmentId[]"] = upload_attachments(args.attach)
    if not form:
        raise BacklogError("変更する内容がありません(--summary / --status / --comment / --attach など を指定してください)")
    return request("PATCH", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}", form=form)


def cmd_issue_delete(args):
    return request("DELETE", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}")


def cmd_comments(args):
    query = {}
    if args.count:
        query["count"] = args.count
    if args.order:
        query["order"] = args.order
    return request("GET", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}/comments", query=query or None)


def cmd_comment_add(args):
    form = {"content": args.content}
    if args.attach:
        form["attachmentId[]"] = upload_attachments(args.attach)
    return request("POST", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}/comments", form=form)


def cmd_attach(args):
    return [{"path": path, "id": attachment_id}
            for path, attachment_id in zip(args.files, upload_attachments(args.files))]


def cmd_attachments(args):
    return request("GET", f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}/attachments")


def safe_local_filename(name):
    """
    受け取ったファイル名を、そのまま保存先に使わないための正規化。
    名前を決めるのは添付した人であって、こちらではない。区切り文字が混じると
    書き込み先を作業場所の外へ持ち出せてしまう(Windowsでは \\ も区切り)
    """
    text = str(name or "")
    text = text.replace("\\", "/").split("/")[-1]
    text = text.strip().strip(".")
    text = re.sub(r'[\x00-\x1f\x7f:*?"<>|]', "_", text)
    return text or "attachment"


def cmd_attachment_download(args):
    path = f"/api/v2/issues/{urllib.parse.quote(args.key, safe='')}/attachments/{urllib.parse.quote(str(args.attachment_id), safe='')}"
    payload, headers = request("GET", path, raw=True)
    name = None
    disposition = headers.get("Content-Disposition") or ""
    matched = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", disposition)
    if matched:
        name = urllib.parse.unquote(matched.group(1))
    target = args.output or safe_local_filename(name or f"attachment-{args.attachment_id}")
    with open(target, "wb") as f:
        f.write(payload)
    return {"savedTo": os.path.abspath(target), "bytes": len(payload)}


def cmd_statuses(args):
    return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.project, safe='')}/statuses")


def cmd_issue_types(args):
    return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.project, safe='')}/issueTypes")


def cmd_categories(args):
    return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.project, safe='')}/categories")


def cmd_milestones(args):
    return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.project, safe='')}/versions")


def cmd_priorities(args):
    return request("GET", "/api/v2/priorities")


def cmd_users(args):
    if args.project:
        return request("GET", f"/api/v2/projects/{urllib.parse.quote(args.project, safe='')}/users")
    return request("GET", "/api/v2/users")


def parse_pairs(values, label):
    pairs = {}
    for item in values or []:
        if "=" not in item:
            raise BacklogError(f"{label} は キー=値 の形で指定してください: {item!r}")
        key, value = item.split("=", 1)
        pairs.setdefault(key, [])
        pairs[key].append(value)
    # 1つだけのものは素の値にする(配列にすると受け取らないAPIがあるため)
    return {key: (values[0] if len(values) == 1 else values) for key, values in pairs.items()}


def cmd_raw(args):
    """同梱していないAPIを直接呼ぶための逃げ道。Backlogのドキュメントのパスをそのまま渡す"""
    method = args.method.upper()
    path = args.path if args.path.startswith("/") else "/" + args.path
    body = json.loads(args.body) if args.body else None
    form = parse_pairs(args.form, "--form") if args.form else None
    files = [("file", p) for p in (args.file or [])]
    return request(method, path,
                   query=parse_pairs(args.query, "--query") if args.query else None,
                   body=body, form=form, files=files or None)


# ---------------------------------------------------------------- 入口

def main():
    parser = argparse.ArgumentParser(
        prog="backlog_client.py",
        description="Backlog の API クライアント(課題・コメント・添付)",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("-V", "--version", action="version", version=f"backlog_client.py {CLIENT_VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("config", help="接続先の確認(キーは伏せて表示)").set_defaults(func=cmd_config)
    sub.add_parser("myself", help="自分の情報(疎通確認にも使える)").set_defaults(func=cmd_myself)

    p = sub.add_parser("projects", help="プロジェクトの一覧")
    p.add_argument("--all", action="store_true", help="参加していないものも含めて全件(管理者向け)")
    p.set_defaults(func=cmd_projects)

    p = sub.add_parser("project", help="プロジェクト1件")
    p.add_argument("key", help="プロジェクトキー(例: PROJ)")
    p.set_defaults(func=cmd_project)

    p = sub.add_parser("issues", help="課題の検索")
    p.add_argument("--project", help="プロジェクトキー")
    p.add_argument("--keyword", help="キーワード")
    p.add_argument("--status", help="状態(名前またはID。--project が要る)")
    p.add_argument("--type", help="種別(名前またはID。--project が要る)")
    p.add_argument("--assignee", help="担当者(名前・ユーザーID・メール またはID。--project が要る)")
    p.add_argument("--category", help="カテゴリー(名前またはID)")
    p.add_argument("--milestone", help="マイルストーン(名前またはID)")
    p.add_argument("--created-since", dest="created_since", help="この日以降に作られたもの(YYYY-MM-DD)")
    p.add_argument("--count", type=int, help="件数(既定20・最大100)")
    p.add_argument("--order", choices=["asc", "desc"], help="並び順")
    p.add_argument("--sort", help="並べ替えの項目(created / updated / dueDate 等)")
    p.set_defaults(func=cmd_issues)

    p = sub.add_parser("issue", help="課題1件")
    p.add_argument("key", help="課題キー(例: PROJ-123)")
    p.set_defaults(func=cmd_issue)

    p = sub.add_parser("issue-create", help="課題の作成(--attach でファイルも一緒に添付できる)")
    p.add_argument("--project", required=True, help="プロジェクトキー")
    p.add_argument("--summary", required=True, help="件名")
    p.add_argument("--type", required=True, help="種別(名前またはID)")
    p.add_argument("--priority", help="優先度(名前またはID。既定は「中」)")
    p.add_argument("--description", help="本文")
    p.add_argument("--assignee", help="担当者")
    p.add_argument("--due-date", dest="due_date", help="期限日(YYYY-MM-DD)")
    p.add_argument("--category", help="カテゴリー")
    p.add_argument("--milestone", help="マイルストーン")
    p.add_argument("--parent", help="親課題のキー(子課題として作る)")
    p.add_argument("--attach", nargs="+", help="添付するファイル(複数可)")
    p.set_defaults(func=cmd_issue_create)

    p = sub.add_parser("issue-update", help="課題の更新(--attach でファイルも一緒に添付できる)")
    p.add_argument("key", help="課題キー")
    p.add_argument("--summary", help="件名")
    p.add_argument("--description", help="本文(全文置き換え)")
    p.add_argument("--status", help="状態(名前またはID)")
    p.add_argument("--assignee", help="担当者")
    p.add_argument("--priority", help="優先度")
    p.add_argument("--due-date", dest="due_date", help="期限日(YYYY-MM-DD)")
    p.add_argument("--comment", help="変更と一緒に残すコメント")
    p.add_argument("--attach", nargs="+", help="添付するファイル(複数可)")
    p.set_defaults(func=cmd_issue_update)

    p = sub.add_parser("issue-delete", help="課題の削除(元に戻せない)")
    p.add_argument("key", help="課題キー")
    p.set_defaults(func=cmd_issue_delete)

    p = sub.add_parser("comments", help="課題のコメント一覧")
    p.add_argument("key", help="課題キー")
    p.add_argument("--count", type=int, help="件数(既定20・最大100)")
    p.add_argument("--order", choices=["asc", "desc"], help="並び順")
    p.set_defaults(func=cmd_comments)

    p = sub.add_parser("comment-add", help="コメントの追加(--attach でファイルも一緒に添付できる)")
    p.add_argument("key", help="課題キー")
    p.add_argument("content", help="本文")
    p.add_argument("--attach", nargs="+", help="添付するファイル(複数可)")
    p.set_defaults(func=cmd_comment_add)

    p = sub.add_parser("attach", help="添付だけ先に送ってIDを得る(1時間以内に紐づけること)")
    p.add_argument("files", nargs="+", help="送るファイル")
    p.set_defaults(func=cmd_attach)

    p = sub.add_parser("attachments", help="課題に付いている添付の一覧")
    p.add_argument("key", help="課題キー")
    p.set_defaults(func=cmd_attachments)

    p = sub.add_parser("attachment-download", help="添付のダウンロード")
    p.add_argument("key", help="課題キー")
    p.add_argument("attachment_id", help="添付ID(attachments で調べる)")
    p.add_argument("-o", "--output", help="保存先(省略すると元のファイル名)")
    p.set_defaults(func=cmd_attachment_download)

    for name, func, help_text in [
        ("statuses", cmd_statuses, "状態の一覧"),
        ("issue-types", cmd_issue_types, "種別の一覧"),
        ("categories", cmd_categories, "カテゴリーの一覧"),
        ("milestones", cmd_milestones, "マイルストーンの一覧")
    ]:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--project", required=True, help="プロジェクトキー")
        p.set_defaults(func=func)

    sub.add_parser("priorities", help="優先度の一覧(スペース共通)").set_defaults(func=cmd_priorities)

    p = sub.add_parser("users", help="ユーザーの一覧")
    p.add_argument("--project", help="プロジェクトキー(省略するとスペース全体)")
    p.set_defaults(func=cmd_users)

    p = sub.add_parser("raw", help="同梱していないAPIを直接呼ぶ")
    p.add_argument("method", help="GET / POST / PATCH / PUT / DELETE")
    p.add_argument("path", help="APIのパス(例: /api/v2/wikis)")
    p.add_argument("--query", action="append", help="クエリ(キー=値。繰り返し可)")
    p.add_argument("--form", action="append", help="フォーム(キー=値。繰り返し可)")
    p.add_argument("--body", help="JSONの本文")
    p.add_argument("--file", action="append", help="送るファイル(name=file で送る)")
    p.set_defaults(func=cmd_raw)

    # Windows(cp932等)のコンソールでも日本語のJSON・エラーメッセージが化けないようUTF-8で出す
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = parser.parse_args()
    try:
        result = args.func(args)
    except BacklogError as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
