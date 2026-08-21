/*!
 * vector-search.js : Weaviate によるベクトル(意味)検索
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * FTS5によるキーワード全文検索(db.js)を置き換えるものではなく、別コンテナで動く
 * Weaviate(OSS)を使った意味検索を追加の検索手段として提供する。Embeddingの計算は
 * Weaviate側のベクトライザーモジュールに任せるため、このモジュールはテキストの
 * 登録・削除・検索の仲介のみを行う。既定は自己ホストのtext2vec-transformers
 * (さらに別コンテナの推論サーバー、外部APIキー不要)だが、WEAVIATE_VECTORIZER環境変数で
 * text2vec-cohere/text2vec-openai等の外部API方式にも切り替えられる(下記VECTORIZERS参照)。
 * 切り替えは新規作成するWeaviateコレクションにのみ反映される。既に文書が索引済みの状態で
 * 切り替えた場合は、Weaviate側でコレクションを削除してから起動し直し、「ベクトル索引」画面の
 * 「全件を再索引」で作り直すこと(異なるベクトライザーのベクトルは互換性が無いため)。
 *
 * 検索結果の並び替え(リランキング)も任意機能。WEAVIATE_RERANKER=reranker-transformersを
 * 指定すると、自己ホストのクロスエンコーダ(LLMではない、関連度スコアだけを返す専用モデル。
 * さらに別コンテナの推論サーバー、外部APIキー不要)で検索結果を再スコアリングする。
 * こちらも新規作成するコレクションにのみ反映されるため、有効化前に索引済みの文書がある場合は
 * ベクトライザー切り替え時と同様にコレクション削除→「全件を再索引」が必要
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
const db = require("./db.js");

const WEAVIATE_URL = process.env.WEAVIATE_URL || "";
// WeaviateはREST(WEAVIATE_URLのポート)とは別にgRPCポートを持つ(v3クライアントは
// バッチ登録・検索にgRPCを使う)。docker-compose.yml側のweaviateサービスの既定ポートに合わせる
const WEAVIATE_GRPC_PORT = Number(process.env.WEAVIATE_GRPC_PORT || 50051);
// 使用するベクトライザーモジュール名(Weaviate側でENABLE_MODULESに含めておく必要がある)。
// 未知の値が指定された場合はtext2vec-transformers(既定)にフォールバックする
const WEAVIATE_VECTORIZER = process.env.WEAVIATE_VECTORIZER || "text2vec-transformers";

const COLLECTION_NAME = "DocumentChunk";

// サポートするベクトライザーと、対応する設定の組み立て方・APIキーのヘッダー名。
// 外部API方式(cohere/openai)はWeaviateコンテナ自体にAPIキーを持たせず、
// このアプリのプロセス側の環境変数からリクエストヘッダーとして都度渡す
// (シークレットの置き場所をこのアプリ1箇所に集約するため)
const VECTORIZERS = {
	"text2vec-transformers": {
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecTransformers({vectorizeCollectionName: false}),
		apiKeyEnv: null,
		apiKeyHeader: null
	},
	"text2vec-cohere": {
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecCohere({vectorizeCollectionName: false}),
		apiKeyEnv: "COHERE_APIKEY",
		apiKeyHeader: "X-Cohere-Api-Key"
	},
	"text2vec-openai": {
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecOpenAI({vectorizeCollectionName: false}),
		apiKeyEnv: "OPENAI_APIKEY",
		apiKeyHeader: "X-OpenAI-Api-Key"
	}
};

const resolveVectorizer = () => {
	const vectorizer = VECTORIZERS[WEAVIATE_VECTORIZER];
	if (vectorizer == null) {
		logger.warn({WEAVIATE_VECTORIZER}, "::resolveVectorizer: 未知のWEAVIATE_VECTORIZERが指定されたため、text2vec-transformersにフォールバックします");
		return VECTORIZERS["text2vec-transformers"];
	}
	return vectorizer;
};

// リランキング(検索結果の並び替え)は任意機能。既定(未設定)は無効で、従来通りベクトル距離のみで
// 順位付けする。"reranker-transformers"を指定すると、自己ホストのクロスエンコーダ
// (文章生成をしないLLMではない専用の小さなモデル。Weaviate公式のOSSコンテナ)で
// 検索結果を再スコアリングし、より精度の高い順位に並び替える。外部APIキーは不要
//
// ⚠️自己責任機能: GPU無し実機で実測したところ、候補1件あたり約400〜550msかかった。
// searchAPIのlimit×3件(既定limit=20なら60件)を再スコアリングすると25〜30秒かかり、
// Weaviateの30秒gRPCタイムアウトを超えて検索結果が空で返ることがある(文書の総数には
// 依存せず、候補数だけで決まる)。現状、候補数の削減・軽量モデルへの変更・タイムアウト時の
// エラー明示化はいずれも未対応。有効化する場合は呼び出し側でlimitを小さめにするなど、
// 利用者の判断で候補数を絞ること
const WEAVIATE_RERANKER = process.env.WEAVIATE_RERANKER || "";
const isRerankerEnabled = () => WEAVIATE_RERANKER === "reranker-transformers";

// 外部API方式のベクトライザー用に、APIキーをリクエストヘッダーとして組み立てる
// (text2vec-transformersのようにAPIキー不要な方式ではapiKeyEnvがnullのため何もしない)
const buildConnectionHeaders = () => {
	const vectorizer = resolveVectorizer();
	if (vectorizer.apiKeyEnv == null) {
		return {};
	}
	const apiKey = process.env[vectorizer.apiKeyEnv] || "";
	if (apiKey === "") {
		logger.warn({WEAVIATE_VECTORIZER, apiKeyEnv: vectorizer.apiKeyEnv}, "::buildConnectionHeaders: APIキーが未設定です");
		return {};
	}
	return {[vectorizer.apiKeyHeader]: apiKey};
};

// 多言語text2vec-transformersモデルの最大シーケンス長を超えて意味が失われないよう、
// 本文をチャンク単位で登録・検索する(文字数ベースの簡易分割。厳密なトークン数ではない)。
// 環境変数を既定値としつつ、「ベクトル索引」画面(admin限定)からDBへ保存した値があれば
// そちらを優先する(getChunkSettings参照)。変更は新規に索引付けする文書からのみ反映されるため、
// 既存文書に遡って適用したい場合は変更後に「全件を再索引」を行うこと
const CHUNK_SIZE_DEFAULT = Number(process.env.VECTOR_CHUNK_SIZE || 400);
const CHUNK_OVERLAP_DEFAULT = Number(process.env.VECTOR_CHUNK_OVERLAP || 50);
const CHUNK_SIZE_MIN = 50;
const CHUNK_SIZE_MAX = 4000;

// 文書ごとの索引状態(documents.vector_index_status: NULL=未処理/'ok'/'error')。
// 「失敗しているものを再実行する」画面(index.htmlのベクトル索引モーダル)のために、
// 各文書の索引結果をdocumentsテーブルに直接記録する(audit-log.js等と同様、このモジュールが
// 自分の関心事に関わる列の読み書きを担う)
const updateVectorIndexStatus = db.prepare(`
	UPDATE documents SET vector_index_status = @status, vector_index_error = @error, vector_indexed_at = @indexed_at WHERE id = @id
`);
// チャンク分割方法・埋め込みモデルの変更後は、既に'ok'で成功している文書も含めて
// 再索引が必要になり得るため、失敗した文書だけでなくアクティブな全文書の状態を返せるようにする
const selectAllDocumentStatuses = db.prepare(`
	SELECT id, entry_file, vector_index_status, vector_index_error, vector_indexed_at
	FROM documents
	WHERE deleted_at IS NULL
	ORDER BY entry_file
`);
const selectDocumentForIndexing = db.prepare(`
	SELECT id, content_text FROM documents WHERE id = ? AND deleted_at IS NULL
`);
const selectVectorIndexStatus = db.prepare(`
	SELECT vector_index_status, vector_index_error, vector_indexed_at FROM documents WHERE id = ?
`);

// チャンク分割設定(GUIからの上書き)。id=1固定のシングルトン行で、NULLの間は環境変数の既定値を使う
const selectChunkSettings = db.prepare(`SELECT chunk_size, chunk_overlap, updated_by, updated_at FROM vector_search_settings WHERE id = 1`);
const upsertChunkSettings = db.prepare(`
	INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, updated_by, updated_at)
	VALUES (1, @chunk_size, @chunk_overlap, @updated_by, @updated_at)
	ON CONFLICT(id) DO UPDATE SET chunk_size = excluded.chunk_size, chunk_overlap = excluded.chunk_overlap, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`);

const isEnabled = () => WEAVIATE_URL !== "";

/**
 * 現在有効なチャンク分割設定を返す。GUIから保存された値(vector_search_settings)があれば
 * それを優先し、無ければ環境変数(VECTOR_CHUNK_SIZE/VECTOR_CHUNK_OVERLAP)の既定値を使う
 */
