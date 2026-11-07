/*!
 * pg-ssl.test.js : PostgreSQL へ TLS でつなぐときの設定(app/lib/pg-ssl.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * verify では相手の証明書を確かめること(DATABASE_SSL_CA があればその発行元で)。
 * true は以前の動き(確かめない)のままで、警告を出すこと。分からない値・読めない CA では起動を止めること。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {pgSslConfig} = require("../app/lib/pg-ssl.js");

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n";
const withTempFile = (content, fn) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-ssl-"));
	const file = path.join(dir, "ca.pem");
	fs.writeFileSync(file, content);
	try {
		return fn(file);
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
};

test("未設定・false は TLS を使わない", () => {
	for (const value of [undefined, "", "false", "FALSE"]) {
		assert.deepEqual(pgSslConfig({DATABASE_SSL: value}), {ssl: false, warning: null});
	}
	// CA だけ指定しても TLS にはならない(気づけるよう警告する)
	assert.equal(pgSslConfig({DATABASE_SSL_CA: "/x/ca.pem"}).ssl, false);
	assert.match(pgSslConfig({DATABASE_SSL_CA: "/x/ca.pem"}).warning, /DATABASE_SSL が未設定/);
});

test("verify は相手の証明書を確かめる(CA の指定が無ければ既定の一覧で)", () => {
	assert.deepEqual(pgSslConfig({DATABASE_SSL: "verify"}), {ssl: {rejectUnauthorized: true}, warning: null});
	withTempFile(PEM, (file) => {
		assert.deepEqual(pgSslConfig({DATABASE_SSL: "verify", DATABASE_SSL_CA: file}), {ssl: {rejectUnauthorized: true, ca: PEM}, warning: null});
	});
});

test("true は以前の動き(確かめない)のまま、警告を出す", () => {
	const {ssl, warning} = pgSslConfig({DATABASE_SSL: "true"});
	assert.deepEqual(ssl, {rejectUnauthorized: false});
	assert.match(warning, /確かめません/);
});

test("分からない値・読めない CA・証明書の入っていない CA では起動を止める", () => {
	assert.throws(() => pgSslConfig({DATABASE_SSL: "require"}), /DATABASE_SSL の値が分かりません/);
	assert.throws(() => pgSslConfig({DATABASE_SSL: "verify", DATABASE_SSL_CA: path.join(os.tmpdir(), "no-such-ca.pem")}), /読めません/);
	withTempFile("not a certificate", (file) => {
		assert.throws(() => pgSslConfig({DATABASE_SSL: "verify", DATABASE_SSL_CA: file}), /証明書\(PEM\)が入っていません/);
	});
});
