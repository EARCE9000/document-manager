/*!
 * vector-search.js : Weaviate によるベクトル(意味)検索
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * FTS5によるキーワード全文検索(db.js)を置き換えるものではなく、別コンテナで動く
 * Weaviate(OSS)を使った意味検索を追加の検索手段として提供する。Embeddingの計算は
 * Weaviate側のベクトライザーモジュールに任せるため、このモジュールはテキストの
 * 登録・削除・検索の仲介のみを行う。既定は自己ホストのtext2vec-transformers
 * (さらに別コンテナの推論サーバー、外部APIキー不要)だが、text2vec-cohere(Cohere SaaS)/
 * text2vec-openai/text2vec-aws(AWS Bedrock経由)等の外部API・クラウド方式にも切り替えられる
 * (下記VECTORIZERS参照)。既定値はWEAVIATE_VECTORIZER環境変数で指定し、「ベクトル索引」画面
 * (admin限定)からGUIで上書きもできる(getVectorizerSetting/updateVectorizerSetting参照)。
 * 認証情報(APIキー・AWSクレデンシャル)は常に環境変数から読み、DBには保存しない(GUIは
 * 「どのベクトライザーを使うか」の選択と、必要な環境変数が揃っているかの表示のみを担う)。
 * 切り替えは新規作成するWeaviateコレクションにのみ反映されるため、GUIから切り替えると
 * 既存コレクションを自動的に削除し、全文書の索引状態を未処理へ戻す(異なるベクトライザーの
 * ベクトルは互換性が無いため。切り替え後は「全件を再索引」で作り直すこと)。
 *
 * WEAVIATE_URL環境変数が未設定の間は完全に無効化される(任意機能)。既存の単一コンテナ
 * 運用(docker run)には影響を与えず、Weaviateが導入されていない/落ちている場合でも
 * 文書のアップロード・削除・復元自体は失敗させない(索引更新はベストエフォート)。
 *
 * indexDocument/removeDocumentは埋め込み計算に数秒かかるため、server.js側ではawaitせず
 * バックグラウンドで実行する(アップロード等のAPI応答をブロックしないため)。同一文書IDへの
 * 操作の実行順序はこのモジュール内部で直列化して保証する(runSerialized参照)。
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
// 使用するベクトライザーモジュール名(Weaviate側でENABLE_MODULESに含めておく必要がある)の既定値。
// 未知の値が指定された場合はtext2vec-transformers(既定)にフォールバックする。
// 「ベクトル索引」画面(admin限定)からDBへ保存した値があればそちらを優先する(getVectorizerSetting参照)
const WEAVIATE_VECTORIZER_DEFAULT = process.env.WEAVIATE_VECTORIZER || "text2vec-transformers";
// AWS Bedrock経由のベクトライザー(text2vec-aws, service: "bedrock")用の設定。
// リージョンは必須。モデルは既定でCohereの多言語埋め込みモデル(Titan等に変更も可能)
const AWS_BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || "";
const AWS_BEDROCK_MODEL = process.env.AWS_BEDROCK_MODEL || "cohere.embed-multilingual-v3";

const COLLECTION_NAME = "DocumentChunk";

// サポートするベクトライザーと、対応する設定の組み立て方・認証情報のヘッダー名・GUI表示用ラベル。
// 外部API/クラウド方式(cohere/openai/aws)はWeaviateコンテナ自体に認証情報を持たせず、
// このアプリのプロセス側の環境変数からリクエストヘッダーとして都度渡す
// (シークレットの置き場所をこのアプリ1箇所に集約するため。DBには保存しない)。
// requiredEnvは、この方式を使うために設定されているべき環境変数の一覧(GUI上で「未設定」の
// 判定・切り替え時のバリデーションに使う)。credentialsはrequiredEnvのうち実際にヘッダーとして
// 送るものだけを対象とする(AWSのregionのようにヘッダーではなくconfigure側で使うものは含まない)
const VECTORIZERS = {
	"text2vec-transformers": {
		label: "自己ホスト (text2vec-transformers)",
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecTransformers({vectorizeCollectionName: false}),
		requiredEnv: [],
		credentials: []
	},
	"text2vec-cohere": {
		label: "Cohere (SaaS)",
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecCohere({vectorizeCollectionName: false}),
		requiredEnv: ["COHERE_APIKEY"],
		credentials: [{envVar: "COHERE_APIKEY", header: "X-Cohere-Api-Key"}]
	},
	"text2vec-openai": {
		label: "OpenAI",
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecOpenAI({vectorizeCollectionName: false}),
		requiredEnv: ["OPENAI_APIKEY"],
		credentials: [{envVar: "OPENAI_APIKEY", header: "X-OpenAI-Api-Key"}]
	},
	"text2vec-aws": {
		label: `Cohere (AWS Bedrock, ${AWS_BEDROCK_MODEL})`,
		configure: (weaviate) => weaviate.configure.vectorizer.text2VecAWS({
			vectorizeCollectionName: false,
			service: "bedrock",
			region: AWS_BEDROCK_REGION,
			model: AWS_BEDROCK_MODEL
		}),
		requiredEnv: ["AWS_BEDROCK_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
		credentials: [
			{envVar: "AWS_ACCESS_KEY_ID", header: "X-AWS-Access-Key"},
			{envVar: "AWS_SECRET_ACCESS_KEY", header: "X-AWS-Secret-Key"}
		]
	}
};

// 指定したベクトライザーが実際に使える状態か(requiredEnvが全て設定されているか)を返す。
// GUIの選択肢表示・切り替え時のバリデーションの両方で使う
const isVectorizerConfigured = (key) => {
	const vectorizer = VECTORIZERS[key];
	if (vectorizer == null) {
		return false;
	}
	return vectorizer.requiredEnv.every((envVar) => (process.env[envVar] || "") !== "");
};

const resolveVectorizer = () => {
	const key = getVectorizerSetting().vectorizer;
	const vectorizer = VECTORIZERS[key];
	if (vectorizer == null) {
		logger.warn({vectorizer: key}, "::resolveVectorizer: 未知のベクトライザーが指定されたため、text2vec-transformersにフォールバックします");
		return VECTORIZERS["text2vec-transformers"];
	}
	return vectorizer;
};

// 外部API/クラウド方式のベクトライザー用に、認証情報をリクエストヘッダーとして組み立てる
// (text2vec-transformersのように認証情報が不要な方式ではcredentialsが空のため何もしない)
const buildConnectionHeaders = () => {
	const vectorizer = resolveVectorizer();
	const headers = {};
	for (const {envVar, header} of vectorizer.credentials) {
		const value = process.env[envVar] || "";
		if (value === "") {
			logger.warn({envVar}, "::buildConnectionHeaders: 認証情報の環境変数が未設定です");
			continue;
		}
		headers[header] = value;
	}
	return headers;
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
// 'processing'はプロセス内メモリのキュー(runSerialized/runEmbeddingExclusive)が進行中で
// あることを前提にした状態のため、サーバーの強制終了(クラッシュ・強制停止)を挟むとキューの
// 情報自体が失われ、DBにだけ'processing'が残って永久に「処理中」と表示され続けてしまう。
// 起動時に必ずクリンアップ(未処理へ戻す)して、次回の索引付け/バックフィルで再処理させる
const resetStaleProcessingStatus = db.prepare(`
	UPDATE documents SET vector_index_status = NULL, vector_index_error = NULL WHERE vector_index_status = 'processing'
`);

// チャンク分割設定(GUIからの上書き)。id=1固定のシングルトン行で、NULLの間は環境変数の既定値を使う
const selectChunkSettings = db.prepare(`SELECT chunk_size, chunk_overlap, updated_by, updated_at FROM vector_search_settings WHERE id = 1`);
const upsertChunkSettings = db.prepare(`
	INSERT INTO vector_search_settings (id, chunk_size, chunk_overlap, updated_by, updated_at)
	VALUES (1, @chunk_size, @chunk_overlap, @updated_by, @updated_at)
	ON CONFLICT(id) DO UPDATE SET chunk_size = excluded.chunk_size, chunk_overlap = excluded.chunk_overlap, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`);

// ベクトライザー選択(GUIからの上書き)。id=1固定のシングルトン行(チャンク分割設定と共有)で、
// NULLの間は環境変数(WEAVIATE_VECTORIZER)の既定値を使う
const selectVectorizerSetting = db.prepare(`SELECT vectorizer, updated_by, updated_at FROM vector_search_settings WHERE id = 1`);
const upsertVectorizerSetting = db.prepare(`
	INSERT INTO vector_search_settings (id, vectorizer, updated_by, updated_at)
	VALUES (1, @vectorizer, @updated_by, @updated_at)
	ON CONFLICT(id) DO UPDATE SET vectorizer = excluded.vectorizer, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`);
// ベクトライザー切り替え時は、既存の索引付け済みベクトルが新しいベクトライザーとは
// 互換性が無くなる(Weaviate側のコレクション自体を削除するため)。アクティブな全文書の
// 索引状態を未処理へ戻し、「ベクトル索引」画面から「全件を再索引」を促す
const resetAllIndexStatuses = db.prepare(`
	UPDATE documents SET vector_index_status = NULL, vector_index_error = NULL, vector_indexed_at = NULL WHERE deleted_at IS NULL
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

/**
 * 現在有効なベクトライザーの設定情報を返す。GUIから保存された値(vector_search_settings)が
 * あればそれを優先し、無ければ環境変数(WEAVIATE_VECTORIZER)の既定値を使う。
 * optionsには選択可能な全ベクトライザーとその設定済み状態(configured)を含める
 * (GUI側で未設定の選択肢を判別できるようにするため)
 */
