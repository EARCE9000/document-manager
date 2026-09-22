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
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
ARG TARGETARCH
WORKDIR /app
COPY app/package.json ./
# npm uses Node's arch names (x64/arm64); Docker's TARGETARCH uses amd64/arm64
RUN NPM_CPU="$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH")" 	&& npm install --omit=dev --no-audit --no-fund --os=linux --cpu="$NPM_CPU" --libc=musl 	&& npm cache clean --force

FROM node:22-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
# Claude Code 用 Skill(APIキー管理画面からZIPでダウンロードさせる。lib/claude-skill.js参照)
COPY tools/claude-skill/document-manager/ ./claude-skill/document-manager/

# data (documents / sqlite db) is mounted at runtime, not baked into the image
VOLUME ["/data"]

# official node image already provides an unprivileged "node" user
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -q -O /dev/null "http://127.0.0.1:${LISTEN_PORT:-8080}/_ping" || exit 1

ENTRYPOINT ["node", "server.js"]