const getChunkSettings = () => {
	const row = selectChunkSettings.get();
	return {
		chunkSize: row?.chunk_size ?? CHUNK_SIZE_DEFAULT,
		chunkOverlap: row?.chunk_overlap ?? CHUNK_OVERLAP_DEFAULT,
		isCustom: row?.chunk_size != null,
		updatedBy: row?.updated_by ?? null,
		updatedAt: row?.updated_at ?? null,
		defaultChunkSize: CHUNK_SIZE_DEFAULT,
		defaultChunkOverlap: CHUNK_OVERLAP_DEFAULT
	};
};

/**
 * チャンク分割設定をGUIから上書き保存する。新規に索引付けする文書からのみ反映され、
 * 既存の索引付け済み文書には遡って適用されない(呼び出し元で「全件を再索引」を促すこと)
 */
const updateChunkSettings = ({chunkSize, chunkOverlap}, updatedBy) => {
	if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_SIZE_MIN || chunkSize > CHUNK_SIZE_MAX) {
		throw new Error(`chunkSizeは${CHUNK_SIZE_MIN}〜${CHUNK_SIZE_MAX}の整数で指定してください`);
	}
	if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
		throw new Error("chunkOverlapは0以上かつchunkSize未満の整数で指定してください");
	}
	upsertChunkSettings.run({chunk_size: chunkSize, chunk_overlap: chunkOverlap, updated_by: updatedBy, updated_at: new Date().toISOString()});
	return getChunkSettings();
};

