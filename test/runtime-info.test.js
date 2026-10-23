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
