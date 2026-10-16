/*!
 * claude-skill.js : Claude Code 用 Skill(document-manager)のZIPを生成する
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * APIキー管理画面からダウンロードさせるためのもの。Skillのソースはリポジトリの
 * tools/claude-skill/document-manager/ にあり、Dockerイメージでは /app/claude-skill/document-manager/
 * にコピーされる(Dockerfile参照)。ZIPの中身は tools/claude-skill/build_skill_zip.py と同じく
 * `document-manager/` フォルダ1つ(~/.claude/skills/ にそのまま展開できる形)で、scripts/ 配下には
 * 実行ビットを付ける。外部依存を増やさないよう、ZIPはNode標準のzlib(deflateRaw/crc32)で組み立てる。
 * 内容はプロセス起動中は変わらないため、初回生成時の結果をメモリにキャッシュする。
 *
 * document-manager のほかに、**関連するSkill**(Document Manager とは別のサービスを操作するもの。
 * いまは Backlog)も同じ形で配る。社内の人が、いつもの場所から取れるようにするため。
 * 関連Skillは接続先も認証も別(そのサービスのAPIキーを使う)で、Document Manager の
 * 版の知らせ(X-Skill-Latest-Version)の対象にもしない。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SKILL_NAME = "document-manager";

// 一緒に配る関連Skill。ここに無い名前はZIPにしない(配るつもりの無いフォルダを、
// 名前を当てるだけで取り出せないようにする)
const RELATED_SKILLS = Object.freeze(["backlog"]);
const DISTRIBUTED_SKILLS = Object.freeze([SKILL_NAME, ...RELATED_SKILLS]);

// Docker(app/ = /app 直下にコピー)とリポジトリからの直接起動(app/server.js)の両方に対応する
const skillDirCandidates = (name) => [
	name === SKILL_NAME ? process.env.CLAUDE_SKILL_DIR : null,
	path.join(__dirname, "..", "claude-skill", name),
	path.join(__dirname, "..", "..", "tools", "claude-skill", name)
].filter(Boolean);

const findSkillDir = (name = SKILL_NAME) =>
	skillDirCandidates(name).find((dir) => fs.existsSync(path.join(dir, "SKILL.md"))) ?? null;

const EXCLUDE_DIRS = new Set(["__pycache__", "node_modules", ".git"]);

const listFiles = (dir, base = dir) => fs.readdirSync(dir, {withFileTypes: true})
	.sort((a, b) => a.name.localeCompare(b.name))
	.flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return EXCLUDE_DIRS.has(entry.name) ? [] : listFiles(full, base);
		return entry.isFile() ? [path.relative(base, full).split(path.sep).join("/")] : [];
	});

// ZIPのMS-DOS形式の日時(ローカル時刻の2秒単位)
const toDosDateTime = (date) => ({
	time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
	date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
});

/**
 * {name, data, mode} の配列から、ZIP(deflate圧縮)のBufferを組み立てる
 */
const buildZip = (entries, mtime = new Date()) => {
	const {time, date} = toDosDateTime(mtime);
	const localParts = [];
	const centralParts = [];
	let offset = 0;
	for (const {name, data, mode} of entries) {
		const nameBuf = Buffer.from(name, "utf8");
		const compressed = zlib.deflateRawSync(data);
		const crc = zlib.crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flags: ファイル名はUTF-8
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		localParts.push(local, nameBuf, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4); // version made by: UNIX(外部属性にパーミッションを持たせるため)
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); // 通常ファイル + パーミッション
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, nameBuf);

		offset += local.length + nameBuf.length + compressed.length;
	}
	const centralSize = centralParts.reduce((sum, buf) => sum + buf.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, ...centralParts, end]);
};

const cachedZips = new Map();

/**
 * Skill のZIP(Buffer)を返す。配る対象でない名前や、Skillのソースが見つからない場合は null
 * @param {string} [name] Skillの名前(省略時は document-manager)
 */
module.exports.getSkillZip = (name = SKILL_NAME) => {
	if (!DISTRIBUTED_SKILLS.includes(name)) return null;
	if (cachedZips.has(name)) return cachedZips.get(name);
	const skillDir = findSkillDir(name);
	if (skillDir == null) return null;
	const entries = listFiles(skillDir).map((relative) => ({
		name: `${name}/${relative}`,
		data: fs.readFileSync(path.join(skillDir, relative)),
		mode: relative.startsWith("scripts/") ? 0o755 : 0o644
	}));
	const zip = buildZip(entries);
	cachedZips.set(name, zip);
	return zip;
};

/** 関連Skillの一覧(画面に出すかどうかの判断用。このサーバーに入っているものだけ) */
module.exports.listRelatedSkills = () => RELATED_SKILLS.filter((name) => findSkillDir(name) != null);

/** SkillのZIPを保存するときの名前 */
module.exports.skillZipFilename = (name = SKILL_NAME) => `${name}-skill.zip`;
module.exports.RELATED_SKILLS = RELATED_SKILLS;

/**
 * 同梱しているクライアント(dm_client.py)のバージョンを読む。
 * 利用者の手元にある古いクライアントへ「新しい版がある」と知らせるために使う。
 * 通常は同梱ファイルから読むが、SKILL_CLIENT_VERSION で上書きできる(検証・テスト用)。
 */
module.exports.getBundledClientVersion = () => {
	if (process.env.SKILL_CLIENT_VERSION) return process.env.SKILL_CLIENT_VERSION;
	const dir = findSkillDir();
	if (dir == null) return null;
	try {
		const source = fs.readFileSync(path.join(dir, "scripts", "dm_client.py"), "utf-8");
		return /CLIENT_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? null;
	} catch {
		return null;
	}
};

module.exports.SKILL_ZIP_FILENAME = `${SKILL_NAME}-skill.zip`;
module.exports.buildZip = buildZip;
