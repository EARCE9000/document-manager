/*!
 * storage.js : 文書ファイルの保存先を切り替えるストレージ抽象層
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * STORAGE_BACKEND環境変数で保存先を切り替える(既定はローカルディスク)。
 * 呼び出し側(server.js)はこのモジュールが export する共通インターフェースだけを見ればよく、
 * 実際の保存先がローカルディスクかS3かを意識しない。将来GCS等を追加する場合も、
 * 同じインターフェースを満たす実装をここに追加してSTORAGE_BACKENDの分岐に足すだけでよい。
 *
 * 共通インターフェース:
 *   writeFile(documentId, filename, buffer): Promise<void>
 *   readFile(documentId, filename): Promise<Buffer>
 *   exists(documentId, filename): Promise<boolean>
 *   streamToResponse(documentId, filename, res): Promise<void>
 *     (res.setHeaderでのContent-Type/Content-Disposition設定は呼び出し側の責務。
 *      ここではボディの転送のみを行う)
 *
 * モード切替は「これから保存する場所」を切り替えるだけであり、既存ファイルの
 * 別バックエンドへの自動移行は行わない(必要であれば別途移行スクリプトで対応する)。
 */

const path = require("path");
const fs = require("fs");
const logger = require("./logger.js")(path.basename(__filename));

const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || "local").toLowerCase();

/**
 * ローカルディスク実装。DATA_DIR/documents/<documentId>/<filename> に保存する
 * (従来のserver.js内のfs直接呼び出しをそのまま移植したもの)
 */
class LocalDiskStorage {
	constructor(documentsDir) {
		this.documentsDir = documentsDir;
	}

	_resolvePath(documentId, filename) {
		return path.join(this.documentsDir, documentId, filename);
	}

	async writeFile(documentId, filename, buffer) {
		const filePath = this._resolvePath(documentId, filename);
		await fs.promises.mkdir(path.dirname(filePath), {recursive: true});
		await fs.promises.writeFile(filePath, buffer);
	}

	async readFile(documentId, filename) {
		return fs.promises.readFile(this._resolvePath(documentId, filename));
	}

	async exists(documentId, filename) {
		try {
			await fs.promises.access(this._resolvePath(documentId, filename));
			return true;
		} catch {
			return false;
		}
	}

	// res.sendFileは絶対パスを要求するため、documentsDir自体が絶対パスであることが前提
	// (db.jsのDATA_DIR解決と同様、呼び出し元でpath.resolve済みのものを渡すこと)
	async streamToResponse(documentId, filename, res) {
		return new Promise((resolve, reject) => {
			res.sendFile(this._resolvePath(documentId, filename), (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}
}

/**
 * S3実装。バケット直下を S3_PREFIX/<documentId>/<filename> というキーで保存する。
 * 認証はAWS SDKの標準クレデンシャルチェーン(IAMロール、環境変数、共有設定ファイル等)に従う。
 * S3_ENDPOINTを指定すると、MinIO等のS3互換サービスにも接続できる。
 */
class S3Storage {
	constructor({bucket, region, prefix, endpoint}) {
		const {S3Client} = require("@aws-sdk/client-s3");
		this.bucket = bucket;
		this.prefix = prefix;
		this.client = new S3Client({
			region,
			...(endpoint ? {endpoint, forcePathStyle: true} : {})
		});
	}

	_key(documentId, filename) {
		return `${this.prefix}/${documentId}/${filename}`;
	}

	async writeFile(documentId, filename, buffer) {
		const {PutObjectCommand} = require("@aws-sdk/client-s3");
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: this._key(documentId, filename),
			Body: buffer
		}));
	}

	async readFile(documentId, filename) {
		const {GetObjectCommand} = require("@aws-sdk/client-s3");
		const result = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: this._key(documentId, filename)
		}));
		const chunks = [];
		for await (const chunk of result.Body) chunks.push(chunk);
		return Buffer.concat(chunks);
	}

	async exists(documentId, filename) {
		const {HeadObjectCommand} = require("@aws-sdk/client-s3");
		try {
			await this.client.send(new HeadObjectCommand({
				Bucket: this.bucket,
				Key: this._key(documentId, filename)
			}));
			return true;
		} catch (err) {
			if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
			throw err;
		}
	}

	async streamToResponse(documentId, filename, res) {
		const {GetObjectCommand} = require("@aws-sdk/client-s3");
		const result = await this.client.send(new GetObjectCommand({
			Bucket: this.bucket,
			Key: this._key(documentId, filename)
		}));
		await new Promise((resolve, reject) => {
			result.Body.pipe(res);
			result.Body.on("error", reject);
			res.on("finish", resolve);
		});
	}
}

const createStorage = (documentsDir) => {
	if (STORAGE_BACKEND === "s3") {
		const bucket = process.env.S3_BUCKET;
		const region = process.env.S3_REGION;
		if (!bucket || !region) {
			throw new Error("STORAGE_BACKEND=s3 の場合、S3_BUCKET と S3_REGION の指定が必須です");
		}
		logger.info({bucket, region, prefix: process.env.S3_PREFIX || "documents", endpoint: process.env.S3_ENDPOINT || null}, "storage backend: s3");
		return new S3Storage({
			bucket,
			region,
			prefix: process.env.S3_PREFIX || "documents",
			endpoint: process.env.S3_ENDPOINT || null
		});
	}
	if (STORAGE_BACKEND !== "local") {
		logger.warn({STORAGE_BACKEND}, "未知のSTORAGE_BACKENDが指定されたため、localにフォールバックします");
	}
	logger.info({documentsDir}, "storage backend: local");
	return new LocalDiskStorage(documentsDir);
};

module.exports = {STORAGE_BACKEND, createStorage};
