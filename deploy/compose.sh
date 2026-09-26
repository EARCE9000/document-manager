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
#   ./compose.sh up      … イメージを取得して起動し、入れ替わったことを確かめる(既定)
#   ./compose.sh verify  … 取得済みのイメージで動いているかを確かめるだけ(何も変更しない)
#   ./compose.sh down    … 停止・削除(データは残る)
#   ./compose.sh logs    … ログを追う
#   ./compose.sh ps      … 状態確認
#
# ---- なぜ up が確認までするのか ----
# podman-compose の版によっては、タグが同じ(latest)だと pull で新しいイメージを取ってきても
# up -d がコンテナを作り直さない。古いイメージのまま動き続け、しかも成功したように見える。
# 実際に「更新したのに画面が変わらない」で2回引っかかったため、up のたびに
# **動いているコンテナのイメージID**と**取得したイメージのID**を突き合わせ、
# 食い違っていればそのコンテナだけ作り直す(関係ないサービスは止めない)。

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

# イメージIDの突き合わせに使う素のCLI(composeラッパーでは取れないため)
CLI="${CONTAINER_CLI:-}"
if [ -z "${CLI}" ]; then
	if command -v podman >/dev/null 2>&1; then CLI="podman"; else CLI="docker"; fi
fi

# compose.yml と同じ既定値でコンテナ名とイメージを組み立てる(ここがずれると確認にならない)
APP_CONTAINER="${DOCUMENT_MANAGER_CONTAINER:-document_manager}"
SERVICES=(
	"app|${APP_CONTAINER}|${DOCUMENT_MANAGER_IMAGE:-docker.io/earce9000/document-manager}:${DOCUMENT_MANAGER_TAG:-latest}"
	"converter|${APP_CONTAINER}_converter|${DOCUMENT_MANAGER_CONVERTER_IMAGE:-docker.io/earce9000/document-manager-converter}:${DOCUMENT_MANAGER_CONVERTER_TAG:-latest}"
	"weaviate|${APP_CONTAINER}_weaviate|docker.io/semitechnologies/weaviate:${WEAVIATE_VERSION:-latest}"
	"t2v-transformers|${APP_CONTAINER}_t2v|docker.io/semitechnologies/transformers-inference:${T2V_MODEL_TAG:-sentence-transformers-paraphrase-multilingual-mpnet-base-v2}"
)

# podman は sha256: を付けずに返し、docker は付けて返す。比較の前に揃える
normalize_id() { echo "${1#sha256:}"; }

# 取得済みのイメージと違うもので動いているコンテナを "サービス名|コンテナ名" で並べる。
# コンテナやイメージがまだ無い場合は判定しない(起動前・任意のサービスを使わない構成があるため)
stale_services() {
	local row service container image running expected
	for row in "${SERVICES[@]}"; do
		IFS='|' read -r service container image <<< "${row}"
		running=$(${CLI} inspect --format '{{.Image}}' "${container}" 2>/dev/null) || continue
		expected=$(${CLI} image inspect --format '{{.Id}}' "${image}" 2>/dev/null) || continue
		[ -n "${running}" ] && [ -n "${expected}" ] || continue
		if [ "$(normalize_id "${running}")" != "$(normalize_id "${expected}")" ]; then
			echo "${service}|${container}"
		fi
	done
}

# 何が動いているのかを数字で示す。ここが変わっていなければ入れ替わっていない
report_running_version() {
	local json
	json=$(${CLI} exec "${APP_CONTAINER}" cat /app/VERSION.json 2>/dev/null) || return 0
	echo "動作中のアプリ: ${json}"
}

verify_images() {
	local stale
	stale=$(stale_services)
	if [ -n "${stale}" ]; then
		echo "" >&2
		echo "警告: 取得したイメージで動いていないコンテナがあります" >&2
		while IFS='|' read -r service container; do
			[ -n "${service}" ] && echo "  - ${service} (${container})" >&2
		done <<< "${stale}"
		return 1
	fi
	echo "すべてのコンテナが、取得済みのイメージで動いています"
	return 0
}

case "${1:-up}" in
	up)
		${COMPOSE} -f "${COMPOSE_FILE}" pull
		${COMPOSE} -f "${COMPOSE_FILE}" up -d

		# up だけでは入れ替わらないことがあるため、食い違っているものだけ作り直す。
		# 全体を down するとWeaviate等まで止まるので、対象のコンテナだけ消して up し直す
		stale=$(stale_services)
		if [ -n "${stale}" ]; then
			echo ""
			echo "古いイメージのまま動いているコンテナを作り直します:"
			while IFS='|' read -r service container; do
				[ -n "${service}" ] || continue
				echo "  - ${service} (${container})"
				${CLI} rm -f "${container}" >/dev/null 2>&1 || true
			done <<< "${stale}"
			${COMPOSE} -f "${COMPOSE_FILE}" up -d
		fi

		echo ""
		# 入れ替わらなかった場合に終了コード0で終わると、自動化した側が成功と誤解する
		up_status=0
		verify_images || up_status=1
		if [ "${up_status}" -ne 0 ]; then
			echo "(作り直しても入れ替わりません。イメージ名・タグの指定を確認してください)" >&2
		fi
		report_running_version
		echo ""
		${COMPOSE} -f "${COMPOSE_FILE}" ps
		exit "${up_status}"
		;;
	verify)
		verify_images
		report_running_version
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
		echo "使い方: $0 [up|verify|down|logs|ps]" >&2
		exit 1
		;;
esac
