/*!
 * vector-search.js : Weaviate によるベクトル(意味)検索
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * FTS5によるキーワード全文検索(db.js)を置き換えるものではなく、別コンテナで動く
 * Weaviate(OSS)を使った意味検索を追加の検索手段として提供する。Embeddingの計算は
 * Weaviate側のtext2vec-transformersモジュール(さらに別コンテナの推論サーバー)に
 * 任せるため、このモジュールはテキストの登録・削除・検索の仲介のみを行う。
 *
 * WEAVIATE_URL環境変数が未設定の間は完全に無効化される(任意機能)。既存の単一コンテナ
 * 運用(docker run)には影響を与えず、Weaviateが導入されていない/落ちている場合でも
 * 文書のアップロード・削除・復元自体は失敗させない(索引更新はベストエフォート)。
 *
 * weaviate-client(公式JS/TSクライアント)はESM専用パッケージで、CJSビルドも内部で
 * ESM専用のuuidパッケージをrequireしており`require("weaviate-client")`は失敗する
 * (ERR_REQUIRE_ESM)。server.js内のmhtml-to-html(buildPreviewFile参照)と同様に、
 * dynamic import()で遅延ロードする。
 */

const path = require("path");
const logger = require("./logger.js")(path.basename(__filename));

const WEAVIATE_URL = process.env.WEAVIATE_URL || "";
// WeaviateはREST(WEAVIATE_URLのポート)とは別にgRPCポートを持つ(v3クライアントは
// バッチ登録・検索にgRPCを使う)。docker-compose.yml側のweaviateサービスの既定ポートに合わせる
const WEAVIATE_GRPC_PORT = Number(process.env.WEAVIATE_GRPC_PORT || 50051);

const COLLECTION_NAME = "DocumentChunk";

// 多言語text2vec-transformersモデルの最大シーケンス長を超えて意味が失われないよう、
// 本文をチャンク単位で登録・検索する(文字数ベースの簡易分割。厳密なトークン数ではない)
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 50;

const isEnabled = () => WEAVIATE_URL !== "";

let clientPromise = null;

const ensureCollection = async (weaviate, client) => {
	if (await client.collections.exists(COLLECTION_NAME)) {
		return;
	}
	await client.collections.create({
		name: COLLECTION_NAME,
		vectorizers: weaviate.configure.vectorizer.text2VecTransformers({vectorizeCollectionName: false}),
		properties: [
			{name: "documentId", dataType: weaviate.dataType.TEXT, skipVectorization: true, indexFilterable: true},
			{name: "chunkIndex", dataType: weaviate.dataType.INT, skipVectorization: true},
			{name: "text", dataType: weaviate.dataType.TEXT}
		]
	});
	logger.info({collection: COLLECTION_NAME}, "::ensureCollection: Weaviateコレクションを作成しました");
};

// Weaviateクライアントの初期化(初回呼び出し時のみ接続・コレクション確認を行い、以降は使い回す)。
// 接続に失敗した場合は次回呼び出し時に再試行できるようキャッシュを破棄する
const getClient = () => {
	if (clientPromise == null) {
		clientPromise = (async () => {
			const weaviate = await import("weaviate-client");
			const url = new URL(WEAVIATE_URL);
			const httpSecure = url.protocol === "https:";
			const client = await weaviate.connectToCustom({
				httpHost: url.hostname,
				httpPort: Number(url.port || (httpSecure ? 443 : 80)),
				httpSecure,
				grpcHost: url.hostname,
				grpcPort: WEAVIATE_GRPC_PORT,
				grpcSecure: httpSecure,
				skipInitChecks: true
			});
			await ensureCollection(weaviate, client);
			return client;
		})();
		clientPromise.catch((err) => {
			logger.error(err, "::getClient: Weaviateへの接続に失敗しました");
			clientPromise = null;
		});
	}
	return clientPromise;
};

// 本文を段落境界を優先しつつ約CHUNK_SIZE文字ごとに分割する。段落自体がCHUNK_SIZEを
// 超える場合はCHUNK_OVERLAP分重ねながら固定長で分割する
const chunkText = (text) => {
	const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== "");
	const chunks = [];
	let current = "";

	const flush = () => {
		if (current.trim() !== "") {
			chunks.push(current.trim());
		}
		current = "";
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length > CHUNK_SIZE) {
			flush();
			for (let i = 0; i < paragraph.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
				chunks.push(paragraph.slice(i, i + CHUNK_SIZE));
			}
			continue;
		}
		if (current !== "" && current.length + paragraph.length + 2 > CHUNK_SIZE) {
			flush();
		}
		current = current === "" ? paragraph : `${current}\n\n${paragraph}`;
	}
	flush();

	return chunks;
};

const removeDocumentChunks = async (collection, documentId) => {
	await collection.data.deleteMany(collection.filter.byProperty("documentId").equal(documentId));
};

/**
 * 指定文書のチャンクを登録し直す(既存チャンクは一旦全削除してから再登録する)。
 * contentTextが空/nullの場合は何もしない。Weaviate未設定・エラー時は静かに諦める
 * (呼び出し元のアップロード/復元処理自体は失敗させない)
 */
const indexDocument = async (documentId, contentText) => {
	if (!isEnabled() || contentText == null || contentText.trim() === "") {
		return;
	}
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		await removeDocumentChunks(collection, documentId);
		const chunks = chunkText(contentText);
		if (chunks.length === 0) {
			return;
		}
		await collection.data.insertMany(chunks.map((text, chunkIndex) => ({documentId, chunkIndex, text})));
	} catch (err) {
		logger.error({err, documentId}, "::indexDocument");
	}
};

/**
 * 指定文書のチャンクを削除する(論理削除時に呼ぶ。ベストエフォート)
 */
const removeDocument = async (documentId) => {
	if (!isEnabled()) {
		return;
	}
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		await removeDocumentChunks(collection, documentId);
	} catch (err) {
		logger.error({err, documentId}, "::removeDocument");
	}
};

/**
 * 意味検索。文書IDごとに最もスコアの良いチャンク1件へ集約し、距離(小さいほど近い)昇順で返す。
 * Weaviate未設定時はnull(呼び出し元で503を返すため)、エラー時は空配列を返す
 */
const search = async (query, limit) => {
	if (!isEnabled()) {
		return null;
	}
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		// 同一文書の複数チャンクがヒットする分を見込んで多めに取得し、文書単位に集約後にlimit件へ絞る
		const result = await collection.query.nearText(query, {
			limit: limit * 3,
			returnMetadata: ["distance"]
		});

		const bestByDocument = new Map();
		for (const obj of result.objects) {
			const documentId = obj.properties.documentId;
			const distance = obj.metadata?.distance ?? Number.POSITIVE_INFINITY;
			const existing = bestByDocument.get(documentId);
			if (existing == null || distance < existing.distance) {
				bestByDocument.set(documentId, {documentId, distance, snippet: obj.properties.text});
			}
		}
		return [...bestByDocument.values()].sort((a, b) => a.distance - b.distance).slice(0, limit);
	} catch (err) {
		logger.error({err, query}, "::search");
		return [];
	}
};

module.exports = {isEnabled, indexDocument, removeDocument, search, chunkText};
