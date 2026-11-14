# Dockerfile : Document Manager
# Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
# MIT Licensed
#
# runtime image
# better-sqlite3 v13+ ships prebuilt binaries (incl. linuxmusl-x64), so no
# python3/make/g++ toolchain or separate build stage is needed.
# NOTE: better-sqlite3 v13 requires Node >=22.
# NOTE: use npm, not yarn(classic) — yarn has no logic to detect the bundled
# prebuilt binary and always falls back to `node-gyp rebuild`, which fails
# here since there's no python3/build toolchain in this image.
#
# Multi-platform (linux/amd64,linux/arm64) builds: `npm install` runs in a
# separate stage on the build host's native platform ($BUILDPLATFORM) and only
# the resulting node_modules is copied into the target-platform image. Running
# node/npm for arm64 under QEMU emulation on the amd64 CI runner crashed with
# SIGILL (exit code 132), so no node process is executed under emulation.
# This works because no dependency compiles native code at install time:
# better-sqlite3 bundles prebuilds for every platform, protobufjs' postinstall
# is plain JS, and platform-specific optional packages (@napi-rs/canvas-*) are
# selected for the target via npm's --os/--cpu/--libc.
FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
ARG TARGETARCH
WORKDIR /app
COPY app/package.json ./
# npm uses Node's arch names (x64/arm64); Docker's TARGETARCH uses amd64/arm64
RUN NPM_CPU="$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH")" 	&& npm install --omit=dev --no-audit --no-fund --os=linux --cpu="$NPM_CPU" --libc=musl 	&& npm cache clean --force

FROM node:24-alpine

# npm は動かすときに使わない(依存はビルドの段で入れ終えている)。イメージに残すと、
# npm が抱えている部品(undici・brace-expansion など)の脆弱性がイメージの指摘として出続けるので消す
# /app/certs: 下で RDS の証明書の束を置く場所。ADD に作らせると、node のユーザーが入れない権限(700)になるので、先に作っておく
# zlib: 元のイメージの版(1.3.2-r1)に CVE-2026-4738 があるので、直った版へ上げる(元のイメージが新しくなれば何もしない)
RUN apk add --no-cache tzdata \
	&& apk upgrade --no-cache zlib \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
	&& mkdir -p /app/certs && chmod 755 /app/certs
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
# Claude Code 用 Skill(APIキー管理画面からZIPでダウンロードさせる。lib/claude-skill.js参照)
COPY tools/claude-skill/document-manager/ ./claude-skill/document-manager/
# 関連するSkill(Document Manager とは別のサービス用)も、同じ画面から配る(lib/claude-skill.js の RELATED_SKILLS)
COPY tools/claude-skill/backlog/ ./claude-skill/backlog/
# Amazon RDS の証明書の束(発行元)。RDS へ TLS でつなぎ、相手の証明書を確かめるときに使う
# (DATABASE_SSL=verify と DATABASE_SSL_CA=/app/certs/rds-global-bundle.pem。lib/pg-ssl.js 参照)。
# RDS の発行元は Node が持つ既定の一覧に無いので、AWS が公開している束を入れておく
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

# バージョン情報(画面右下の Ver. 表示・OpenAPIのversion)。CIから渡される値で必ず生成する。
# COPYの後に置いているのは、ローカルに残っている古い VERSION.json を必ず上書きするため
ARG APP_VERSION=0
ARG APP_REVISION=unknown
RUN printf '{"VERSION":"%s","REVISION":"%s","BUILT_AT":"%s"}' "$APP_VERSION" "$APP_REVISION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > VERSION.json

# data (documents / sqlite db) is mounted at runtime, not baked into the image
VOLUME ["/data"]

# official node image already provides an unprivileged "node" user
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -q -O /dev/null "http://127.0.0.1:${LISTEN_PORT:-8080}/_ping" || exit 1

ENTRYPOINT ["node", "server.js"]
