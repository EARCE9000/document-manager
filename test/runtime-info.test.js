/*!
 * runtime-info.test.js : 動いている部品の版の集め方(app/lib/runtime-info.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 土台(Node.js・OpenSSL・OS)の版、入っている npm の部品(直接使っているもの・入れ子の別の版)、
 * Weaviate の版とモジュールを読めることを確かめる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const RuntimeInfo = require("../app/lib/runtime-info.js");

test("本体の土台: Node.js・V8・OpenSSL・OS・CPU・メモリの版と量", () => {
	const runtime = RuntimeInfo.appRuntime();
	assert.equal(runtime.node, process.versions.node);
	assert.equal(runtime.openssl, process.versions.openssl);
	assert.equal(runtime.arch, process.arch);
	assert.ok(runtime.os.length > 0);
	assert.ok(runtime.cpus > 0);
	assert.ok(runtime.memory.rssBytes > 0 && runtime.memory.totalBytes > runtime.memory.rssBytes);
});

test("部品表: 入っている npm の部品を版つきで返し、直接使っているもの(package.json の dependencies)に印を付ける", () => {
	const {source, packages} = RuntimeInfo.packages();
	assert.match(source, /node_modules/);
	const direct = Object.keys(require("../app/package.json").dependencies);
	const express = packages.find((p) => p.name === "express" && p.path === "node_modules/express");
	assert.equal(express.version, require("../app/node_modules/express/package.json").version);
	assert.equal(express.direct, true);
	// 直接使っているものは全部入っている
	for (const name of direct) assert.ok(packages.some((p) => p.name === name && p.direct), `${name} が部品表に無い`);
	// 入れ子に入った部品は direct にしない
	assert.ok(packages.filter((p) => p.path.split("node_modules/").length > 2).every((p) => p.direct === false));
	// 名前の順
	const names = packages.map((p) => p.name);
	assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("Weaviate: 版と、モジュール(埋め込みモデル)の名前を読む。使っていなければ null、届かなければ reachable: false", async () => {
	const server = http.createServer((req, res) => {
		if (req.url !== "/v1/meta") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {"Content-Type": "application/json"});
		res.end(JSON.stringify({version: "1.27.3", modules: {"text2vec-transformers": {model: {_name_or_path: "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"}}}}));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const info = await RuntimeInfo.weaviateInfo(`http://127.0.0.1:${server.address().port}`);
		assert.deepEqual(info, {reachable: true, version: "1.27.3",
			modules: [{name: "text2vec-transformers", model: "sentence-transformers/paraphrase-multilingual-mpnet-base-v2", version: null}]});
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	assert.equal(await RuntimeInfo.weaviateInfo(""), null);
	const down = await RuntimeInfo.weaviateInfo("http://127.0.0.1:9", {timeoutMs: 2000});
	assert.equal(down.reachable, false);
});

test("DB の版: SQLite は sqlite_version()、PostgreSQL は server_version。読めなければ null", async () => {
	const fake = (backend, row) => ({backend, get: async (sql) => (row instanceof Error ? Promise.reject(row) : {...row, sql})});
	assert.equal(await RuntimeInfo.databaseVersion(fake("sqlite", {v: "3.46.1"})), "3.46.1");
	assert.equal(await RuntimeInfo.databaseVersion(fake("postgres", {server_version: "16.4"})), "16.4");
	assert.equal(await RuntimeInfo.databaseVersion(fake("sqlite", new Error("x"))), null);
});

test("IdP: 設定の文書(.well-known/openid-configuration)に届くか。接続先はホストの名前まで", async () => {
	const server = http.createServer((req, res) => {
		if (req.url !== "/realms/dm/.well-known/openid-configuration") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {"Content-Type": "application/json"});
		res.end("{}");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	try {
		assert.deepEqual(await RuntimeInfo.idpInfo(`${origin}/realms/dm`), {reachable: true});
		assert.deepEqual(await RuntimeInfo.idpInfo(`${origin}/realms/other`), {reachable: false, error: "HTTP 404"});
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	assert.equal(await RuntimeInfo.idpInfo(""), null);
	assert.equal(RuntimeInfo.hostOf("https://user:secret@login.example.com:8443/realms/dm?x=1"), "login.example.com:8443");
	assert.equal(RuntimeInfo.hostOf("not a url"), null);
});

test("つながりの確認: 掛かった時間と、最後に成功した時刻(失敗しても、前の成功の時刻は残る)", async () => {
	let clock = Date.parse("2026-10-24T00:00:00.000Z");
	const tracker = RuntimeInfo.createConnectionTracker({now: () => clock});
	const ok = await tracker.measure("db", async () => {
		clock += 12;
		return {version: "1"};
	});
	assert.deepEqual(ok, {value: {version: "1"}, latencyMs: 12, reachable: true, error: null, lastSuccessAt: "2026-10-24T00:00:00.012Z"});

	clock += 1000;
	const down = await tracker.measure("db", async () => ({reachable: false, error: "HTTP 503"}));
	assert.equal(down.reachable, false);
	assert.equal(down.error, "HTTP 503");
	assert.equal(down.lastSuccessAt, "2026-10-24T00:00:00.012Z");

	const thrown = await tracker.measure("other", async () => {
		throw new Error("ECONNREFUSED");
	});
	assert.deepEqual({reachable: thrown.reachable, error: thrown.error, lastSuccessAt: thrown.lastSuccessAt}, {reachable: false, error: "ECONNREFUSED", lastSuccessAt: null});

	const slow = await RuntimeInfo.createConnectionTracker().measure("slow", () => new Promise(() => {}), {timeoutMs: 50});
	assert.deepEqual({reachable: slow.reachable, error: slow.error}, {reachable: false, error: "応答がありません"});
});

test("Weaviate のモジュール: 使っている物を先に出し、ほかは数と名前を 1 行に。Document Manager が使わない物が有効なら注意を出す", () => {
	const modules = [
		{name: "generative-openai", model: null, version: null},
		{name: "text2vec-transformers", model: "./models/model", version: null},
		{name: "text2vec-cohere", model: null, version: null},
		{name: "reranker-cohere", model: null, version: null}
	];
	const candidates = ["text2vec-transformers", "text2vec-cohere", "text2vec-openai", "text2vec-aws"];
	const summary = RuntimeInfo.summarizeWeaviateModules(modules, "text2vec-transformers", candidates);
	assert.deepEqual(summary.modules.map((m) => m.name), ["text2vec-transformers"]);
	assert.deepEqual(summary.details[0], {label: "ほかに有効なモジュール", value: "3 個: generative-openai、text2vec-cohere、reranker-cohere"});
	assert.equal(summary.details[1].label, "注意");
	assert.match(summary.details[1].value, /使わないモジュールが 2 個有効/);
	assert.match(summary.details[1].value, /API_BASED_MODULES_DISABLED=true/);

	// 切り替え先の候補だけが有効なら、注意は出さない
	const tidy = RuntimeInfo.summarizeWeaviateModules(modules.filter((m) => candidates.includes(m.name)), "text2vec-transformers", candidates);
	assert.deepEqual(tidy.details.map((d) => d.label), ["ほかに有効なモジュール"]);
	// モジュールが 1 つだけなら、補足は無し。読めない応答でも落ちない
	assert.deepEqual(RuntimeInfo.summarizeWeaviateModules([modules[1]], "text2vec-transformers", candidates).details, []);
	assert.deepEqual(RuntimeInfo.summarizeWeaviateModules(undefined, null, []), {modules: [], details: []});
});
