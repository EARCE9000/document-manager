/*!
 * unit.test.js : 外部I/Oを伴わない純関数のユニットテスト(層1)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 * datastore/vector-search/api-keys は require時にdatastore(既定sqlite)を初期化するため、
 * 副作用のDBファイルが既定の /data に作られないよう、先頭で DATA_DIR を一時ディレクトリに向ける。
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dm-unit-"));

const test = require("node:test");
const assert = require("node:assert/strict");

const zlib = require("node:zlib");

const {computeByteRange} = require("../app/lib/storage.js");
const {translatePlaceholders} = require("../app/lib/datastore.js");
const VectorSearch = require("../app/lib/vector-search.js");
const ApiKeys = require("../app/lib/api-keys.js");
const AllowedUsers = require("../app/lib/allowed-users.js");
const {extractDrawioText} = require("../app/lib/drawio.js");
const {convertOfficeDocument, LIMITS} = require("../app/lib/office.js");

// Office(Excel/Word/PowerPoint)のテストは、手書きのXMLではなく実際のアプリが書き出した
// ファイル(test/fixtures/office/。tools/make-office-fixtures.py で生成)に対して行う
const officeFixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "office", name));

test("computeByteRange", () => {
	assert.deepEqual(computeByteRange(undefined, 16), {satisfiable: true, start: 0, end: 15, partial: false});
	assert.deepEqual(computeByteRange("bytes=0-3", 16), {satisfiable: true, start: 0, end: 3, partial: true});
	assert.deepEqual(computeByteRange("bytes=2-5", 16), {satisfiable: true, start: 2, end: 5, partial: true});
	assert.deepEqual(computeByteRange("bytes=10-", 16), {satisfiable: true, start: 10, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=-4", 16), {satisfiable: true, start: 12, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=0-999", 16), {satisfiable: true, start: 0, end: 15, partial: true});
	assert.deepEqual(computeByteRange("bytes=16-20", 16), {satisfiable: false});
	assert.deepEqual(computeByteRange("bytes=-0", 16), {satisfiable: false});
	// 解釈できないRangeは全体を返す(寛容)
	assert.deepEqual(computeByteRange("garbage", 16), {satisfiable: true, start: 0, end: 15, partial: false});
});

test("translatePlaceholders: 位置パラメータ ?", () => {
	const {text, values} = translatePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", ["x", "y"]);
	assert.equal(text, "SELECT * FROM t WHERE a = $1 AND b = $2");
	assert.deepEqual(values, ["x", "y"]);
});

test("translatePlaceholders: 名前付き @name(同名は同じ$nを再利用)", () => {
	const {text, values} = translatePlaceholders("WHERE x LIKE @q OR y LIKE @q OR id = @id", {q: "a", id: "b"});
	assert.equal(text, "WHERE x LIKE $1 OR y LIKE $1 OR id = $2");
	assert.deepEqual(values, ["a", "b"]);
});

test("translatePlaceholders: params無しはそのまま", () => {
	assert.deepEqual(translatePlaceholders("SELECT 1", null), {text: "SELECT 1", values: []});
});

test("chunkText: 空文字は空配列", async () => {
	assert.deepEqual(await VectorSearch.chunkText("", 100, 10), []);
});

test("chunkText: chunkSize以内は1チャンク", async () => {
	assert.deepEqual(await VectorSearch.chunkText("short text", 100, 10), ["short text"]);
});

test("chunkText: CRLFの段落境界を正規化して\\n\\nで連結する", async () => {
	// \r\n\r\n が段落境界として認識され、出力に\rが残らないこと(実機で確認したバグの回帰防止)
	const chunks = await VectorSearch.chunkText("AAAA\r\n\r\nBBBB", 100, 10);
	assert.deepEqual(chunks, ["AAAA\n\nBBBB"]);
});

test("chunkText: chunkSize超の段落はオーバーラップ付きで分割", async () => {
	const text = "x".repeat(250);
	const chunks = await VectorSearch.chunkText(text, 100, 20);
	assert.ok(chunks.length > 1, "複数チャンクに分割される");
	assert.equal(chunks[0].length, 100, "先頭チャンクはchunkSize長");
});

test("calculateExpiresAt: 30d/90d は日数分先", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("30d", now).toISOString(), "2026-01-31T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("90d", now).toISOString(), "2026-04-01T00:00:00.000Z");
});

test("calculateExpiresAt: today は min(now+12h, 翌日02:00 JST)", () => {
	// now=00:00Z → +12h=12:00Z、翌日02:00 JST=前日17:00Z。min は 12:00Z
	const now = new Date("2026-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("today", now).toISOString(), "2026-01-01T12:00:00.000Z");
});

test("calculateExpiresAt: 365d は1年後(発行できる最長)。無期限は選べない", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.calculateExpiresAt("365d", now).toISOString(), "2027-01-01T00:00:00.000Z");
	assert.equal(ApiKeys.isValidExpiryOption("365d"), true);
	assert.equal(ApiKeys.isValidExpiryOption("unlimited"), false, "無期限は発行できない");
	assert.equal(ApiKeys.MAX_EXPIRY_DAYS, 365);
});

test("calculateExpiresAt: 不正な選択肢は例外", () => {
	assert.throws(() => ApiKeys.calculateExpiresAt("forever", new Date()));
});

test("APIキーのロール/有効期限バリデーション", () => {
	assert.equal(ApiKeys.isValidApiKeyRole("readonly"), true);
	assert.equal(ApiKeys.isValidApiKeyRole("readwrite"), true);
	assert.equal(ApiKeys.isValidApiKeyRole("admin"), false); // adminキーは発行不可
	assert.equal(ApiKeys.isValidExpiryOption("30d"), true);
	assert.equal(ApiKeys.isValidExpiryOption("1y"), false);
});

test("allowed-users のロール定義とバリデーション", () => {
	assert.equal(AllowedUsers.isValidRole("admin"), true);
	assert.equal(AllowedUsers.isValidRole("readwrite"), true);
	assert.equal(AllowedUsers.isValidRole("readonly"), true);
	assert.equal(AllowedUsers.isValidRole("root"), false);
	assert.equal(AllowedUsers.ROLES.ADMIN, "admin");
});

test("extractDrawioText: 非圧縮(mxGraphModel生XML)からページ名・ラベルを抽出", () => {
	const xml = `<mxfile><diagram name="設計フロー" id="p1"><mxGraphModel>`
		+ `<root><mxCell id="0"/><mxCell id="2" value="開始" vertex="1"/>`
		+ `<mxCell id="3" value="&lt;b&gt;注文処理&lt;/b&gt;" vertex="1"/>`
		+ `<mxCell id="4" value="" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
	const text = extractDrawioText(xml);
	assert.match(text, /設計フロー/);
	assert.match(text, /開始/);
	assert.match(text, /注文処理/, "HTMLラベルはタグ除去・エンティティ復元して抽出される");
	assert.doesNotMatch(text, /<b>/, "HTMLタグは残らない");
});

test("extractDrawioText: 圧縮(base64 deflate)されたdiagramを展開して抽出", () => {
	const model = `<mxGraphModel><root><mxCell id="2" value="圧縮ラベル" vertex="1"/></root></mxGraphModel>`;
	const compressed = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model), "utf8")).toString("base64");
	const xml = `<mxfile><diagram name="圧縮ページ" id="p1">${compressed}</diagram></mxfile>`;
	const text = extractDrawioText(xml);
	assert.match(text, /圧縮ページ/);
	assert.match(text, /圧縮ラベル/);
});

test("extractDrawioText: 壊れた入力でも例外を投げず空文字を返す", () => {
	assert.equal(extractDrawioText(""), "");
	assert.equal(extractDrawioText(null), "");
	assert.equal(typeof extractDrawioText("<mxfile><diagram>@@not-base64@@</diagram></mxfile>"), "string");
});

test("convertOfficeDocument: Excel(シート名・日付・真偽値・大きい表の打ち切り)", () => {
	const result = convertOfficeDocument(officeFixture("sample.xlsx"), ".xlsx");
	assert.ok(result != null, "変換できる");
	assert.match(result.bodyHtml, /<h2>売上<\/h2>/, "シート名が見出しになる");
	assert.match(result.text, /サンプル商事/);
	// 日付は連番(45000台)ではなく日付として表示する。時刻付きのセルは時刻まで出す
	assert.match(result.text, /2026\/09\/01/);
	assert.match(result.text, /2026\/09\/20 14:30/);
	assert.doesNotMatch(result.text, /46266/, "日付がシリアル値のまま出ない");
	assert.match(result.text, /TRUE/, "真偽値は TRUE/FALSE で出る");
	assert.match(result.bodyHtml, /先頭300行/, "大きいシートは打ち切って、その旨を出す");
	const rowCount = (result.bodyHtml.match(/<tr>/g) || []).length;
	assert.ok(rowCount <= LIMITS.rowsPerSheet * LIMITS.sheets, "打ち切り後の行数が上限に収まる");
});

test("convertOfficeDocument: Word(見出し・箇条書き・表)", () => {
	const result = convertOfficeDocument(officeFixture("sample.docx"), ".docx");
	assert.ok(result != null);
	assert.match(result.bodyHtml, /<h2>文書管理システム 導入手順書<\/h2>/, "見出し1はh2になる");
	assert.match(result.bodyHtml, /<h3>前提条件<\/h3>/, "見出し2はh3になる");
	assert.match(result.bodyHtml, /<li>サーバーにDockerが導入されていること<\/li>/, "箇条書きはリストになる");
	assert.match(result.bodyHtml, /<td>環境変数の設定<\/td>/, "表はテーブルになる");
	assert.match(result.text, /疎通確認/, "表の中身も検索対象のテキストに入る");
});

test("convertOfficeDocument: PowerPoint(スライド順・タイトル・ノート)", () => {
	const result = convertOfficeDocument(officeFixture("sample.pptx"), ".pptx");
	assert.ok(result != null);
	assert.match(result.bodyHtml, /<h2>1\. 文書管理システムのご提案<\/h2>/, "スライド番号とタイトルが出る");
	assert.match(result.bodyHtml, /<h2>2\. 課題<\/h2>/);
	assert.match(result.bodyHtml, /<li>最新版がどれか分からない<\/li>/);
	assert.match(result.bodyHtml, /ノート: ここで実際の調査結果を紹介する/, "発表者ノートも出す");
	assert.doesNotMatch(result.bodyHtml, /ノート: \d+</, "ノート用スライドのページ番号をノート本文として拾わない");
	assert.match(result.text, /退職者の資料が引き継がれない/);
	// スライドの中身が表(graphicFrame)だけ、という資料は実務で多い
	assert.match(result.bodyHtml, /<h2>4\. 確認事項<\/h2>/);
	assert.match(result.bodyHtml, /<td>接続要件の確認<\/td>/, "スライド内の表も読む");
	assert.match(result.text, /保守経路の確認/, "表の中身も検索対象のテキストに入る");
});

test("convertOfficeDocument: 中身がHTMLとして解釈されないようエスケープする", () => {
	// 文書の中身(セルの値・段落)は利用者が自由に書けるため、プレビューHTMLに素通ししない
	const result = convertOfficeDocument(officeFixture("sample.xlsx"), ".xlsx");
	assert.doesNotMatch(result.bodyHtml, /<script/i);
	assert.ok(!result.bodyHtml.includes("<td><"), "セルの中にタグがそのまま入らない");
});

test("convertOfficeDocument: 文書の中身に仕込まれたHTML/スクリプトを無害化する", () => {
	// セルの値・シート名は利用者が自由に書ける。プレビューHTMLへ素通しすると保存型XSSになる
	const result = convertOfficeDocument(officeFixture("malicious.xlsx"), ".xlsx");
	assert.ok(result != null);
	assert.doesNotMatch(result.bodyHtml, /<script/i, "scriptタグが生で出ない");
	assert.doesNotMatch(result.bodyHtml, /<img/i, "imgタグが生で出ない");
	assert.doesNotMatch(result.bodyHtml, /<a /i, "aタグが生で出ない");
	// 中身は消さずにエスケープして見せる(利用者は何が書かれていたか確認できる)
	assert.match(result.bodyHtml, /&lt;script&gt;/, "エスケープされた形で残る");
	assert.match(result.bodyHtml, /&lt;b&gt;シート名/, "シート名もエスケープされる");
	// 属性から抜け出せないこと(引用符もエスケープする)
	assert.doesNotMatch(result.bodyHtml, /<td>[^<]*"/, "セルの中に生の引用符が出ない");
	assert.match(result.text, /XSS-EXECUTED/, "全文検索用のテキストには元の文字列が入る");
});

test("convertOfficeDocument: ZIP爆弾対策の上限を超えたエントリは展開しない", () => {
	const buffer = officeFixture("sample.xlsx");
	// 展開後の合計が上限を超える場合、必要なXMLを読めないため変換自体が成立しない
	assert.equal(convertOfficeDocument(buffer, ".xlsx", {maxTotalBytes: 1024}), null, "合計の上限で止まる");
	// 1エントリあたりの上限は、超えたエントリだけを読み飛ばす(残りから取れる分は返す)。
	// このファイルでは「大きい表」のシートだけが4KBを超える
	const perEntry = convertOfficeDocument(buffer, ".xlsx", {maxEntryBytes: 4096});
	assert.ok(perEntry != null, "上限内のエントリからは読める");
	assert.match(perEntry.text, /サンプル商事/, "小さいシートは従来どおり読める");
	assert.doesNotMatch(perEntry.text, /備考100/, "上限を超えたシートは展開されない");
	// 上限内なら従来どおり読める
	assert.ok(convertOfficeDocument(buffer, ".xlsx", {maxTotalBytes: 64 * 1024 * 1024}) != null);
});

// ZIPヘッダーの「展開後サイズ」は書庫を作る側が自由に書ける申告値で、そこを信じて上限を
// 判定すると、小さいと申告して実際は大きく膨らむ書庫を止められない。
// (実測: 0.3MBのファイルが展開時に536MBを確保していた。上限は64MBと指定してあったのに効かなかった)
// 実際に出てきた量で打ち切っていることを、嘘をついた書庫を作って確かめる。
test("convertOfficeDocument: 展開後サイズを小さく偽った書庫でも膨らませない", () => {
	const EXPANDED = 64 * 1024 * 1024; // 実際に膨らむ量
	const DECLARED = 1000;             // ヘッダーに書く嘘の展開後サイズ

	// ゼロ埋めは非常によく縮むため、小さな圧縮データで大きく膨らむ
	const payload = zlib.deflateRawSync(Buffer.alloc(EXPANDED), {level: 9});

	// エントリ1つだけの最小限のZIPを組み立てる(名前は xlsx の読み取り対象にする)
	const name = Buffer.from("xl/workbook.xml", "utf-8");
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8); // deflate
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(DECLARED, 22);
	local.writeUInt16LE(name.length, 26);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10); // deflate
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(DECLARED, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE(0, 42);

	const centralStart = local.length + name.length + payload.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(centralStart, 16);

	const bomb = Buffer.concat([local, name, payload, central, name, end]);
	assert.ok(bomb.length < 1024 * 1024, `仕掛けは小さい (${bomb.length}バイト)`);

	const before = process.memoryUsage().external;
	const result = convertOfficeDocument(bomb, ".xlsx", {maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024});
	const grew = process.memoryUsage().external - before;

	assert.equal(result, null, "中身が揃わないので変換は成立しない");
	// 申告値を信じる実装に戻すと、ここで上限を大きく超えて確保される
	assert.ok(grew < 8 * 1024 * 1024, `上限を超えて確保していない (増加 ${(grew / 1024 / 1024).toFixed(1)}MB)`);
});

test("convertOfficeDocument: 壊したファイルを食わせても落ちず、いつまでも計算しない", () => {
	// 利用者は壊れたファイルも壊れかけのファイルもアップロードできる。ZIPの構造やXMLが
	// 想定と違っても、例外で500にしたり、長時間ブロックしたりしないことを確かめる
	// (この変換はアプリのプロセス内で同期的に動くため、止まると全体が止まる)
	const seeds = ["sample.xlsx", "sample.docx", "sample.pptx"];
	let random = 20260924; // 毎回同じ壊し方になるよう、乱数は固定の種から作る
	const nextInt = (max) => {
		random = (random * 1103515245 + 12345) & 0x7fffffff;
		return random % max;
	};

	for (const name of seeds) {
		const original = officeFixture(name);
		const extension = path.extname(name);
		for (let round = 0; round < 40; round++) {
			const broken = Buffer.from(original);
			if (round % 4 === 0) {
				// 途中で切れたファイル(アップロード中断など)
				const cut = broken.subarray(0, 1 + nextInt(broken.length));
				const started = Date.now();
				assert.doesNotThrow(() => convertOfficeDocument(cut, extension), `${name}: 切り詰めでも例外を投げない`);
				assert.ok(Date.now() - started < 5000, `${name}: 切り詰めでも5秒以内に返る`);
				continue;
			}
			// 数バイトを書き換える(ヘッダー・サイズ欄・XMLの一部が壊れる)
			for (let i = 0; i < 8; i++) broken[nextInt(broken.length)] = nextInt(256);
			const started = Date.now();
			assert.doesNotThrow(() => convertOfficeDocument(broken, extension), `${name}: 書き換えでも例外を投げない`);
			assert.ok(Date.now() - started < 5000, `${name}: 書き換えでも5秒以内に返る`);
		}
	}
});

test("convertOfficeDocument: 対象外・壊れた入力では null を返す(例外を投げない)", () => {
	assert.equal(convertOfficeDocument(Buffer.from("not a zip"), ".xlsx"), null);
	assert.equal(convertOfficeDocument(officeFixture("sample.xlsx"), ".pdf"), null, "拡張子が対象外");
	assert.equal(convertOfficeDocument(null, ".docx"), null);
	// ZIPではあるが中身がOffice文書でない場合
	assert.equal(convertOfficeDocument(zlib.gzipSync(Buffer.from("x")), ".pptx"), null);
});

test.after(() => {
	try {
		fs.rmSync(process.env.DATA_DIR, {recursive: true, force: true});
	} catch {}
});
