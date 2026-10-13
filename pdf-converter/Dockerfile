# Dockerfile : HTML → PDF 変換サービス(document-manager から内部ネットワーク経由で呼ぶ)
# Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
# MIT Licensed
#
# Office用の変換サービス(converter/)とは別のイメージ(earce9000/document-manager-pdf-converter)に
# している。理由は2つ:
#   - 使う人だけが入れればよい(Chromium一式で、圧縮しても400MB近くある)
#   - ブラウザのエンジンで他人が作ったHTMLを開く。Officeの変換とは危険の種類が違うので、
#     同じコンテナ・同じネットワークに同居させない
#
# amd64のみをビルドする(converter/ と同じ。運用サーバはx86_64)。
#
# ベースはアプリと同じNode。描画はChromium、HTTPの受け口は標準モジュールだけで書く
# (このサービスのために依存パッケージを増やさない)。
FROM node:22-trixie-slim

# chromium-headless-shell: 画面を持たない描画専用のChromium(通常の chromium より小さい)
# fonts-morisawa-bizud-gothic / -mincho: 日本語の既定のフォント(BIZ UDゴシック・明朝)。
#   選んだ理由は pdf-converter/fonts.conf に書いてある
# fonts-noto-cjk: BIZ UD に無い字(中国語・韓国語・一部の漢字)のための控え
# fonts-liberation: Arial/Times/Courier等の代替(英字の体裁崩れを抑える)
# fontconfig: フォントの一覧を作り直す fc-cache のため
# tini: PID 1 として置く。Chromiumは子プロセスを多く作り、止めたあとの後始末(reap)を
#   PID 1 がしないと、終了済みのプロセスが変換のたびに溜まっていく
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium-headless-shell \
		fonts-morisawa-bizud-gothic \
		fonts-morisawa-bizud-mincho \
		fonts-noto-cjk \
		fonts-liberation \
		fontconfig \
		tini \
	&& rm -rf /var/lib/apt/lists/*

# 文書が指定するフォントが無いときの落ち先を決める(決めないと環境まかせになり、本文が等幅になる)
COPY pdf-converter/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV LISTEN_PORT=3000
# 変換の作業場所。読み取り専用で動かせるよう、書き込みは全てここに閉じる(compose側でtmpfsを割り当てる)
ENV WORK_DIR=/tmp/convert
# フォントの一覧の控えを置く場所。読み取り専用で動かすと、イメージに焼いた控えが
# 「古い」と判定されたときに書き直せず、Chromiumを起動するたびにフォントを探し直す
# (1件あたり約0.05秒)。書ける場所(tmpfs)を教えておく
ENV XDG_CACHE_HOME=/tmp/cache

WORKDIR /app
COPY pdf-converter/server.js ./

# 公式イメージが用意している非rootユーザーで動かす
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
	CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.LISTEN_PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
