/*!
 * mockup-zip.js : モックアップ(ビルド済みの静的サイト一式)のZIPを安全に展開する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 方針は docs/mockup.md を参照。要点は「置き場所(パス)は厳格に、ファイルの種類は寛容に」。
 *
 * ---- なぜ厳格にするか ----
 * ZIPのエントリ名は、書庫を作る側が自由に決められる。素朴に展開すると名前のとおりの場所へ書く。
 *   ../../../db/document_manager_v14.sqlite  → 文書のメタデータを丸ごと上書きできる
 * 中身が無害な .txt でも、書き込み先を選べる時点で被害は同じになる。拡張子では守れない。
 * モックアップが読むのは自分のフォルダ配下だけで、外を指す正当な用途が無いため全て拒否する。
 *
 * ---- 展開後サイズの数え方 ----
 * ZIPヘッダーの「展開後サイズ」は申告値であり、嘘をつける。実測では、それを信じた実装に
 * 0.3MBのファイルを食わせると536MBを確保していた(app/lib/office.js の同じ問題を修正済み)。
 * ここでは zlib に maxOutputLength を渡し、**実際に出てきた量**で打ち切る。
 *
 * ---- 展開は同期的に行う ----
 * 1エントリの展開は上限(既定50MB)で頭打ちになり、合計も上限(既定300MB)で止まる。
 * アップロード時に一度だけ走る処理のため、複雑な非同期化よりも読みやすさを優先した。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const logger = require("./logger.js")(path.basename(__filename));

const MB = 1024 * 1024;

// 上限。見積もりの根拠は docs/mockup.md を参照(50ページのモックアップで2〜11MB程度)
const LIMITS = {
	maxFiles: Number(process.env.MOCKUP_MAX_FILES || 2000),
	maxTotalBytes: Number(process.env.MOCKUP_MAX_TOTAL_BYTES || 300 * MB),
	maxFileBytes: Number(process.env.MOCKUP_MAX_FILE_BYTES || 50 * MB),
	maxDepth: Number(process.env.MOCKUP_MAX_DEPTH || 20),
	// 展開後÷圧縮後がこれを超えたら中止する。絶対値(maxTotalBytes)が本命で、これは補助。
	// HTMLは素直に10〜20倍に圧縮されるため、200倍なら正常なファイルを誤って弾かない
	maxRatio: Number(process.env.MOCKUP_MAX_RATIO || 200)
};
module.exports.LIMITS = LIMITS;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * 受け入れられない書庫だったときに投げる。
 * `written` には、その時点までに書いてしまったファイル(展開先からの相対パス)が入る。
 * 呼び出し側はこれを使って、書いたものだけを正確に捨てられる(再帰削除を使わずに済む)。
 */
class MockupZipError extends Error {
	constructor(message, written = []) {
		super(message);
		this.written = written;
	}
}
module.exports.MockupZipError = MockupZipError;
const reject = (message) => { throw new MockupZipError(message); };

/**
 * エントリ名として受け入れてよいか。ここが唯一の歯止めなので、疑わしいものは全て拒否する。
 * 戻り値は、展開先からの相対パス(区切りは "/")。
 */
const safeEntryPath = (rawName, maxDepth) => {
	const name = String(rawName);
	if (name === "") reject("空のファイル名が含まれています");
	// 制御文字(NUL・改行等)。ファイルシステムや配信時の扱いが環境で変わるため受け付けない
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) reject(`使用できない文字を含むファイル名です: ${JSON.stringify(name)}`);
	// Windowsのパスとして解釈されうる形。ZIPの規格上は "/" 区切りのみが正しい
	if (name.includes("\\")) reject(`パス区切りに \\ を使ったファイル名は展開できません: ${name}`);
	if (/^[a-zA-Z]:/.test(name)) reject(`ドライブ名から始まるファイル名は展開できません: ${name}`);
	if (name.startsWith("/")) reject(`絶対パスのファイル名は展開できません: ${name}`);

	const segments = name.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) reject(`展開先を決められないファイル名です: ${name}`);
	if (segments.length > maxDepth) reject(`階層が深すぎます(上限${maxDepth}): ${name}`);
	for (const segment of segments) {
		// ".." はもちろん、"." も展開先を曖昧にするため受け付けない
		if (segment === "." || segment === "..") reject(`上位の階層を指すファイル名は展開できません: ${name}`);
	}
	return segments.join("/");
};

/** 中央ディレクトリの位置を末尾から探す(コメントが付いていることがあるため後ろから走査する) */
const findEndOfCentralDirectory = (buffer) => {
	const start = Math.max(0, buffer.length - 66 * 1024);
	for (let i = buffer.length - 22; i >= start; i--) {
		if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
	}
	return -1;
};

/**
 * ZIPを展開する。
 *
 * @param {Buffer} buffer ZIPそのもの
 * @param {string} destDir 展開先(呼び出し側が用意した、このモックアップ専用のディレクトリ)
 * @param {object} limits 上限の上書き(テスト用)
 * @returns {{files: {path: string, bytes: number}[], totalBytes: number, entryFile: string|null}}
 * @throws {MockupZipError} 受け入れられない書庫の場合
 */
