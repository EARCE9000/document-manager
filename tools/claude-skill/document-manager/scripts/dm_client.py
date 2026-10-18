#!/usr/bin/env python3
"""
dm_client.py : Document Manager の API クライアント(Python 3.8+ / 標準ライブラリのみ)

AIエージェント(Claude Code / Codex / Antigravity)の Skill から呼び出す想定のコマンドラインツール。結果は JSON で標準出力へ出す。

接続情報(いずれか。上から優先):
  1. 環境変数 DM_BASE_URL / DM_API_KEY
  2. 設定ファイル ~/.document-manager.json  {"baseUrl": "https://.../", "apiKey": "dm_..."}
     (環境変数 DM_CONFIG で別パスを指定可)

使い方:
  python dm_client.py setup --edit [--base-url URL]   設定ファイルをメモ帳などで開く(無ければひな形を作る)
  python dm_client.py setup [--base-url URL]           利用者が自分の端末で、接続先とAPIキーを入力して保存する
                                       (どちらも、APIキーをAIエージェントとのチャットに貼らずに済ませるためのもの)
  python dm_client.py config                       接続先の確認(キーは伏せて表示)
  python dm_client.py search [検索語] [--archived] 一覧・全文検索(--archivedでアーカイブ済みを対象にする)
  python dm_client.py search <検索語> --semantic [--limit N]   意味検索(言い換え・表記ゆれを含む)
  python dm_client.py get <文書ID>                 文書1件の情報(アーカイブ済みも可)
  python dm_client.py versions <文書ID>            版履歴(古い順)
  python dm_client.py upload <ファイル> [--previous-id ID | --replace-same-name]
                                       [--preview 画像(.drawioの代替表示用。通常は不要)] [--tags タグ1,タグ2]
                                       [--project プロジェクト] [--folder フォルダ]
  python dm_client.py download <文書ID> [-o 保存先] [--render | --pdf]
                                       --render で「体裁つき」のPDFを取得する(Office文書のみ)
                                       --pdf で、プレビューの見た目のままPDFにする(HTML・Markdown・MHTML・draw.ioのみ。draw.ioは図の1ページが1ページ)
  python dm_client.py tags <文書ID> [--add A,B | --remove A,B | --set A,B]   タグの確認・変更
  python dm_client.py memo <文書ID> <メモ本文>     メモの更新(全文置き換え)
  python dm_client.py share-url <文書ID>           人に渡す共有リンク(版が変わっても同じURL)
  python dm_client.py alias <文書ID>               その文書のAlias(無ければ発行する)
  python dm_client.py alias-move <Alias> <文書ID>  Aliasの指す先を変える(古い版へ戻すとき)
  python dm_client.py archive <文書ID>             アーカイブ(論理削除。restoreで戻せる)
  python dm_client.py restore <文書ID>             アーカイブから元に戻す
  python dm_client.py links <文書ID>               関連文書の一覧
  python dm_client.py link <文書ID> <相手の文書ID> 関連文書として紐づける(対等な紐付け)
  python dm_client.py unlink <文書ID> <相手の文書ID>
  python dm_client.py link-previous <新版ID> <旧版ID>   後から旧版として紐づける(旧版はアーカイブされる)
  python dm_client.py unlink-previous <文書ID>     版の紐付けを解除する
  python dm_client.py projects [--archived]        プロジェクト一覧
  python dm_client.py project-url <プロジェクト>   人に渡す、プロジェクトを開くリンク
  python dm_client.py miro [書き出しのID]         Miro への書き出しの履歴(ID を渡すと、その 1 回の資料ごとの結果)
  python dm_client.py miro-anchors                ボードの目印(付箋の [DM]名前)の一覧(向き・メモ・リンク)
  python dm_client.py miro-anchor-add <名前> [--direction 右] [--note メモ]   目印の付箋をボードの空いている所に置く
  python dm_client.py miro-export [文書ID...] [--project <P>] (--anchor <目印の名前> | --anchor-url <付箋のリンク> | --free)
      [--direction 右|左|上|下|右上|右下|左上|左下|十字] [--title <タイトル>] [--groups <JSONファイル|->] [--no-wait]
                                                  資料を Miro に書き出す(毎回新しいフレーム。--free は利用者に確かめてから)
  python dm_client.py miro-map [--export <ID>]   書き出したフレームの地図(資料の位置・人が足したもの・空いている所)
  python dm_client.py miro-move <文書ID> (--next-to <文書ID> [--side right|left|above|below] | [--frame <F>] --x N --y N) [--export <ID>]
  python dm_client.py miro-layout <JSONファイル|-> [--export <ID>]   書き出したフレームに、位置・色・見出し・図形をまとめて当てる
                                                  (--export を省くと、自分の最後の書き出し)
  python dm_client.py miro-layout-report [文書ID...] [--project <P>]   十字で書き出したらどうなるか(タグの見直し用。Miro は変えない)
    レイアウト: folder-columns(フォルダ列) / timeline(時系列) / split-shelves(左右分割・棚) / quadrant-cross(十字) / matrix(マトリクス) / custom(ユーザーカスタム)
  python dm_client.py project-create <名前> [--description 説明]   プロジェクトの作成
  python dm_client.py project-update <プロジェクト> [--name 名前] [--description 説明]   名前・説明の変更(説明は "" で消す)
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
import re
import shlex
import socket
import subprocess
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
CLIENT_VERSION = "1.12.0"
USER_AGENT = f"document-manager-skill/{CLIENT_VERSION} (python {sys.version_info.major}.{sys.version_info.minor})"


class DmError(Exception):
    pass


# サーバーが「より新しいクライアントがある」と知らせてきたら、1度だけ標準エラーへ出す。
# AIエージェントはこの文面を読み、利用者へ更新を促せる
_update_notified = False


# サーバーが更新されたことを知らせてきたら、1度だけ標準エラーへ出す。
# サーバー側はAPIキーごとに1回しか送らないため、こちらで回数を絞る必要はないが、
# 1プロセス内で何度も出すと邪魔なので1回にする
_server_update_notified = False


def notify_if_server_updated(headers):
    global _server_update_notified
    build = headers.get("X-Server-Updated") if headers else None
    # サーバーが名乗った値をそのまま文面に入れるため、形を検査する(日時のタグを想定)
    if build is not None and not re.fullmatch(r"[0-9A-Za-z._-]{1,40}", str(build)):
        build = None
    if not build or _server_update_notified:
        return
    _server_update_notified = True
    print(
        f"[サーバー更新のお知らせ] Document Managerが更新されました(build {build})。\n"
        f"  手元の手順書(SKILL.md)や以前取得したAPI仕様は古い可能性があります。"
        f"対応ファイル形式やAPIが増えていることがあるため、"
        f"`spec` コマンドで最新の利用ガイドを取り直してから作業してください。",
        file=sys.stderr
    )


def notify_if_outdated(headers, base_url):
    global _update_notified
    latest = headers.get("X-Skill-Latest-Version") if headers else None
    # この値はサーバが名乗ったもので、そのまま自分の文面(AIが「ツールの言葉」として読む文)に
    # 埋め込む。接続先が正規でない場合(設定ミス・DNSの乗っ取り・平文通信)に任意の文章を
    # 混ぜ込まれないよう、数字3組だけを受け付ける。サーバ側でも同じ検査をしている
    if latest is not None and not re.fullmatch(r"\d+\.\d+\.\d+", str(latest)):
        latest = None
    if not latest or _update_notified or latest == CLIENT_VERSION:
        return
    _update_notified = True
    print(
        f"[更新のお知らせ] このDocument Manager用クライアントは {CLIENT_VERSION} ですが、"
        f"サーバーには {latest} があります。\n"
        f"  更新方法: {base_url}api/claude-skill.zip を取得し、"
        f"いま使っている document-manager フォルダを中身ごと置き換えてください"
        f"(画面右上の「APIキー管理」→「AIエージェント用 Skill」からも取得できます)。\n"
        f"  この作業は利用者の環境で行う必要があります。ユーザーに伝えてください。",
        file=sys.stderr
    )


# サーバから受け取ったファイル名を、そのままローカルの保存先に使わないための正規化。
# 名前を決めるのはアップロードした人であって、こちらではない。パス区切り(/ \\)が
# 混じっていると、書き込み先を作業場所の外へ持ち出せてしまう(Windowsでは \\ も区切り)。
# サーバ側でも入口で拒否しているが、古いサーバや正規でない接続先が相手でも
# 破られないよう、書き込む直前にもう一度絞る
def safe_local_filename(name):
    name = str(name or "")
    # 両方の区切り文字で切って最後の要素だけを採る(どちらのOSでも同じ結果にする)
    name = name.replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch >= " " and ch != "\x7f")
    name = name.strip().strip(".")
    return name or "download"


def load_config():
    base_url = os.environ.get("DM_BASE_URL")
    api_key = os.environ.get("DM_API_KEY")
    if not base_url or not api_key:
        data = read_config_file()
        base_url = base_url or data.get("baseUrl")
        api_key = api_key or data.get("apiKey")
    if is_placeholder(base_url) or is_placeholder(api_key):
        raise DmError(
            "接続情報がまだ設定されていません。setup --edit で設定ファイルを開き、利用者に接続先URLとAPIキーを"
            f"書き込んで保存してもらってください({CONFIG_PATH})。APIキーをチャットで受け取ってはいけません"
        )
    # BASE_PATH配下(例: https://host/docs/)でも相対パスで正しく結合できるよう末尾を / に揃える
    if not base_url.endswith("/"):
        base_url += "/"
    return base_url, api_key


# ---------------------------------------------------------------- 接続情報の登録(setup)
# **APIキーはAIエージェントとのチャットに貼らない。** チャットに貼ると、会話の記録やログなど、
# 利用者の手を離れた場所に残る。キーは利用者が自分で、次のどちらかで保存する。
#   setup --edit : 設定ファイル(無ければひな形を作る)をメモ帳などで開く。貼り付けて保存するだけ。
#                  開くところまでをコマンドが行うので、AIエージェントが実行してよい(キーはAIを通らない)
#   setup        : 利用者が自分の端末で実行し、表示されない入力欄に貼り付ける。接続を確かめてから保存する
# 「設定ファイルの場所を探して開く」のが面倒、という声から、開くところまでをコマンドに持たせている。

API_KEY_PLACEHOLDER = "ここにAPIキーを貼り付けてください"


def is_placeholder(value):
    """未設定(空、またはひな形のまま)か"""
    return not value or API_KEY_PLACEHOLDER in str(value) or "ここに" in str(value)


def read_config_file():
    if not os.path.exists(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, encoding="utf-8-sig") as f:
            data = json.load(f)
    except ValueError:
        raise DmError(
            f"{CONFIG_PATH} の書き方が正しくありません(JSONとして読めません)。"
            "setup --edit で開いて直してください。引用符(\")やカンマが消えていないかを確かめること"
        ) from None
    return data if isinstance(data, dict) else {}


def write_config_file(data):
    """設定ファイルを書く。キーを含むので、本人以外が読めないようにする(Windowsでは何もしない)"""
    directory = os.path.dirname(os.path.abspath(CONFIG_PATH))
    os.makedirs(directory, exist_ok=True)
    temp_path = CONFIG_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    try:
        os.chmod(temp_path, 0o600)
    except OSError:
        pass
    os.replace(temp_path, CONFIG_PATH)


def open_in_editor(path):
    """
    ファイルをエディタで開く。既定は、Windowsはメモ帳、macOSはテキストエディット、Linuxは既定のアプリ。
    開いたら待たずに戻る(AIエージェントから実行しても止まらないように)。
    環境変数 DM_EDITOR を指定した場合はそのコマンドで開き、閉じるまで待つ。
    """
    custom = os.environ.get("DM_EDITOR")
    try:
        if custom:
            completed = subprocess.run(shlex.split(custom, posix=os.name != "nt") + [path], check=False)
            return custom if completed.returncode == 0 else None
        if sys.platform.startswith("win"):
            command = ["notepad.exe", path]
        elif sys.platform == "darwin":
            command = ["open", "-t", path]
        else:
            command = ["xdg-open", path]
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return command[0]
    except OSError:
        return None


def is_interactive():
    """
    利用者が端末の前にいて、キーを打てるか。AIエージェントから実行されたときは入力待ちで止まらないよう、
    ここで見分けて断る。Windowsでは入力が「何もない(NUL)」場合も isatty() が真になるため、
    本物のコンソールかどうかまで確かめる
    """
    if not (sys.stdin.isatty() and sys.stderr.isatty()):
        return False
    if os.name == "nt":
        try:
            import ctypes
            import msvcrt
            mode = ctypes.c_uint32()
            return ctypes.windll.kernel32.GetConsoleMode(msvcrt.get_osfhandle(sys.stdin.fileno()), ctypes.byref(mode)) != 0
        except (OSError, AttributeError, ValueError):
            return False
    return True


def ask_visible(question, default=None):
    suffix = f" [{default}]" if default else ""
    sys.stderr.write(f"{question}{suffix}: ")
    sys.stderr.flush()
    answer = sys.stdin.readline().strip()
    return answer or default


def ask_secret(question):
    """
    APIキーを入力してもらう。打った・貼り付けた文字は出さず、1文字ごとに * を出す
    (後ろから覗かれる・画面共有に映る、を避けつつ、貼り付けが入ったことは分かるようにする)。
    標準の getpass は何も出さないため、貼り付けたのかどうかが分からないという声があった
    """
    sys.stderr.write(f"{question}: ")
    sys.stderr.flush()
    chars = []

    def echo(text):
        sys.stderr.write(text)
        sys.stderr.flush()

    def handle(ch):
        """1文字ぶんを処理する。入力が終わったら True"""
        if ch in ("\r", "\n", ""):
            return True
        if ch == "\x03":  # Ctrl+C
            echo("\n")
            raise KeyboardInterrupt
        if ch in ("\x08", "\x7f"):  # BackSpace
            if chars:
                chars.pop()
                echo("\b \b")
            return False
        if ch.isprintable():
            chars.append(ch)
            echo("*")
        return False

    if os.name == "nt":
        import msvcrt
        while True:
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):  # 矢印キーなどは2文字で届く。どちらも捨てる
                msvcrt.getwch()
                continue
            if handle(ch):
                break
    else:
        import termios
        import tty
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            while not handle(sys.stdin.read(1)):
                pass
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    echo("\n")
    return "".join(chars).strip()


BASE_URL_PLACEHOLDER = "ここに接続先のURLを書いてください(例: https://docs.example.com/)"


def setup_command(option, value):
    """
    利用者が実行して、APIキーを登録し直すためのコマンド。AIエージェントはこれをそのままコードブロックで示す。
    いま動いているPythonとこのファイルを絶対パスで指すので、どこで実行しても同じものが動く
    (Windowsでは python が Microsoft Store の案内に結び付いていることがあるため、名前では呼ばない)。
    Windowsは PowerShell の書き方にする(Claude Code のデスクトップアプリの端末は PowerShell)
    """
    script = os.path.abspath(__file__)
    if os.name == "nt":
        return f'& "{sys.executable}" "{script}" setup {option} {value}'
    return f'"{sys.executable}" "{script}" setup {option} {value}'


def clean_pasted_key(value):
    """
    貼り付けたキーの前後に付いてきがちなもの(空白・引用符・末尾のカンマ)を取り除く。
    設定ファイルやメモから行ごとコピーすると付いてくる
    """
    value = value.strip().rstrip(",").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


# Document Manager のキーは dm_ と、32バイトを base64url にした43文字(合わせて46文字)
API_KEY_PATTERN = re.compile(r"^dm_[A-Za-z0-9_-]{43}$")


def describe_key_shape(api_key):
    """キーの形が違うとき、キーそのものは出さずに、何が違うかだけを説明する"""
    if API_KEY_PATTERN.match(api_key):
        return None
    return (f"入力されたものが、Document Manager のAPIキーの形になっていません(保存していません)。"
            f"APIキーは dm_ で始まる46文字ですが、入力は {len(api_key)} 文字で、先頭が dm_ で"
            f"{'始まっています' if api_key.startswith('dm_') else '始まっていません'}。"
            "キー以外の文字まで一緒にコピーしていないかを確かめて、キーだけを貼り付け直してください")


def unauthorized_detail(base_url):
    """401(キーが期限切れ・失効・違う)のときに、エラーに添える次の手順"""
    return {
        "hint": ("APIキーが期限切れか、無効です。利用者に Document Manager の「APIキー管理」で新しいキーを発行してもらい、"
                 "setupCommand のコマンドを利用者が実行して登録し直してもらってください(コマンドをコードブロックで示す。"
                 "自分では実行しない。APIキーをチャットで受け取らない)。登録し直したら、同じ操作をやり直す"),
        "setupCommand": setup_command("--base-url", base_url)
    }


def cmd_setup(args):
    data = read_config_file()
    base_url = args.base_url or (None if is_placeholder(data.get("baseUrl")) else data.get("baseUrl")) or os.environ.get("DM_BASE_URL")

    if args.edit:
        created = not os.path.exists(CONFIG_PATH)
        changed = created
        if created:
            data = {}
        if base_url and data.get("baseUrl") != base_url:
            data["baseUrl"] = base_url
            changed = True
        if not data.get("baseUrl"):
            data["baseUrl"] = BASE_URL_PLACEHOLDER
            changed = True
        if not data.get("apiKey"):
            data["apiKey"] = API_KEY_PLACEHOLDER
            changed = True
        if changed:
            write_config_file(data)
        editor = open_in_editor(CONFIG_PATH)
        result = {"configPath": os.path.abspath(CONFIG_PATH), "created": created, "opened": editor is not None, "editor": editor}
        if editor is None:
            result["next"] = (f"エディタを自動で開けませんでした。{os.path.abspath(CONFIG_PATH)} をメモ帳などで開き、"
                              "apiKey の値を発行したAPIキーに書き換えて保存してもらってください")
        else:
            result["next"] = ("開いたファイルの apiKey の値(\"\" の中)を、発行したAPIキーに書き換えて保存してもらってください。"
                              "保存したら config と search で接続を確かめます。APIキーをチャットで受け取らないこと")
        return result

    # ここから先は、利用者が自分の端末で入力する。AIエージェントが実行すると入力待ちで止まるため、断る
    if not is_interactive():
        raise DmError(
            "setup は、利用者が自分の端末で実行するコマンドです(APIキーの入力欄が出ます)。AIエージェントは実行せず、"
            "利用者が実行できるよう、このコマンドをコードブロックで示してください(Claude Code のデスクトップアプリなら、"
            "実行ボタンから右側の端末で実行できます)。メモ帳で書き込んでもらう場合は setup --edit を使ってください。"
            "APIキーをチャットで受け取ってはいけません"
        )
    current_key = None if is_placeholder(data.get("apiKey")) else data.get("apiKey")
    if current_key:
        # 期限切れなどで発行し直したキーに入れ替える使い方。何が起きるかを先に見せる
        sys.stderr.write(f"いま登録されているキー({current_key[:6]}...)を、これから入力するキーに置き換えます。"
                         "接続を確かめてから保存し、繋がらなければ置き換えません(Enter だけなら中止)\n")
    base_url = ask_visible("接続先のURL", base_url)
    if not base_url:
        raise DmError("接続先のURLが入力されていません")
    api_key = clean_pasted_key(ask_secret("APIキー(貼り付けた文字は * で表示されます)"))
    if not api_key:
        raise DmError("APIキーが入力されていないため、中止しました(設定は変えていません)")
    shape_problem = describe_key_shape(api_key)
    if shape_problem:
        raise DmError(shape_problem)
    if not base_url.endswith("/"):
        base_url += "/"
    if not args.no_verify:
        # 入力した内容で実際に繋いでみる。繋がらないキーは保存しない(あとで分かりにくい失敗になるため)
        os.environ["DM_BASE_URL"] = base_url
        os.environ["DM_API_KEY"] = api_key
        try:
            request("GET", "api/projects")
        except DmError as err:
            raise DmError(f"この内容では接続できませんでした(保存していません): {err}") from None
    data.update({"baseUrl": base_url, "apiKey": api_key})
    write_config_file(data)
    return {"configPath": os.path.abspath(CONFIG_PATH), "baseUrl": base_url, "apiKey": api_key[:6] + "...", "verified": not args.no_verify}


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
            notify_if_outdated(res.headers, base_url)
            notify_if_server_updated(res.headers)
            if raw:
                return payload, res.headers
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as err:
        notify_if_outdated(err.headers, base_url)
        notify_if_server_updated(err.headers)
        text = err.read().decode("utf-8", "replace")
        try:
            detail = json.loads(text)
        except ValueError:
            detail = {"error": text}
        if err.code == 401:
            detail.update(unauthorized_detail(base_url))
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


# download --pdf でPDFにできる文書(元ファイルの拡張子)。サーバー側(lib/html-pdf.js)と揃える
PDF_SOURCE_EXTENSIONS = (".html", ".htm", ".md", ".markdown", ".mhtml", ".mht", ".drawio")
# download --render の対象(Office文書)。取り違えたときに、正しいほうを案内するために持つ
OFFICE_EXTENSIONS = (".xlsx", ".docx", ".pptx", ".xlsm", ".docm", ".pptm")


def cmd_download(args):
    doc = cmd_get(args)
    extension = os.path.splitext(doc.get("entryFile") or "")[1].lower()
    blocked = None
    if args.render and args.pdf:
        raise DmError("--render と --pdf は同時に指定できません(--render はOffice文書、--pdf はHTML・Markdown・MHTML・draw.io)")
    # --render はOffice文書を元の体裁のまま見るためのPDF(サーバー側で変換済みのもの)
    if args.render:
        if doc.get("renderStatus") != "ok":
            hint = "対象はExcel/Word/PowerPoint。変換中(pending)なら少し待つ。failedなら管理者に再実行を依頼する"
            if extension in PDF_SOURCE_EXTENSIONS:
                hint = "HTML・Markdown・MHTML・draw.ioの文書は --render ではなく --pdf でPDFにできる"
            raise DmError(json.dumps({
                "error": "体裁つきのPDFは用意されていません",
                "renderStatus": doc.get("renderStatus"),
                "hint": hint
            }, ensure_ascii=False))
        payload, _headers = request("GET", f"api/documents/{quote_id(args.id)}/file", query={"render": "1"}, raw=True)
        name = os.path.splitext(safe_local_filename(doc["entryFile"]))[0] + ".pdf"
    # --pdf はHTML・Markdown・MHTML・draw.ioを、プレビューの見た目のままPDF(draw.ioは図の1ページが1ページ)にする(その場で変換する)。
    # メール添付など、人に渡すための形
    elif args.pdf:
        if extension not in PDF_SOURCE_EXTENSIONS:
            hint = "PDFにできるのはHTML・Markdown・MHTML・draw.ioの文書だけ。それ以外は download で原本を取得する"
            if extension in OFFICE_EXTENSIONS:
                hint = "Office文書は --pdf ではなく --render で体裁つきのPDFを取得できる(get の renderStatus が ok のとき)"
            elif extension == ".pdf":
                hint = "この文書は元からPDF。download でそのまま取得する"
            raise DmError(json.dumps({
                "error": f"この形式はPDFにできません: {extension or '(拡張子なし)'}",
                "hint": hint
            }, ensure_ascii=False))
        payload, headers = request("GET", f"api/documents/{quote_id(args.id)}/pdf", raw=True)
        blocked = int(headers.get("X-Blocked-Requests") or 0)
        name = os.path.splitext(safe_local_filename(doc["entryFile"]))[0] + ".pdf"
    else:
        payload, _headers = request("GET", f"api/documents/{quote_id(args.id)}/file", query={"download": "1"}, raw=True)
        name = safe_local_filename(doc["entryFile"])
    out = args.output or name
    if os.path.isdir(out):
        out = os.path.join(out, name)
    with open(out, "wb") as f:
        f.write(payload)
    result = {"id": doc["id"], "entryFile": doc["entryFile"], "savedTo": os.path.abspath(out), "size": len(payload), "rendered": bool(args.render)}
    if args.pdf:
        result["pdf"] = True
        # 外部に置かれた画像などは読み込まないため、PDFでは抜ける。渡す前に利用者へ伝えられるようにする
        result["blockedRequests"] = blocked
        if blocked:
            result["warning"] = (
                f"この文書は外部に置かれた画像やスタイルを {blocked} 件参照しているが、PDFには入っていない"
                "(変換時に外部へ接続しないため)。人に渡す前に、PDFを開いて見た目を確かめるようユーザーに伝えること"
            )
    return result


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


def cmd_alias(args):
    """その文書のAlias。無ければ発行する(発行は冪等で、既にあればそれを返す)"""
    document = request("GET", f"api/documents/{quote_id(args.id)}")
    if document.get("alias"):
        return {"alias": document["alias"], "documentId": document["id"], "created": False}
    created = request("POST", f"api/documents/{quote_id(args.id)}/alias")
    return {**created, "created": True}


def cmd_share_url(args):
    """
    人に渡すURL。**版が変わっても同じURL**で、常に最新版が開く。

    文書IDのURL(api/documents/<文書ID>/viewer)はその版を指したままになるため、
    人へ渡すとあとで「古い版を見ていた」が起きる。こちらを使うこと。
    """
    base_url, _ = load_config()
    result = cmd_alias(args)
    return {
        "shareUrl": f"{base_url}api/documents/alias/{result['alias']}/viewer",
        "alias": result["alias"],
        "documentId": result["documentId"],
        "note": "版が変わっても同じURLで、常に最新版が開きます"
    }


def cmd_alias_move(args):
    return request("PUT", f"api/documents/alias/{quote_id(args.alias)}", body={"documentId": args.id})


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
    body = {"name": args.name}
    if args.description is not None:
        body["description"] = args.description
    return request("POST", "api/projects", body=body)


def cmd_project_update(args):
    """プロジェクトの名前・説明を変える。説明は Miro に十字で書き出すと目印の下の概要カードに出る("" で消す)"""
    body = {}
    if args.name is not None:
        body["name"] = args.name
    if args.description is not None:
        body["description"] = args.description
    if not body:
        raise DmError("--name か --description を指定してください")
    project_id = resolve_project(args.project)["id"]
    return request("PUT", f"api/projects/{quote_id(project_id)}", body=body)


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


# ---- モックアップ(ビルド済みのWebページ一式。文書とは別のコレクション) ----

def zip_site_directory(directory):
    """ディレクトリをZIPに固める。中身が直下に来るように詰める(index.htmlを入口にするため)"""
    import tempfile
    import zipfile

    entries = []
    for root, _dirs, files in os.walk(directory):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, directory).replace(os.sep, "/")
            entries.append((full, rel))
    if not entries:
        raise DmError(f"ファイルがありません: {directory}")
    if not any(rel == "index.html" for _full, rel in entries):
        # ここで止めないと、登録はできるのに開けないモックアップが出来上がる
        raise DmError(
            f"{directory} の直下に index.html がありません(これが表示の入口になります)。\n"
            f"含まれていたもの: {', '.join(sorted(rel for _f, rel in entries)[:10])}"
        )
    # ZIPのファイル名は表示名の既定値とダウンロード名に使われるので、一時ファイルの
    # 無意味な名前ではなくディレクトリ名を付ける
    name = os.path.basename(os.path.abspath(directory)) or "mockup"
    path = os.path.join(tempfile.mkdtemp(prefix="dm-mockup-"), f"{safe_local_filename(name)}.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for full, rel in sorted(entries, key=lambda e: e[1]):
            zf.write(full, rel)
    return path


def cmd_mockups(args):
    path = "api/mockups/archived" if args.archived else "api/mockups"
    return request("GET", path, query={"q": args.q} if args.q else None)


def cmd_mockup_get(args):
    return request("GET", f"api/mockups/{quote_id(args.id)}")


def cmd_mockup_versions(args):
    return request("GET", f"api/mockups/{quote_id(args.id)}/versions")


def cmd_mockup_upload(args):
    """ZIPでもディレクトリでも受け取る(AIが作るのはたいていディレクトリのため)"""
    temporary = None
    try:
        if os.path.isdir(args.path):
            temporary = zip_site_directory(args.path)
            zip_path = temporary
        elif os.path.isfile(args.path):
            zip_path = args.path
        else:
            raise DmError(f"ファイルもディレクトリもありません: {args.path}")

        fields = {}
        if args.name:
            fields["name"] = args.name
        if args.previous_id:
            fields["previousId"] = args.previous_id
        files = {"mockupfile": zip_path}
        if args.preview:
            files["previewfile"] = args.preview
        body, content_type = build_multipart(fields, files)
        created = request("POST", "api/mockups", body=body, content_type=content_type)
    finally:
        if temporary:
            import shutil
            shutil.rmtree(os.path.dirname(temporary), ignore_errors=True)
    # 登録しただけでは意味がないので、利用者に渡すURLを一緒に返す
    created["viewUrl"] = mockup_view_url(created["id"])
    return created


def mockup_view_url(mockup_id):
    base, _key = load_config()
    return f"{base}api/mockups/{quote_id(mockup_id)}/view"


def cmd_mockup_url(args):
    return {
        "id": args.id,
        "viewUrl": mockup_view_url(args.id),
        "note": "このURLを利用者に伝えて、ブラウザで開いてもらってください"
    }


def cmd_mockup_download(args):
    mockup = cmd_mockup_get(args)
    data, _headers = request("GET", f"api/mockups/{quote_id(args.id)}/download", raw=True)
    out = args.output or safe_local_filename(mockup.get("zipFile") or f"{args.id}.zip")
    with open(out, "wb") as f:
        f.write(data)
    return {"id": args.id, "savedTo": os.path.abspath(out), "bytes": len(data)}


def cmd_mockup_memo(args):
    return request("PUT", f"api/mockups/{quote_id(args.id)}/memo", body={"memo": args.text})


def cmd_mockup_rename(args):
    return request("PUT", f"api/mockups/{quote_id(args.id)}/name", body={"name": args.name})


def cmd_mockup_archive(args):
    request("DELETE", f"api/mockups/{quote_id(args.id)}")
    return {"id": args.id, "archived": True, "note": "完全削除ではありません。mockup-restore で元に戻せます"}


def cmd_mockup_restore(args):
    return request("POST", f"api/mockups/{quote_id(args.id)}/restore")


# ---- おしながき(プロジェクトの資料一覧＋説明書き) ----

def cmd_project_url(args):
    """
    人に渡す、プロジェクトを開くURL。開くとログイン後にそのプロジェクトのおしながきが表示される。
    資料1件を渡すなら share-url、資料の一覧を文面にして渡すなら manifest --markdown を使う。
    """
    base_url, _ = load_config()
    project = resolve_project(args.project)
    return {
        "projectUrl": f"{base_url}?project={urllib.parse.quote(project['id'], safe='')}",
        "projectId": project["id"],
        "name": project.get("name"),
        "note": "開くにはログインが必要です。開くと、このプロジェクトの資料一覧と説明書き(おしながき)が表示されます"
    }


def cmd_manifest(args):
    project_id = resolve_project(args.project)["id"]
    # 章だけを切り出す(案件全体ではなく「この章だけ渡したい」ことがある)
    query = None
    if getattr(args, "folder", None):
        folder_id = resolve_folder(project_id, args.folder)
        if not folder_id:
            raise DmError(f"フォルダが見つかりません: {args.folder}")
        query = {"folderId": folder_id}
    if args.markdown:
        # 各資料には開けるリンクが付く。URLを載せたくない文面では --no-links で外す
        if getattr(args, "no_links", False):
            query = {**(query or {}), "links": "0"}
        # 人に渡す文面なので、JSONで包まずそのまま出す(spec と同じ扱い)
        payload, _headers = request("GET", f"api/projects/{quote_id(project_id)}/manifest.md", query=query, raw=True)
        sys.stdout.write(payload.decode("utf-8", "replace"))
        return None
    return request("GET", f"api/projects/{quote_id(project_id)}/manifest", query=query)


# ---- Miro に資料を書き出す ----
# 連携とボードの設定は管理者が画面で行う。書き出しは頼まれたときだけ(自動では書き出さない)。
# 書き出すたびに、ボードの目印(付箋の [DM]名前)の向きに新しいフレームを作る。前に書き出したフレームには触らない

MIRO_WAIT_SECONDS = 600


def wait_export(export_id):
    """書き出しが終わる(state が running でなくなる)まで待って、記録を返す。資料が多いと数分かかる"""
    record = request("GET", f"api/miro/exports/{quote_id(export_id)}")
    deadline = time.time() + MIRO_WAIT_SECONDS
    while record.get("state") == "running" and time.time() < deadline:
        time.sleep(3)
        record = request("GET", f"api/miro/exports/{quote_id(export_id)}")
    return record


def summarize_export(record):
    """AI が利用者へ伝えやすい形に整える(フレームのリンクと、出せなかった資料の理由)"""
    result = {
        "exportId": record.get("id"),
        "state": record.get("state"),
        "project": record.get("project"),
        "anchor": record.get("anchor"),
        "frames": [{"title": f.get("title"), "direction": f.get("direction"), "url": f.get("url"), "frameId": f.get("frameId")} for f in record.get("frames") or []],
        "counts": record.get("counts"),
        "notPlaced": [{"documentId": d.get("documentId"), "title": d.get("title"), "state": d.get("state"), "reason": d.get("reason")}
                      for d in record.get("documents") or [] if d.get("state") != "placed"],
        "error": record.get("error"),
    }
    if record.get("state") == "running":
        result["note"] = "まだ書き出している途中です。しばらくしてから miro で確かめてください"
    return result


def cmd_miro(args):
    """書き出しの状態と履歴(新しい順。プロジェクト・目印・フレームの URL・件数)。ID を渡すと、その 1 回の資料ごとの結果"""
    if args.export_id:
        return request("GET", f"api/miro/exports/{quote_id(args.export_id)}")
    return request("GET", "api/miro/exports")


def cmd_miro_anchors(args):
    """ボードにある書き出しの目印(付箋の [DM]名前)。名前・向き・メモ(何を書き出すかの覚え書き)・リンク"""
    return request("GET", "api/miro/anchors")


def cmd_miro_anchor_add(args):
    """目印の付箋をボードの空いている所に置く(利用者が Miro で好きな場所へ動かす)"""
    body = {"name": args.name}
    if args.direction is not None:
        body["direction"] = args.direction
    if args.note is not None:
        body["note"] = args.note
    return request("POST", "api/miro/anchors", body=body)


def cmd_miro_export(args):
    """
    書き出す。場所は --anchor(目印の名前)・--anchor-url(付箋・図形のリンク)・--free(空いている所。利用者に確かめてから)のどれか。
    資料を省くときは --project(そのプロジェクトの資料を全部)。向きごとに分けるなら --groups に [{"documentIds": [...], "direction": "右", "title": "..."}] の JSON
    """
    body = {}
    if args.project is not None:
        body["project"] = resolve_project(args.project)["id"]
    if args.anchor is not None:
        body["anchor"] = args.anchor
    if args.anchor_url is not None:
        body["anchorUrl"] = args.anchor_url
    if args.free:
        body["free"] = True
    if args.direction is not None:
        body["direction"] = args.direction
    if args.title is not None:
        body["title"] = args.title
    if args.groups is not None:
        if args.ids:
            raise DmError("--groups を使うときは、文書IDは groups の中に書きます")
        try:
            if args.groups == "-":
                body["groups"] = json.load(sys.stdin)
            else:
                with open(args.groups, encoding="utf-8") as f:
                    body["groups"] = json.load(f)
        except (OSError, ValueError) as err:
            raise DmError(f"--groups の JSON を読めません: {err}") from None
    elif args.ids:
        body["documentIds"] = args.ids
    started = request("POST", "api/miro/exports", body=body)
    return summarize_export(started if args.no_wait else wait_export(started["id"]))


def cmd_miro_move(args):
    if args.next_to:
        body = {"nextTo": args.next_to, "side": args.side}
    elif args.x is not None and args.y is not None:
        body = {"x": args.x, "y": args.y}
        if args.frame is not None:
            body["frame"] = args.frame
    else:
        raise DmError("--next-to(と --side)か、--x と --y(と --frame)を指定してください")
    if args.export is not None:
        body["exportId"] = args.export
    return request("PATCH", f"api/miro/items/{quote_id(args.id)}", body=body)


def cmd_miro_layout(args):
    """
    書き出したフレーム(--export。省くと自分の最後の書き出し)に、レイアウト(資料の位置と色・見出しの文字・図形・フレームの大きさ)をまとめて当てる。
    JSON の形は spec の applyMiroLayout を参照。正しくないところがあれば何も動かさず、理由の一覧(details)が返る
    """
    try:
        if args.file == "-":
            layout = json.load(sys.stdin)
        else:
            with open(args.file, encoding="utf-8") as f:
                layout = json.load(f)
    except (OSError, ValueError) as err:
        raise DmError(f"レイアウトの JSON を読めません: {err}") from None
    if args.export is not None:
        layout["exportId"] = args.export
    return request("POST", "api/miro/layout", body=layout)


def cmd_miro_map(args):
    """書き出したフレームの地図(Miro から読むだけ)。位置はフレームごとに左上から。これで重ならない場所を決めてから miro-layout・miro-move で直す"""
    return request("GET", "api/miro/map", query={"exportId": args.export} if args.export else None)


def cmd_miro_layout_report(args):
    """十字で書き出したらどうなるか(未分類・推定・表に無い値)。Miro は変えない。タグの見直しに使う。文書IDか --project で指す"""
    query = {}
    if args.ids:
        query["documentIds"] = ",".join(args.ids)
    if args.project is not None:
        query["project"] = resolve_project(args.project)["id"]
    if not query:
        raise DmError("文書IDか --project を指定してください")
    return request("GET", "api/miro/layout-report", query=query)


def cmd_folder_reorder(args):
    """おしながきではフォルダがそのまま章の順番になるため、人に渡す前に整えるために使う"""
    project_id = resolve_project(args.project)["id"]
    parent_id = resolve_folder(project_id, args.parent) if args.parent else None
    folder_ids = []
    for value in split_list(args.folders):
        folder_id = resolve_folder(project_id, value)
        if not folder_id:
            raise DmError(f"フォルダが見つかりません: {value}")
        folder_ids.append(folder_id)
    return request("PUT", f"api/projects/{quote_id(project_id)}/folders/reorder",
                   body={"parentFolderId": parent_id, "folderIds": folder_ids})


def cmd_note(args):
    project_id = resolve_project(args.project)["id"]
    if args.folder:
        folder_id = resolve_folder(project_id, args.folder)
        if not folder_id:
            raise DmError(f"フォルダが見つかりません: {args.folder}")
        return request("PUT", f"api/projects/{quote_id(project_id)}/folders/{quote_id(folder_id)}/note",
                       body={"note": args.text})
    if not args.id:
        raise DmError("文書ID(--id)かフォルダID(--folder)のどちらかを指定してください")
    return request("PUT", f"api/projects/{quote_id(project_id)}/documents/{quote_id(args.id)}/note",
                   body={"note": args.text})


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
                detail = {"status": err.code, "error": err.read().decode("utf-8", "replace")}
                if err.code == 401:
                    detail.update(unauthorized_detail(load_config()[0]))
                raise DmError(json.dumps(detail, ensure_ascii=False)) from None
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
    p = sub.add_parser("setup", help="接続情報の登録(APIキーをチャットに貼らずに済ませる)")
    p.add_argument("--edit", action="store_true", help="設定ファイルをメモ帳などで開く(無ければひな形を作る)。AIエージェントから実行してよい")
    p.add_argument("--base-url", help="接続先のURL(ひな形に書き込む・入力の初期値にする)")
    p.add_argument("--no-verify", action="store_true", help="保存する前に接続を確かめない")
    p.set_defaults(func=cmd_setup)
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
    p.add_argument("--render", action="store_true", help="Office文書の体裁つきPDFを取得する(元ファイルの代わり)")
    p.add_argument("--pdf", action="store_true", help="HTML・Markdown・MHTML・draw.ioを、プレビューの見た目のままPDF(draw.ioは図の1ページが1ページ)にして取得する(元ファイルの代わり)")
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
    p = sub.add_parser("share-url", help="人に渡す共有リンク(版が変わっても同じURL)")
    p.add_argument("id", help="文書ID")
    p.set_defaults(func=cmd_share_url)
    p = sub.add_parser("alias", help="その文書のAlias(無ければ発行する)")
    p.add_argument("id", help="文書ID")
    p.set_defaults(func=cmd_alias)
    p = sub.add_parser("alias-move", help="Aliasの指す先を変える(古い版へ戻すとき)")
    p.add_argument("alias", help="Alias")
    p.add_argument("id", help="指す先にしたい文書ID")
    p.set_defaults(func=cmd_alias_move)
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
    p.add_argument("--description", help="説明(空でもよい。Miro に十字で書き出すと概要カードに出る)")
    p.set_defaults(func=cmd_project_create)
    p = sub.add_parser("project-update", help="プロジェクトの名前・説明の変更")
    p.add_argument("project", help="プロジェクトIDまたは名前")
    p.add_argument("--name", help="新しい名前")
    p.add_argument("--description", help="説明(\"\" で消す)")
    p.set_defaults(func=cmd_project_update)
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
    # ---- モックアップ ----
    p = sub.add_parser("mockups", help="モックアップの一覧・検索")
    p.add_argument("--q", help="名前・メモ・中のHTMLのテキストで検索")
    p.add_argument("--archived", action="store_true", help="置き換えられた旧版を見る(要 readwrite)")
    p.set_defaults(func=cmd_mockups)
    p = sub.add_parser("mockup-get", help="モックアップ1件の情報")
    p.add_argument("id")
    p.set_defaults(func=cmd_mockup_get)
    p = sub.add_parser("mockup-versions", help="モックアップの版履歴")
    p.add_argument("id")
    p.set_defaults(func=cmd_mockup_versions)
    p = sub.add_parser("mockup-upload", help="モックアップの登録(ZIPでもディレクトリでも可)")
    p.add_argument("path", help="一式のZIP、またはディレクトリ(直下に index.html が必要)")
    p.add_argument("--name", help="表示名(省略時はファイル名)")
    p.add_argument("--preview", help="一覧に出す画像(svg/png/jpg)")
    p.add_argument("--previous-id", dest="previous_id", help="置き換える旧版のID(旧版はアーカイブされる)")
    p.set_defaults(func=cmd_mockup_upload)
    p = sub.add_parser("mockup-url", help="利用者がブラウザで開くURLを出す")
    p.add_argument("id")
    p.set_defaults(func=cmd_mockup_url)
    p = sub.add_parser("mockup-download", help="原本のZIPをダウンロード")
    p.add_argument("id")
    p.add_argument("-o", "--output", help="保存先のパス")
    p.set_defaults(func=cmd_mockup_download)
    p = sub.add_parser("mockup-memo", help="モックアップのメモの更新(120文字まで。一覧のカードに出る)")
    p.add_argument("id")
    p.add_argument("text")
    p.set_defaults(func=cmd_mockup_memo)
    p = sub.add_parser("mockup-rename", help="モックアップの名前変更")
    p.add_argument("id")
    p.add_argument("name")
    p.set_defaults(func=cmd_mockup_rename)
    p = sub.add_parser("mockup-archive", help="モックアップのアーカイブ(restoreで戻せる)")
    p.add_argument("id")
    p.set_defaults(func=cmd_mockup_archive)
    p = sub.add_parser("mockup-restore", help="モックアップをアーカイブから戻す")
    p.add_argument("id")
    p.set_defaults(func=cmd_mockup_restore)

    # ---- おしながき ----
    p = sub.add_parser("manifest", help="プロジェクトのおしながき(資料一覧＋説明書き)")
    p.add_argument("project", help="プロジェクトIDまたは名前")
    p.add_argument("--markdown", action="store_true", help="人に渡せるMarkdownで出す(JSONで包まずそのまま出力)")
    p.add_argument("--folder", help="この章から下だけを出す(フォルダIDまたは名前)")
    p.add_argument("--no-links", action="store_true", help="--markdown のとき、各資料を開くリンクを付けない(名前と説明書きだけにする)")
    p.set_defaults(func=cmd_manifest, streaming_if="markdown")
    p = sub.add_parser("project-url", help="人に渡す、プロジェクトを開くリンク")
    p.add_argument("project", help="プロジェクトIDまたは名前")
    p.set_defaults(func=cmd_project_url)
    p = sub.add_parser("folder-reorder", help="フォルダの並び替え(おしながきの章の順番になる)")
    p.add_argument("project", help="プロジェクトIDまたは名前")
    p.add_argument("folders", help="並べたい順のフォルダ(カンマ区切り。IDでも名前でも可)")
    p.add_argument("--parent", help="対象の親フォルダ(省略時はプロジェクト直下)")
    p.set_defaults(func=cmd_folder_reorder)
    p = sub.add_parser("note", help="おしながきの説明書きを書く(空文字で消す)")
    p.add_argument("project", help="プロジェクトIDまたは名前")
    p.add_argument("text", help="説明(この案件での位置づけ)")
    p.add_argument("--id", help="対象の文書ID")
    p.add_argument("--folder", help="対象のフォルダID(章の前書き)")
    p.set_defaults(func=cmd_note)

    # ---- Miro ----
    p = sub.add_parser("miro", help="Miro への書き出しの履歴(プロジェクト・目印・フレームの URL・件数)")
    p.add_argument("export_id", nargs="?", help="書き出しの ID(渡すと、その 1 回の資料ごとの結果)")
    p.set_defaults(func=cmd_miro)
    p = sub.add_parser("miro-anchors", help="ボードの書き出しの目印(付箋の [DM]名前)の一覧(向き・メモ・リンク)")
    p.set_defaults(func=cmd_miro_anchors)
    p = sub.add_parser("miro-anchor-add", help="書き出しの目印の付箋をボードの空いている所に置く")
    p.add_argument("name", help="目印の名前(書き出したフレームの名前にもなる)")
    p.add_argument("--direction", help="向き(右・左・上・下・右上・右下・左上・左下・十字。省くと右)")
    p.add_argument("--note", help="メモ(何を書き出すかの覚え書き)")
    p.set_defaults(func=cmd_miro_anchor_add)
    p = sub.add_parser("miro-export", help="資料を Miro に書き出す(毎回新しいフレーム。書き終わるまで待つ)")
    p.add_argument("ids", nargs="*", help="書き出す文書ID(省くときは --project の資料を全部)")
    p.add_argument("--project", help="プロジェクトIDまたは名前(資料を省いたときにその資料を全部。十字では概要カードを置く)")
    p.add_argument("--anchor", help="目印の名前(ボードの付箋の [DM]名前)")
    p.add_argument("--anchor-url", help="付箋・図形のリンク(Miro の「リンクをコピー」)")
    p.add_argument("--free", action="store_true", help="目印を使わず、ボードの中身の右の空いている所に出す(利用者に確かめてから)")
    p.add_argument("--direction", help="向き(右・左・上・下・右上・右下・左上・左下・十字。省くと目印に書いた向き、無ければ右)")
    p.add_argument("--title", help="フレームの名前(省くと目印の名前。後ろに [日時] が付く)")
    p.add_argument("--groups", help='向きごとの組の JSON ファイル(- で標準入力)。[{"documentIds": [...], "direction": "右", "title": "..."}]')
    p.add_argument("--no-wait", action="store_true", help="書き終わるのを待たずに返す")
    p.set_defaults(func=cmd_miro_export)
    p = sub.add_parser("miro-move", help="書き出した資料を動かす(見出しも一緒に動く)")
    p.add_argument("id", help="動かす資料の文書ID")
    p.add_argument("--export", help="書き出しの ID(省くと自分の最後の書き出し)")
    p.add_argument("--next-to", help="この文書の隣へ")
    p.add_argument("--side", default="right", choices=["right", "left", "above", "below"], help="隣のどちら側か(既定 right)")
    p.add_argument("--frame", help="動かす先のフレーム(ID か名前。省くといまのフレーム)")
    p.add_argument("--x", type=float, help="フレームの左上からの位置(資料の中心)")
    p.add_argument("--y", type=float, help="フレームの左上からの位置(資料の中心)")
    p.set_defaults(func=cmd_miro_move)
    p = sub.add_parser("miro-layout", help="書き出したフレームに、レイアウト(資料の位置と色・見出し・図形)をまとめて当てる")
    p.add_argument("file", help="レイアウトの JSON ファイル(- で標準入力)")
    p.add_argument("--export", help="書き出しの ID(省くと自分の最後の書き出し)")
    p.set_defaults(func=cmd_miro_layout)
    p = sub.add_parser("miro-map", help="書き出したフレームの地図(資料の位置・人が足したもの・空いている所。Miro は変えない)")
    p.add_argument("--export", help="書き出しの ID(省くと自分の最後の書き出し)")
    p.set_defaults(func=cmd_miro_map)
    p = sub.add_parser("miro-layout-report", help="十字で書き出したらどうなるか(未分類・推定・表に無い値。Miro は変えない)")
    p.add_argument("ids", nargs="*", help="書き出す文書ID")
    p.add_argument("--project", help="プロジェクトIDまたは名前(文書IDを省くとその資料を全部)")
    p.set_defaults(func=cmd_miro_layout_report)

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
    # streaming_if は「この引数が指定されたときだけ生出力」(manifest --markdown など)
    streaming_if = getattr(args, "streaming_if", None)
    if getattr(args, "streaming", False) or (streaming_if and getattr(args, streaming_if, False)):
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
