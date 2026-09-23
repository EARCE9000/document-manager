# Dockerfile : Office文書 → PDF 変換サービス(document-manager から内部ネットワーク経由で呼ぶ)
# Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
# MIT Licensed
#
# アプリ本体のイメージにLibreOfficeを入れると、変換を使わない利用者にも1GB近い負担を強いるため、
# 別イメージ(earce9000/document-manager-converter)として分けている。
#
# amd64のみをビルドする。arm64はQEMUエミュレーション下での apt-get(LibreOffice一式)が
# 現実的な時間で終わらないため対象外(運用サーバはx86_64)。
#
# ベースはアプリと同じNode。変換の実行はLibreOffice、HTTPの受け口は標準モジュールだけで書く
# (このサービスのために依存パッケージを増やさない)。
#
# trixie(Debian 13)を使う。安定版のまま LibreOffice 25.2 が入るため、
# bookworm(7.4/2022年)より新しいOOXMLの再現度が期待できる(追加リポジトリは不要)。
FROM node:22-trixie-slim

# libreoffice-{writer,calc,impress}: 変換に必要な最小構成(libreoffice メタパッケージは
#   Base・Draw・Javaまで引き込むため使わない)
# fonts-noto-cjk: 日本語を正しく描画するために必須(無いと豆腐になる)
# fonts-liberation: Arial/Times等の代替(英字の体裁崩れを抑える)
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		libreoffice-writer \
		libreoffice-calc \
		libreoffice-impress \
		fonts-noto-cjk \
		fonts-liberation \
	&& rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV LISTEN_PORT=3000
# 変換の作業場所。読み取り専用で動かせるよう、書き込みは全てここに閉じる(compose側でtmpfsを割り当てる)
ENV WORK_DIR=/tmp/convert

WORKDIR /app
COPY converter/server.js ./

# 公式イメージが用意している非rootユーザーで動かす
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
	CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.LISTEN_PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
