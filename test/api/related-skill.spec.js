/*!
 * related-skill.spec.js : 関連するSkill(Document Manager 以外のサービス用)の配布
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 社内の人が、Document Manager のSkillと同じ画面から Backlog のSkillも取れるようにした。
 * 確かめたいのは「配るつもりのものだけが、壊れずに配られる」こと。名前を当てるだけで
 * 配るつもりの無いフォルダ(や、サーバーのほかのファイル)を取り出せてはいけない。
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {test, expect} = require("@playwright/test");
const {loadKeys} = require("./config.js");

const keys = loadKeys();
const ro = {Authorization: `Bearer ${keys.readonly}`};
const SKILL_DIR = path.join(__dirname, "..", "..", "tools", "claude-skill", "backlog");

/** ZIPの中身を {名前: {data, mode}} にする(このサーバーが作るZIPは deflate だけを使う) */
const readZip = (buffer) => {
	const entries = {};
	const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	for (let i = 0; i < count; i++) {
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const mode = (buffer.readUInt32LE(offset + 38) >>> 16) & 0o777;
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		entries[name] = {data: zlib.inflateRawSync(buffer.subarray(start, start + compressedSize)), mode};
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
};

test.describe("関連するSkill(Backlog)の配布", () => {
	test("BacklogのSkillをZIPで取れる(閲覧だけの権限でも)", async ({request}) => {
		const res = await request.get("api/related-skills/backlog.zip", {headers: ro});
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toBe("application/zip");
		expect(res.headers()["content-disposition"]).toContain('filename="backlog-skill.zip"');

		const entries = readZip(await res.body());
		const names = Object.keys(entries);
		// ~/.claude/skills/ にそのまま展開できる形(backlog/ フォルダ1つ)
		expect(names.every((name) => name.startsWith("backlog/"))).toBe(true);
		expect(names).toContain("backlog/SKILL.md");
		expect(names).toContain("backlog/scripts/backlog_client.py");
		expect(names.some((name) => name.includes("__pycache__")), "Pythonの一時ファイルが混ざっている").toBe(false);
		// 展開してすぐ実行できるよう、クライアントには実行ビットが付いている
		expect(entries["backlog/scripts/backlog_client.py"].mode).toBe(0o755);
		expect(entries["backlog/SKILL.md"].mode).toBe(0o644);
		// リポジトリの中身と同じ(古いものを配っていない)
		for (const name of names) {
			const source = fs.readFileSync(path.join(SKILL_DIR, ...name.split("/").slice(1)));
			expect(Buffer.compare(entries[name].data, source), `${name} がリポジトリと違う`).toBe(0);
		}
	});

	test("配るつもりの無い名前は404(名前を当てても取り出せない)", async ({request}) => {
		for (const name of ["document-manager", "nothing", "..%2Fbacklog", "backlog%00", "%2E%2E"]) {
			const res = await request.get(`api/related-skills/${name}.zip`, {headers: ro});
			expect(res.status(), name).toBe(404);
		}
	});

	test("認証なしでは取れない", async ({playwright}) => {
		const anonymous = await playwright.request.newContext({baseURL: test.info().project.use.baseURL});
		try {
			expect((await anonymous.get("api/related-skills/backlog.zip")).status()).toBe(401);
		} finally {
			await anonymous.dispose();
		}
	});

	test("Document Manager のSkillは、これまでどおり(Backlogは混ざらない)", async ({request}) => {
		const res = await request.get("api/claude-skill.zip", {headers: ro});
		expect(res.status()).toBe(200);
		const names = Object.keys(readZip(await res.body()));
		expect(names.every((name) => name.startsWith("document-manager/"))).toBe(true);
	});
});
