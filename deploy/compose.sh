#!/bin/bash -e
#
# compose.sh : deploy/compose.yml で Document Manager + Weaviate(セマンティック検索)を起動する
# Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
# MIT Licensed
#
# サイト固有の値(ドメイン・内部IP・シークレット等)はこのスクリプトには書かず、Git管理外の
# 設定ファイルから読み込む。ひな形は deploy/compose.env.example を参照。
#
#   cp deploy/compose.env.example /etc/application-auth/document-manager.env
#   chmod 600 /etc/application-auth/document-manager.env
#   ./deploy/compose.sh up
#
# 設定ファイルの場所は DOCUMENT_MANAGER_ENV で変更できる。
# 既に別のファイル(/etc/application-auth/*.sh 等)で OIDC_* を export している場合は、
# それを source してからこのスクリプトを呼んでもよい(環境変数が優先される)。
#
# 使い方:
#   ./compose.sh up      … イメージを取得して起動(既定)
#   ./compose.sh down    … 停止・削除(データは残る)
#   ./compose.sh logs    … ログを追う
#   ./compose.sh ps      … 状態確認

BASE_DIR=$(cd "$(dirname "$0")" && pwd)
COMPOSE_FILE="${BASE_DIR}/compose.yml"
ENV_FILE="${DOCUMENT_MANAGER_ENV:-/etc/application-auth/document-manager.env}"

if [ -f "${ENV_FILE}" ]; then
	set -a
	# shellcheck disable=SC1090
	source "${ENV_FILE}"
	set +a
fi

# 起動に最低限必要なもの。足りないまま起動すると、ログインできない・再起動のたびに
# 全員がログアウトされる等の分かりにくい障害になるため、ここで止める
for name in OIDC_ISSUER OIDC_CLIENT_ID OIDC_REDIRECT_URI SESSION_SECRET DOCUMENT_MANAGER_IP; do
	if [ -z "${!name:-}" ]; then
		echo "${name} が未設定です。${ENV_FILE} を用意するか、環境変数として渡してください" >&2
		echo "(ひな形: ${BASE_DIR}/compose.env.example)" >&2
		exit 1
	fi
done

COMPOSE="podman-compose"
command -v "${COMPOSE}" >/dev/null 2>&1 || COMPOSE="podman compose"

case "${1:-up}" in
	up)
		${COMPOSE} -f "${COMPOSE_FILE}" pull
		${COMPOSE} -f "${COMPOSE_FILE}" up -d
		${COMPOSE} -f "${COMPOSE_FILE}" ps
		;;
	down)
		${COMPOSE} -f "${COMPOSE_FILE}" down
		;;
	logs)
		${COMPOSE} -f "${COMPOSE_FILE}" logs -f
		;;
	ps)
		${COMPOSE} -f "${COMPOSE_FILE}" ps
		;;
	*)
		echo "使い方: $0 [up|down|logs|ps]" >&2
		exit 1
		;;
esac
