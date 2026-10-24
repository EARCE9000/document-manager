/*!
 * storage-probe.js : 試験から、文書とモックアップの原本の置き場所を直接のぞく・書き換える
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * テストサーバーと同じく STORAGE_BACKEND に従う。
 *   local: <DATA_DIR>/documents/<ID>/<名前>、<DATA_DIR>/mockups/<ID>/<名前>
 *   s3   : <S3_PREFIX>/<ID>/<名前>、<MOCKUP_STORAGE_PREFIX>/<ID>/<名前>(S3_ENDPOINT で MinIO なども可)
 *   gcs  : 未対応(supported が false。のぞく必要がある試験は飛ばす)
 * 「置き場所を直に壊したらどうなるか」を見る試験を、EC2(ローカルのディスク)と ECS(S3)の両方の形で流すため
 */

const fs = require("node:fs");
const path = require("node:path");
const {TEST_DATA_DIR} = require("./config.js");

const BACKEND = (process.env.STORAGE_BACKEND || "local").toLowerCase();
const KINDS = ["documents", "mockups"];

const assertKind = (kind) => {
	if (!KINDS.includes(kind)) throw new Error(`知らない種類: ${kind}`);
};

const local = () => {
	const fileOf = (kind, id, name) => path.join(TEST_DATA_DIR, kind, id, name);
	return {
		exists: async (kind, id, name) => fs.existsSync(fileOf(kind, id, name)),
		read: async (kind, id, name) => fs.readFileSync(fileOf(kind, id, name)),
		write: async (kind, id, name, body) => fs.writeFileSync(fileOf(kind, id, name), body),
		remove: async (kind, id, name) => fs.rmSync(fileOf(kind, id, name), {force: true}),
		modifiedAt: async (kind, id, name) => fs.statSync(fileOf(kind, id, name)).mtimeMs
	};
};

const s3 = () => {
	const sdk = require(path.join(__dirname, "..", "..", "app", "node_modules", "@aws-sdk", "client-s3"));
	const client = new sdk.S3Client({
		region: process.env.S3_REGION || process.env.AWS_REGION,
		...(process.env.S3_ENDPOINT ? {endpoint: process.env.S3_ENDPOINT, forcePathStyle: true} : {})
	});
	const Bucket = process.env.S3_BUCKET;
	const prefixes = {documents: process.env.S3_PREFIX || "documents", mockups: process.env.MOCKUP_STORAGE_PREFIX || "mockups"};
	const Key = (kind, id, name) => `${prefixes[kind]}/${id}/${name}`;
	const head = (kind, id, name) => client.send(new sdk.HeadObjectCommand({Bucket, Key: Key(kind, id, name)}));
	return {
		exists: async (kind, id, name) => head(kind, id, name).then(() => true, () => false),
		read: async (kind, id, name) => {
			const res = await client.send(new sdk.GetObjectCommand({Bucket, Key: Key(kind, id, name)}));
			return Buffer.from(await res.Body.transformToByteArray());
		},
		write: async (kind, id, name, body) => {
			await client.send(new sdk.PutObjectCommand({Bucket, Key: Key(kind, id, name), Body: body}));
		},
		remove: async (kind, id, name) => {
			await client.send(new sdk.DeleteObjectCommand({Bucket, Key: Key(kind, id, name)}));
		},
		// S3 の更新時刻は秒の単位。書き換えたかを見る試験は、1 秒あけてから比べること
		modifiedAt: async (kind, id, name) => (await head(kind, id, name)).LastModified.getTime()
	};
};

const impl = BACKEND === "local" ? local() : BACKEND === "s3" ? s3() : null;
const wrap = (fn) => async (kind, ...rest) => {
	assertKind(kind);
	if (impl == null) throw new Error(`STORAGE_BACKEND=${BACKEND} はのぞけない`);
	return impl[fn](kind, ...rest);
};

module.exports = {
	backend: BACKEND,
	supported: impl != null,
	// 更新時刻の細かさ(ミリ秒)。これより短い間に書き換えられると、時刻では見分けられない
	timeResolutionMs: BACKEND === "local" ? 0 : 1000,
	exists: wrap("exists"),
	read: wrap("read"),
	write: wrap("write"),
	remove: wrap("remove"),
	modifiedAt: wrap("modifiedAt")
};