/**
 * チャンク分割設定を環境変数の既定値に戻す(GUIでの上書きを解除する)
 */
const resetChunkSettings = () => {
	upsertChunkSettings.run({chunk_size: null, chunk_overlap: null, updated_by: null, updated_at: null});
	return getChunkSettings();
};

let clientPromise = null;

const ensureCollection = async (weaviate, client) => {
	if (await client.collections.exists(COLLECTION_NAME)) {
		return;
	}
	await client.collections.create({
		name: COLLECTION_NAME,
		vectorizers: resolveVectorizer().configure(weaviate),
		...(isRerankerEnabled() ? {reranker: weaviate.configure.reranker.transformers()} : {}),
		properties: [
			{name: "documentId", dataType: weaviate.dataType.TEXT, skipVectorization: true, indexFilterable: true},
			{name: "chunkIndex", dataType: weaviate.dataType.INT, skipVectorization: true},
			{name: "text", dataType: weaviate.dataType.TEXT}
		]
	});
	logger.info({collection: COLLECTION_NAME, vectorizer: WEAVIATE_VECTORIZER, reranker: isRerankerEnabled() ? WEAVIATE_RERANKER : null}, "::ensureCollection: Weaviateコレクションを作成しました");
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
				headers: buildConnectionHeaders(),
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

// 本文を段落境界を優先しつつ約chunkSize文字ごとに分割する。段落自体がchunkSizeを
// 超える場合はchunkOverlap分重ねながら固定長で分割する。chunkSize/chunkOverlapを
// 省略した場合は現在有効な設定(getChunkSettings参照)を使う
const chunkText = (text, chunkSize, chunkOverlap) => {
	if (chunkSize == null || chunkOverlap == null) {
		const settings = getChunkSettings();
		chunkSize = chunkSize ?? settings.chunkSize;
		chunkOverlap = chunkOverlap ?? settings.chunkOverlap;
	}
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
		if (paragraph.length > chunkSize) {
			flush();
			for (let i = 0; i < paragraph.length; i += chunkSize - chunkOverlap) {
				chunks.push(paragraph.slice(i, i + chunkSize));
			}
			continue;
		}
		if (current !== "" && current.length + paragraph.length + 2 > chunkSize) {
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

// 索引結果(成功/失敗)をdocuments.vector_index_status等へ記録する。記録自体の失敗は
// 索引処理の成否に影響させない(ログのみ)
const recordIndexResult = (documentId, status, error) => {
	try {
		updateVectorIndexStatus.run({id: documentId, status, error, indexed_at: status === "ok" ? new Date().toISOString() : null});
	} catch (err) {
		logger.error({err, documentId}, "::recordIndexResult");
	}
};

/**
 * 指定文書のチャンクを登録し直す(既存チャンクは一旦全削除してから再登録する)。
 * 成功/失敗をdocuments.vector_index_status等へ記録し、「失敗した文書の再実行」画面から
 * 状態を確認できるようにする。Weaviate未設定時は何もしない(状態も更新しない)。
 * エラー時も例外は投げず、呼び出し元(アップロード/復元処理)を失敗させない
 */
const indexDocument = async (documentId, contentText) => {
	if (!isEnabled()) {
		return;
	}
	if (contentText == null || contentText.trim() === "") {
		// 索引対象の本文が無い(画像等)。エラーではないのでok扱いにする
		recordIndexResult(documentId, "ok", null);
		return;
	}
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		await removeDocumentChunks(collection, documentId);
		const chunks = chunkText(contentText);
		if (chunks.length > 0) {
			await collection.data.insertMany(chunks.map((text, chunkIndex) => ({documentId, chunkIndex, text})));
		}
		recordIndexResult(documentId, "ok", null);
	} catch (err) {
		logger.error({err, documentId}, "::indexDocument");
		recordIndexResult(documentId, "error", String(err?.message || err));
	}
};

/**
 * 指定文書のチャンクを削除する(論理削除時に呼ぶ。ベストエフォート)。索引状態も未処理に戻す
 */
const removeDocument = async (documentId) => {
	if (!isEnabled()) {
		return;
	}
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		await removeDocumentChunks(collection, documentId);
		recordIndexResult(documentId, null, null);
	} catch (err) {
		logger.error({err, documentId}, "::removeDocument");
	}
};

/**
 * 意味検索。文書IDごとに最もスコアの良いチャンク1件へ集約して返す。
 * リランキング有効時はクロスエンコーダのrerankScore(大きいほど良い)で、無効時は
 * ベクトル距離(小さいほど近い)で順位付けする。
 * Weaviate未設定時はnull(呼び出し元で503を返すため)、エラー時は空配列を返す
 */
const search = async (query, limit) => {
	if (!isEnabled()) {
		return null;
	}
	const useReranker = isRerankerEnabled();
	try {
		const client = await getClient();
		const collection = client.collections.use(COLLECTION_NAME);
		// 同一文書の複数チャンクがヒットする分を見込んで多めに取得し、文書単位に集約後にlimit件へ絞る
		const result = await collection.query.nearText(query, {
			limit: limit * 3,
			returnMetadata: useReranker ? ["distance", "rerankScore"] : ["distance"],
			...(useReranker ? {rerank: {property: "text", query}} : {})
		});

		const bestByDocument = new Map();
		for (const obj of result.objects) {
			const documentId = obj.properties.documentId;
			const distance = obj.metadata?.distance ?? Number.POSITIVE_INFINITY;
			const rerankScore = obj.metadata?.rerankScore ?? null;
			const existing = bestByDocument.get(documentId);
			const isBetter = existing == null || (useReranker ? rerankScore > existing.rerankScore : distance < existing.distance);
			if (isBetter) {
				bestByDocument.set(documentId, {documentId, distance, rerankScore, snippet: obj.properties.text});
			}
		}
		const sorted = [...bestByDocument.values()].sort((a, b) => (useReranker ? b.rerankScore - a.rerankScore : a.distance - b.distance));
		return sorted.slice(0, limit);
	} catch (err) {
		logger.error({err, query}, "::search");
		return [];
	}
};

// Weaviate側に既にチャンクが存在する文書IDの一覧を取得する(バックフィル時に、既に索引済みの
// 文書を除外するために使う。vectorを含まないプロパティのみ取得するため軽量)
const getIndexedDocumentIds = async () => {
	const client = await getClient();
	const collection = client.collections.use(COLLECTION_NAME);
	const ids = new Set();
	for await (const obj of collection.iterator({returnProperties: ["documentId"]})) {
		ids.add(obj.properties.documentId);
	}
	return ids;
};

/**
 * サーバー起動時に呼ぶ差分バックフィル。db.jsのdocuments_ftsバックフィルと同じ考え方で、
 * 既にWeaviate側にチャンクが存在する文書はスキップし、まだ存在しない文書(=このベクトル検索
 * 機能を導入する前にアップロードされた文書)だけをindexDocument()で登録する。
 * documentsは{id, content_text}の配列(呼び出し元でアクティブな文書のみに絞り込むこと)。
 * サーバー起動をブロックしないよう、呼び出し元ではawaitせず非同期に流すことを想定している
 */
const backfillMissingDocuments = async (documents) => {
	if (!isEnabled() || documents.length === 0) {
		return;
	}
	try {
		const indexedIds = await getIndexedDocumentIds();
		const targets = documents.filter((doc) => !indexedIds.has(doc.id));
		if (targets.length === 0) {
			return;
		}
		logger.info({count: targets.length}, "::backfillMissingDocuments: 未登録の文書をベクトル検索インデックスへ登録します");
		for (const doc of targets) {
			await indexDocument(doc.id, doc.content_text);
		}
		logger.info({count: targets.length}, "::backfillMissingDocuments: 登録が完了しました");
	} catch (err) {
		logger.error(err, "::backfillMissingDocuments");
	}
};

/**
 * アクティブな全文書の索引状態(status: null=未処理 / 'ok' / 'error')を返す。
 * 「ベクトル索引」画面(index.html)から呼ばれる。失敗した文書の再実行だけでなく、
 * チャンク分割方法や埋め込みモデルを変更した際に成功済みの文書も含めて
 * 再索引したいケースに対応するため、'ok'の文書も返す
 */
const listIndexStatuses = () => selectAllDocumentStatuses.all().map((row) => ({
	id: row.id,
	entryFile: row.entry_file,
	status: row.vector_index_status,
	error: row.vector_index_error,
	indexedAt: row.vector_indexed_at
}));

/**
 * 指定文書を再度索引付けする(失敗した文書の再実行用)。対象が存在しない/
 * 既にアーカイブ済みの場合はnullを返す
 */
const retryDocument = async (documentId) => {
	const row = selectDocumentForIndexing.get(documentId);
	if (row == null) {
		return null;
	}
	await indexDocument(row.id, row.content_text);
	const statusRow = selectVectorIndexStatus.get(documentId);
	return {
		id: documentId,
		status: statusRow?.vector_index_status ?? null,
		error: statusRow?.vector_index_error ?? null,
		indexedAt: statusRow?.vector_indexed_at ?? null
	};
};

module.exports = {
	isEnabled, indexDocument, removeDocument, search, chunkText, backfillMissingDocuments, listIndexStatuses, retryDocument,
	getChunkSettings, updateChunkSettings, resetChunkSettings
};
