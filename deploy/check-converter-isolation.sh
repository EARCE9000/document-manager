#!/bin/bash
#
# check-converter-isolation.sh : 変換サービス(converter)の隔離が実際に効いているかを確かめる
# Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
# MIT Licensed
#
# converter は信用できない文書を開くソフト(LibreOffice)を動かす。文書に埋め込まれた外部参照
# (画像URL・リンク・外部セル参照)を取りに行くことがあるため、細工された文書に任意のURLを
# 叩かせない(SSRF)ことと、Weaviate等の他サービスに触れさせないことを、ネットワーク構成で
# 担保している(deploy/compose.yml の document_manager_convert / internal: true)。
#
# ただし podman-compose の版によっては internal が反映されないことがある。設定を書いただけでは
# 効いている保証にならないため、設定値と「実際に外へ出られないか」の両方を確かめる。
#
#   ./deploy/check-converter-isolation.sh
#
# 環境変数:
#   CONTAINER_CLI  既定 podman (docker でも動く)
#   CONVERTER      converterのコンテナ名 (既定 document_manager_converter)
#   WEAVIATE       到達できてはいけない相手 (既定 document_manager_weaviate)

set -uo pipefail

CLI="${CONTAINER_CLI:-podman}"
CONVERTER="${CONVERTER:-document_manager_converter}"
WEAVIATE="${WEAVIATE:-document_manager_weaviate}"

failures=0
ok()   { echo "  ok   $1${2:+ … $2}"; }
fail() { echo "  FAIL $1${2:+ … $2}"; failures=$((failures + 1)); }

command -v "${CLI}" >/dev/null 2>&1 || { echo "${CLI} が見つかりません (CONTAINER_CLI で変更できます)" >&2; exit 2; }
"${CLI}" inspect "${CONVERTER}" >/dev/null 2>&1 || {
	echo "コンテナ ${CONVERTER} が見つかりません。起動しているか、CONVERTER で名前を指定してください" >&2
	exit 2
}

echo "[対象] ${CLI} / ${CONVERTER}"

# ---- 1. 参加しているネットワーク ----
echo
echo "■ 参加しているネットワーク"
networks=$("${CLI}" inspect "${CONVERTER}" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null)
networks=$(echo "${networks}" | tr -s ' ' | sed 's/ $//')
count=$(echo "${networks}" | wc -w)
if [ "${count}" -eq 1 ]; then
	ok "1つだけに参加している" "${networks}"
else
	# 複数に参加していると、そのうちの1つが外に出られれば隔離は破れる
	fail "1つだけであるべき" "${count}個: ${networks}"
fi

# ---- 2. そのネットワークが internal か ----
echo
echo "■ ネットワークの設定"
for net in ${networks}; do
	internal=$("${CLI}" network inspect "${net}" --format '{{.Internal}}' 2>/dev/null)
	if [ -z "${internal}" ]; then
		# --format 未対応の版へのフォールバック
		internal=$("${CLI}" network inspect "${net}" 2>/dev/null | grep -i '"internal"' | grep -io 'true\|false' | head -1)
	fi
	if [ "${internal}" = "true" ]; then
		ok "${net} は internal"
	else
		fail "${net} が internal になっていない" "internal=${internal:-取得できず}"
	fi
done

# ---- 3. 実際に外へ出られないか(設定値だけを信じない) ----
# converter は node:22 ベースなので、追加の道具を入れずに node で試せる
probe() {
	local url="$1"
	"${CLI}" exec "${CONVERTER}" node -e "
		fetch('${url}', {signal: AbortSignal.timeout(5000)})
			.then((res) => console.log('REACHED ' + res.status))
			.catch((err) => console.log('BLOCKED ' + (err.cause && err.cause.code ? err.cause.code : err.name)));
	" 2>/dev/null
}

echo
echo "■ 実際の到達性(コンテナの中から)"
for url in "https://example.com" "http://1.1.1.1"; do
	result=$(probe "${url}")
	case "${result}" in
		BLOCKED*) ok "外に出られない: ${url}" "${result#BLOCKED }" ;;
		REACHED*) fail "外に出られてしまう: ${url}" "${result}" ;;
		*)        fail "確認できない: ${url}" "${result:-応答なし}" ;;
	esac
done

result=$(probe "http://${WEAVIATE}:8080/v1/.well-known/ready")
case "${result}" in
	BLOCKED*) ok "他のサービスへ到達できない: ${WEAVIATE}" "${result#BLOCKED }" ;;
	REACHED*) fail "他のサービスへ到達できてしまう: ${WEAVIATE}" "${result}" ;;
	*)        fail "確認できない: ${WEAVIATE}" "${result:-応答なし}" ;;
esac

# ---- 結果 ----
echo
if [ "${failures}" -eq 0 ]; then
	echo "隔離は効いています。"
	exit 0
fi

cat <<'REMEDY'
隔離が効いていません。podman-compose が internal を反映していない可能性があります。

対処: ネットワークを手で作ってから、compose では既存のものとして使う。

  ./deploy/compose.sh down
  podman network create --internal <プレフィックス>_document_manager_convert
  # deploy/compose.yml の document_manager_convert を external: true に変更してから
  ./deploy/compose.sh up

暫定的に converter を止めておくこともできます(体裁つき表示だけが使えなくなり、
文書の登録・検索・概要プレビューには影響しません)。

  podman stop document_manager_converter
REMEDY
exit 1