const getVectorizerSetting = () => {
	const row = selectVectorizerSetting.get();
	const key = (row?.vectorizer != null && VECTORIZERS[row.vectorizer] != null) ? row.vectorizer : WEAVIATE_VECTORIZER_DEFAULT;
	return {
		vectorizer: key,
		label: VECTORIZERS[key]?.label ?? key,
		isCustom: row?.vectorizer != null,
		updatedBy: row?.updated_by ?? null,
		updatedAt: row?.updated_at ?? null,
		defaultVectorizer: WEAVIATE_VECTORIZER_DEFAULT,
		options: Object.entries(VECTORIZERS).map(([optionKey, v]) => ({key: optionKey, label: v.label, configured: isVectorizerConfigured(optionKey)}))
	};
};

let clientPromise = null;

const ensureCollection = async (weaviate, client) => {
	if (await client.collections.exists(COLLECTION_NAME)) {
		return;
	}
	await client.collections.create({
		name: COLLECTION_NAME,
		vectorizers: resolveVectorizer().configure(weaviate),
		properties: [
			{name: "documentId", dataType: weaviate.dataType.TEXT, skipVectorization: true, indexFilterable: true},
			{name: "chunkIndex", dataType: weaviate.dataType.INT, skipVectorization: true},
			{name: "text", dataType: weaviate.dataType.TEXT}
		]
	});
	logger.info({collection: COLLECTION_NAME, vectorizer: getVectorizerSetting().vectorizer}, "::ensureCollection: Weaviateコレクションを作成しました");
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

/**
 * Weaviate側のDocumentChunkコレクションを削除し、キャッシュ済みの接続を破棄する。
 * ベクトライザー切り替え時に呼ぶ(異なるベクトライザーのベクトルは互換性が無いため、
 * 既存のコレクションを残したまま新しいベクトライザーを設定しても正しく動作しない)。
 * 次回のgetClient()呼び出し時に、新しい設定でコレクションが自動的に再作成される
 * (ensureCollection参照)。あわせてアクティブな全文書の索引状態を未処理へ戻す
 */
const recreateCollection = async () => {
	if (isEnabled()) {
		try {
			const client = await getClient();
			if (await client.collections.exists(COLLECTION_NAME)) {
				await client.collections.delete(COLLECTION_NAME);
			}
		} catch (err) {
			logger.error(err, "::recreateCollection: 既存コレクションの削除に失敗しました");
		} finally {
			clientPromise = null;
		}
	}
	resetAllIndexStatuses.run();
	onStatusChange();
};

/**
 * ベクトライザーをGUIから切り替える(admin限定、呼び出し元のserver.jsでロールチェックする)。
 * 必要な環境変数(requiredEnv)が揃っていないベクトライザーへの切り替えは拒否する。
 * 切り替えに伴い、既存コレクションの削除・索引状態のリセットを行う(recreateCollection参照)ため、
 * 呼び出し元で「全件を再索引」を促すこと
 */
const updateVectorizerSetting = async (vectorizerKey, updatedBy) => {
	const vectorizer = VECTORIZERS[vectorizerKey];
	if (vectorizer == null) {
		throw new Error(`未知のvectorizerです: ${vectorizerKey}`);
	}
	if (!isVectorizerConfigured(vectorizerKey)) {
		throw new Error(`${vectorizer.label}は必要な環境変数(${vectorizer.requiredEnv.join(", ")})が設定されていないため切り替えられません`);
	}
	upsertVectorizerSetting.run({vectorizer: vectorizerKey, updated_by: updatedBy, updated_at: new Date().toISOString()});
	await recreateCollection();
	return getVectorizerSetting();
};

/**
 * ベクトライザーを環境変数の既定値に戻す(GUIでの上書きを解除する)。
 * 実際に切り替わる(現在の設定と既定値が異なる)場合のみコレクションを再作成する
 */
const resetVectorizerSetting = async () => {
	const before = getVectorizerSetting();
	upsertVectorizerSetting.run({vectorizer: null, updated_by: null, updated_at: null});
	if (before.isCustom && before.vectorizer !== WEAVIATE_VECTORIZER_DEFAULT) {
		await recreateCollection();
	}
	return getVectorizerSetting();
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

// 索引状態(processing/ok/error/未処理)が変化するたびにserver.js側へ通知するためのフック。
// server.js側でSSE配信(broadcastDocumentsChanged)を登録することで、「ベクトル索引」画面を
// 開いている全クライアントへバックグラウンド処理の開始・完了をリアルタイムに反映できる。
// 未登録(デフォルト)の場合は何もしない
let onStatusChange = () => {};
const setStatusChangeListener = (listener) => {
	onStatusChange = listener;
};

// 索引結果(処理中/成功/失敗)をdocuments.vector_index_status等へ記録する。記録自体の失敗は
// 索引処理の成否に影響させない(ログのみ)。DBへ記録するのは、プロセス再起動後も状態を
// 引き継ぐため、および複数クライアントから見えるようにするため(inFlightIndexingは
// プロセス内メモリのみで、再起動やSSE通知には使えない)
const recordIndexResult = (documentId, status, error) => {
	try {
		updateVectorIndexStatus.run({id: documentId, status, error, indexed_at: status === "ok" ? new Date().toISOString() : null});
	} catch (err) {
		logger.error({err, documentId}, "::recordIndexResult");
	}
	onStatusChange();
};

// indexDocument/removeDocumentは呼び出し元(server.js)からawaitせずバックグラウンドで
// 実行される(埋め込み計算に数秒かかるため、アップロード/削除APIの応答をブロックしないよう
// fire-and-forgetで呼ばれる)。同一文書IDに対する操作(アップロード直後の削除、削除直後の
// 復元等)が入れ替わって実行されると、Weaviate側に古い/削除済みのはずのチャンクが
// 残ってしまう恐れがあるため、文書IDごとに前の操作の完了を待ってから次を実行するよう
// 直列化する(異なる文書ID同士は並行実行されるため、一括バックフィル等の速度には影響しない)
const pendingByDocument = new Map();
const runSerialized = (documentId, task) => {
	const previous = pendingByDocument.get(documentId) || Promise.resolve();
	const next = previous.then(task, task);
	pendingByDocument.set(documentId, next);
	next.finally(() => {
		if (pendingByDocument.get(documentId) === next) {
			pendingByDocument.delete(documentId);
		}
	});
	return next;
};

// 埋め込み計算(t2v-transformers等の推論サーバー呼び出し)は文書1件だけでもCPUを使い切る
// 重い処理であるため(実機ではCPU使用率がピーク400%超に達することを確認済み)、文書ごとの
// 直列化(runSerialized)とは別に、埋め込みを伴う処理全体をグローバルに1件ずつ実行する。
// これが無いと、複数文書の連続アップロード時にindexDocumentが並行に走ってしまい、推論サーバーに
// リクエストが殺到してWeaviate側の90秒タイムアウトに達し、索引付けが軒並み失敗する(実機で確認済み)
let embeddingQueueTail = Promise.resolve();
const runEmbeddingExclusive = (task) => {
	const result = embeddingQueueTail.then(task, task);
	embeddingQueueTail = result.then(() => {}, () => {});
	return result;
};

// 索引付け中の文書に対して、アップロード直後のバックグラウンド処理と手動の再実行が
// ほぼ同時に呼ばれるなど、同一文書への重複リクエストが発生し得る(vector_index_status='processing'は
// UI上での視認性のためのものであり、それを見た利用者が再実行するのを完全に防ぐことはできない。
// 複数ブラウザタブや、SSE通知が届く前の連打などもあり得る)。indexDocumentは常に現在の
// content_textを元に全チャンクを作り直すため、進行中の索引付けと同じ内容を二重に処理しても
// 結果は変わらず無駄になるだけである。そのため、既に進行中の索引付けがあればそれに合流し
// (新たな処理は開始せず、同じ結果を待つだけにする)、推論サーバーへの負荷と待ち時間を増やさないようにする
const inFlightIndexing = new Map();

/**
 * 指定文書のチャンクを登録し直す(既存チャンクは一旦全削除してから再登録する)。
 * 成功/失敗をdocuments.vector_index_status等へ記録し、「失敗した文書の再実行」画面から
 * 状態を確認できるようにする。Weaviate未設定時は何もしない(状態も更新しない)。
 * エラー時も例外は投げず、呼び出し元(アップロード/復元処理)を失敗させない
 */
const indexDocument = (documentId, contentText) => {
	if (!isEnabled()) {
		return Promise.resolve();
	}
	if (contentText == null || contentText.trim() === "") {
		// 索引対象の本文が無い(画像等)。エラーではないのでok扱いにする
		recordIndexResult(documentId, "ok", null);
		return Promise.resolve();
	}
	const inFlight = inFlightIndexing.get(documentId);
	if (inFlight != null) {
		return inFlight;
	}
	// 実際の埋め込み計算(runEmbeddingExclusiveの順番待ちを含む)を始める前に、同期的に
	// 'processing'を記録する。こうすることで、呼び出し元(server.js)がこの直後に行う
	// SSE通知(documents-changed)の時点で、DBには既に'processing'が反映されている
	recordIndexResult(documentId, "processing", null);
	const promise = runSerialized(documentId, () => runEmbeddingExclusive(async () => {
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
	}));
	inFlightIndexing.set(documentId, promise);
	promise.finally(() => {
		if (inFlightIndexing.get(documentId) === promise) {
			inFlightIndexing.delete(documentId);
		}
	});
	return promise;
};

/**
 * 指定文書のチャンクを削除する(論理削除時に呼ぶ。ベストエフォート)。索引状態も未処理に戻す
 */
const removeDocument = (documentId) => {
	if (!isEnabled()) {
		return Promise.resolve();
	}
	return runSerialized(documentId, async () => {
		try {
			const client = await getClient();
			const collection = client.collections.use(COLLECTION_NAME);
			await removeDocumentChunks(collection, documentId);
			recordIndexResult(documentId, null, null);
		} catch (err) {
			logger.error({err, documentId}, "::removeDocument");
		}
	});
};

/**
 * 意味検索。文書IDごとに最もスコアの良いチャンク1件(ベクトル距離が小さいほど近い)へ
 * 集約して返す。Weaviate未設定時はnull(呼び出し元で503を返すため)、エラー時は空配列を返す
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
		const sorted = [...bestByDocument.values()].sort((a, b) => a.distance - b.distance);
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
 * アクティブな全文書の索引状態(status: null=未処理 / 'processing'=バックグラウンド処理中 /
 * 'ok' / 'error')を返す。「ベクトル索引」画面(index.html)から呼ばれる。失敗した文書の
 * 再実行だけでなく、チャンク分割方法や埋め込みモデルを変更した際に成功済みの文書も含めて
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

/**
 * サーバー起動時に呼ぶ。前回の起動時に'processing'のまま残っている文書(強制終了等で
 * プロセス内キューの情報が失われたもの)を「未処理」に戻し、次回の索引付け/バックフィルで
 * 再処理されるようにする。Weaviate未設定時は何もしない
 */
const recoverStaleProcessing = () => {
	if (!isEnabled()) {
		return;
	}
	try {
		const result = resetStaleProcessingStatus.run();
		if (result.changes > 0) {
			logger.warn({count: result.changes}, "::recoverStaleProcessing: 前回起動時に処理中のまま残っていた文書を未処理に戻しました");
		}
	} catch (err) {
		logger.error(err, "::recoverStaleProcessing");
	}
};

module.exports = {
	isEnabled, indexDocument, removeDocument, search, chunkText, backfillMissingDocuments, listIndexStatuses, retryDocument,
	getChunkSettings, updateChunkSettings, resetChunkSettings, setStatusChangeListener, recoverStaleProcessing,
	getVectorizerSetting, updateVectorizerSetting, resetVectorizerSetting
};
