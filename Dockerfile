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
FROM node:22-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

# data (documents / sqlite db) is mounted at runtime, not baked into the image
VOLUME ["/data"]

# official node image already provides an unprivileged "node" user
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -q -O /dev/null "http://127.0.0.1:${LISTEN_PORT:-8080}/_ping" || exit 1

ENTRYPOINT ["node", "server.js"]