module.exports.extract = (buffer, destDir, limits = {}) => {
	const maxFiles = limits.maxFiles ?? LIMITS.maxFiles;
	const maxTotalBytes = limits.maxTotalBytes ?? LIMITS.maxTotalBytes;
	const maxFileBytes = limits.maxFileBytes ?? LIMITS.maxFileBytes;
	const maxDepth = limits.maxDepth ?? LIMITS.maxDepth;
	const maxRatio = limits.maxRatio ?? LIMITS.maxRatio;

	if (!Buffer.isBuffer(buffer) || buffer.length < 22) reject("ZIPとして読めません");
	if (buffer.readUInt32LE(0) !== 0x04034b50 && findEndOfCentralDirectory(buffer) < 0) reject("ZIPとして読めません");

	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) reject("ZIPとして読めません(中央ディレクトリが見つかりません)");

	const entryCount = buffer.readUInt16LE(eocd + 10);
	const directoryOffset = buffer.readUInt32LE(eocd + 16);
	// ZIP64は対象外。通常のモックアップ(数百ファイル・数十MB)では発生しない
	if (entryCount === 0xffff || directoryOffset === 0xffffffff) reject("ZIP64形式の書庫には対応していません");
	if (entryCount > maxFiles) reject(`ファイル数が多すぎます(上限${maxFiles}、この書庫は${entryCount})`);

	const root = path.resolve(destDir);
	const files = [];
	let totalBytes = 0;
	let offset = directoryOffset;
	// ここから先の拒否には、書いてしまったファイルを添える(呼び出し側が捨てられるように)
	const rejectWritten = (message) => { throw new MockupZipError(message, files.map((file) => file.path)); };
	// 名前の検査はモジュール直下の関数で行うため、書いてしまった分を知らない。
	// ここで受け直して添える(呼び出し側が捨てられるように)
	const checkedPath = (rawName) => {
		try {
			return safeEntryPath(rawName, maxDepth);
		} catch (err) {
			rejectWritten(err.message);
		}
	};

	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
			rejectWritten("ZIPの構造が壊れています");
		}
		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const externalAttributes = buffer.readUInt32LE(offset + 38);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const rawName = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;

		// ディレクトリのエントリは作る必要がない(ファイルを書くときに親ごと作る)
		if (rawName.endsWith("/")) {
			checkedPath(rawName); // 名前だけは確かめる
			continue;
		}
		// 暗号化された書庫は中身を確かめられない
		if ((flags & 0x0001) !== 0) rejectWritten(`暗号化されたエントリは展開できません: ${rawName}`);
		// シンボリックリンク(Unixのファイル種別がリンク)。作らせるとその先へ書き込ませられる
		if (((externalAttributes >>> 16) & 0xf000) === 0xa000) {
			rejectWritten(`シンボリックリンクは展開できません: ${rawName}`);
		}
		if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
			rejectWritten(`対応していない圧縮方式です(${method}): ${rawName}`);
		}

		const relative = checkedPath(rawName);
		const target = path.resolve(root, relative);
		// 名前は確かめてあるが、組み立てた結果が展開先の内側に収まることも確かめる
		// (判定の取りこぼしがあっても、外には出さない)
		if (target !== root && !target.startsWith(root + path.sep)) {
			rejectWritten(`展開先の外を指すファイル名です: ${rawName}`);
		}

		if (files.length >= maxFiles) rejectWritten(`ファイル数が多すぎます(上限${maxFiles})`);

		if (localOffset + 30 > buffer.length) rejectWritten("ZIPの構造が壊れています");
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (dataStart + compressedSize > buffer.length) rejectWritten("ZIPの構造が壊れています");
		const data = buffer.subarray(dataStart, dataStart + compressedSize);

		// 実際に出てきた量で打ち切る。残り容量ぶんだけを許すため、エントリ数で稼ぐ手口も
		// 合計側で頭打ちになる。ヘッダーの申告値は一切信じない
		const remaining = maxTotalBytes - totalBytes;
		if (remaining <= 0) rejectWritten(`展開後の合計が上限を超えました(上限${Math.floor(maxTotalBytes / MB)}MB)`);
		const allowed = Math.min(maxFileBytes, remaining);

		let content;
		try {
			content = method === METHOD_STORE
				? Buffer.from(data.subarray(0, allowed + 1))
				: zlib.inflateRawSync(data, {maxOutputLength: allowed + 1});
		} catch (err) {
			if (err && err.code === "ERR_BUFFER_TOO_LARGE") {
				rejectWritten(`展開後のサイズが上限を超えました: ${rawName}`);
			}
			rejectWritten(`展開できないエントリがあります: ${rawName}`);
		}
		// allowed+1 まで許して「超えたかどうか」を判定する(ちょうど上限は通す)
		if (content.length > allowed) {
			rejectWritten(content.length > maxFileBytes
				? `1ファイルの上限(${Math.floor(maxFileBytes / MB)}MB)を超えています: ${rawName}`
				: `展開後の合計が上限を超えました(上限${Math.floor(maxTotalBytes / MB)}MB)`);
		}
		if (compressedSize > 0 && content.length / compressedSize > maxRatio) {
			rejectWritten(`圧縮率が高すぎます(${Math.round(content.length / compressedSize)}倍): ${rawName}`);
		}

		fs.mkdirSync(path.dirname(target), {recursive: true});
		fs.writeFileSync(target, content);
		totalBytes += content.length;
		files.push({path: relative, bytes: content.length});
	}

	if (files.length === 0) rejectWritten("展開できるファイルが1つもありません");

	// 入口は index.html を規約とする(直下を優先し、無ければ最も浅いものを使う)
	const entryFile = files.map((file) => file.path)
		.filter((filePath) => filePath.toLowerCase().endsWith("/index.html") || filePath.toLowerCase() === "index.html")
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0] ?? null;

	logger.info({destDir, files: files.length, totalBytes, entryFile}, "モックアップのZIPを展開しました");
	return {files, totalBytes, entryFile};
};
