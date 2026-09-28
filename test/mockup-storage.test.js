/*!
 * mockup-storage.test.js : モックアップの原本をどこへ置くか
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 確かめたいのは次の2点。どちらも間違えると運用中に困る形で表に出る。
 *
 *  1. **local構成で置き場所が変わっていないこと**。既に物理サーバで動いている環境があり、
 *     ここが動くと入れ替えた瞬間に既存のモックアップが見えなくなる
 *  2. **S3/GCSのキーが文書と混ざらないこと**。同じprefixに入れると、文書とファイルの
 *     突き合わせ(lib/storage-reconcile.js)が互いを身元不明のファイルとして拾う
 *
 * 置き場所はモジュールを読み込んだ時点の環境変数で決まるため、環境変数を変えて読み直す。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const MOCKUP_ID = "202601_3fa85f64-5717-4562-b3fc-2c963f66afa6";

/** 環境変数を差し替えて mockup-storage を読み直す */
const loadWith = (env) => {
	const saved = {...process.env};
	for (const [key, value] of Object.entries(env)) {
		if (value == null) delete process.env[key];
		else process.env[key] = value;
	}
	for (const name of ["storage.js", "mockup-storage.js", "logger.js"]) {
		delete require.cache[require.resolve(`../app/lib/${name}`)];
	}
	try {
		return require("../app/lib/mockup-storage.js");
	} finally {
		process.env = saved;
		for (const name of ["storage.js", "mockup-storage.js", "logger.js"]) {
			delete require.cache[require.resolve(`../app/lib/${name}`)];
		}
	}
};

const DATA_DIR = path.join(os.tmpdir(), "dm-mockup-storage-test");

test("local構成では、原本も展開先も <DATA_DIR>/mockups/<ID>/ のまま", () => {
	const MockupStorage = loadWith({DATA_DIR, STORAGE_BACKEND: "local"});
	const expected = path.join(DATA_DIR, "mockups", MOCKUP_ID);

	assert.equal(MockupStorage.mockupDir(MOCKUP_ID), expected);
	assert.equal(MockupStorage.siteDir(MOCKUP_ID), path.join(expected, "site"));
	assert.equal(MockupStorage.ZIP_FILE, "source.zip");
});

test("どの構成でも使える(以前はlocalのときだけ有効だった)", () => {
	for (const backend of ["local", "s3", "gcs"]) {
		const MockupStorage = loadWith({
			DATA_DIR, STORAGE_BACKEND: backend,
			S3_BUCKET: "dummy-bucket", S3_REGION: "ap-northeast-1", GCS_BUCKET: "dummy-bucket"
		});
		assert.equal(MockupStorage.isEnabled(), true, `${backend} で使えない`);
	}
});

test("展開先は、原本がS3でも必ずローカルになる", () => {
	const MockupStorage = loadWith({
		DATA_DIR, STORAGE_BACKEND: "s3", S3_BUCKET: "dummy-bucket", S3_REGION: "ap-northeast-1"
	});
	// 1ページ開くたびに何十回も取りに行くため、展開後のものをS3から配信してはいけない
	assert.equal(MockupStorage.siteDir(MOCKUP_ID), path.join(DATA_DIR, "mockups", MOCKUP_ID, "site"));
});

test("S3のキーは文書と混ざらない(prefixが分かれている)", () => {
	const Storage = (() => {
		delete require.cache[require.resolve("../app/lib/storage.js")];
		process.env.STORAGE_BACKEND = "s3";
		process.env.S3_BUCKET = "dummy-bucket";
		process.env.S3_REGION = "ap-northeast-1";
		const loaded = require("../app/lib/storage.js");
		delete require.cache[require.resolve("../app/lib/storage.js")];
		return loaded;
	})();

	const documents = Storage.createStorage("/unused");
	const mockups = Storage.createStorage("/unused", {prefix: "mockups"});
	assert.equal(documents.prefix, "documents");
	assert.equal(mockups.prefix, "mockups");
	assert.notEqual(documents.prefix, mockups.prefix);
});

test("原本を扱う入り口は、待てる形になっている(awaitし忘れると書けていないまま応答する)", () => {
	const MockupStorage = loadWith({DATA_DIR, STORAGE_BACKEND: "local"});
	for (const name of ["writeFile", "readFile", "discard", "ensureSite"]) {
		assert.equal(MockupStorage[name].constructor.name, "AsyncFunction", `${name} が同期のまま`);
	}
});
