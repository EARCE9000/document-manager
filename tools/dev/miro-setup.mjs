#!/usr/bin/env node
/*!
 * miro-setup.mjs : 手元で Miro 連携を試すための、Miro アプリの値(クライアントID・シークレット)の登録
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * Miro の開発者ハブで作ったアプリの「クライアントID」と「クライアントシークレット」を、
 * 手元のファイル(~/.document-manager/miro-dev.env)に保存する。シークレットはパスワードと同じ扱いで、
 * チャットやリポジトリに置かないこと。ここでは画面に出さずに受け取る(1文字ごとに * を出す)。
 *
 *   node tools/dev/miro-setup.mjs          値を入力して保存する(上書きできる)
 *   node tools/dev/miro-setup.mjs --check  保存済みか・形が合っているかだけを見る(値は出さない)
 *
 * 保存したファイルは、試し用のサーバーを起動するときに環境変数として読み込む
 * (例: sh なら `set -a; . ~/.document-manager/miro-dev.env; set +a`)。
 * 運用のサーバーでは、このスクリプトではなく compose.env に MIRO_CLIENT_ID / MIRO_CLIENT_SECRET を書く。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_PATH = process.env.MIRO_DEV_ENV || path.join(os.homedir(), ".document-manager", "miro-dev.env");

// Miro のクライアントIDは数字だけ。シークレットは英数字の並び(空白や引用符が混ざっていたら貼り損ね)
const CLIENT_ID_PATTERN = /^\d{10,30}$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const fail = (message) => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

const isInteractive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === "function");

const readSaved = () => {
	try {
		return Object.fromEntries(fs.readFileSync(CONFIG_PATH, "utf8").split(/\r?\n/)
			.map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim()))
			.filter(Boolean)
			.map((m) => [m[1], m[2]]));
	} catch {
		return {};
	}
};

const askVisible = (question) => new Promise((resolve) => {
	process.stderr.write(`${question}: `);
	process.stdin.setEncoding("utf8");
	process.stdin.resume();
	process.stdin.once("data", (chunk) => {
		process.stdin.pause();
		resolve(String(chunk).trim());
	});
});

// 打った・貼り付けた文字は出さず、1文字ごとに * を出す(貼り付けが入ったことだけ分かるように)
const askSecret = (question) => new Promise((resolve, reject) => {
	process.stderr.write(`${question}: `);
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	let value = "";
	const finish = (callback) => {
		stdin.setRawMode(false);
		stdin.pause();
		stdin.removeListener("data", onData);
		process.stderr.write("\n");
		callback();
	};
	const onData = (chunk) => {
		for (const ch of chunk) {
			if (ch === "\r" || ch === "\n") {
				finish(() => resolve(value.trim()));
				return;
			}
			if (ch === "\u0003") {
				finish(() => reject(new Error("中止しました")));
				return;
			}
			if (ch === "\u007f" || ch === "\b") {
				if (value.length > 0) {
					value = value.slice(0, -1);
					process.stderr.write("\b \b");
				}
			} else if (ch >= " ") {
				value += ch;
				process.stderr.write("*");
			}
		}
	};
	stdin.on("data", onData);
});

// 貼り付けた値の前後に付いてきがちなもの(空白・引用符)を取り除く
const clean = (value) => {
	let cleaned = String(value).trim();
	if (cleaned.length >= 2 && cleaned[0] === cleaned.at(-1) && `"'`.includes(cleaned[0])) cleaned = cleaned.slice(1, -1).trim();
	return cleaned;
};

const check = () => {
	const saved = readSaved();
	const idOk = CLIENT_ID_PATTERN.test(saved.MIRO_CLIENT_ID || "");
	const secretOk = CLIENT_SECRET_PATTERN.test(saved.MIRO_CLIENT_SECRET || "");
	process.stdout.write(JSON.stringify({
		path: CONFIG_PATH,
		saved: fs.existsSync(CONFIG_PATH),
		clientId: idOk ? "保存済み" : saved.MIRO_CLIENT_ID ? "形が違います" : "未保存",
		clientSecret: secretOk ? "保存済み" : saved.MIRO_CLIENT_SECRET ? "形が違います" : "未保存"
	}, null, 2) + "\n");
	process.exit(idOk && secretOk ? 0 : 1);
};

const main = async () => {
	if (process.argv.includes("--check")) check();
	if (!isInteractive()) {
		fail("入力できる端末から実行してください(AIエージェントからは実行できません。値はチャットに貼らず、ご自身の端末で入力します)");
	}
	const saved = readSaved();
	process.stderr.write("Miro の開発者ハブ → 作成アプリ → アプリの認証情報 にある値を入力します。\n");
	process.stderr.write(`保存先: ${CONFIG_PATH}\n\n`);

	let clientId = clean(await askVisible(`クライアントID${saved.MIRO_CLIENT_ID ? "(空のまま Enter で今のまま)" : ""}`)) || saved.MIRO_CLIENT_ID || "";
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		fail(`クライアントIDの形が違います(保存していません)。数字だけの値です(入力は ${clientId.length} 文字)`);
	}
	const secret = clean(await askSecret("クライアントシークレット(貼り付けて Enter。画面には * で出ます)"));
	if (!CLIENT_SECRET_PATTERN.test(secret)) {
		fail(`クライアントシークレットの形が違います(保存していません)。英数字の並びです(入力は ${secret.length} 文字。空白や引用符が混ざっていないか確かめてください)`);
	}
	fs.mkdirSync(path.dirname(CONFIG_PATH), {recursive: true});
	fs.writeFileSync(CONFIG_PATH, [
		"# Miro アプリの値(手元で Miro 連携を試すため)。チャットやリポジトリに置かないこと",
		`MIRO_CLIENT_ID="${clientId}"`,
		`MIRO_CLIENT_SECRET="${secret}"`,
		""
	].join("\n"), {mode: 0o600});
	try {
		fs.chmodSync(CONFIG_PATH, 0o600);
	} catch {}
	process.stderr.write(`\n保存しました(${CONFIG_PATH})。チャットには「保存した」とだけ伝えてください。\n`);
};

main().catch((err) => fail(err.message));
