/*!
 * skill-download-token.test.js : Skill のZIPを取ってくるための引換券(lib/skill-download-token.js)
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * 引換券は認証の代わりに効く。URLはAIエージェントとのチャットに貼られて記録に残るので、
 * 「期限が過ぎたら使えない」「書き換えたら使えない」「別のSkillには使えない」が崩れると、
 * 認証を外したのと同じことになる。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "skill-download-token-test";
const Token = require("../app/lib/skill-download-token.js");

test("発行した券は読め、対象のSkill・発行先・発行時刻が分かる", () => {
	const before = Date.now();
	const {token, expiresAt} = Token.issue("backlog", "user@example.com");
	const ticket = Token.read(token);
	assert.deepEqual({skill: ticket.skill, user: ticket.user}, {skill: "backlog", user: "user@example.com"});
	assert.ok(ticket.issuedAt >= before && ticket.issuedAt <= Date.now());
	// 期限は既定30分
	const minutes = (Date.parse(expiresAt) - ticket.issuedAt) / 60000;
	assert.ok(Math.abs(minutes - Token.TTL_MINUTES) < 0.1, `有効期限が ${minutes} 分`);
	assert.equal(Token.TTL_MINUTES, 30);
});

test("期限を過ぎた券は読めない", () => {
	const {token} = Token.issue("document-manager", "user@example.com");
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + (Token.TTL_MINUTES * 60 + 1) * 1000;
		assert.equal(Token.read(token), null);
	} finally {
		Date.now = realNow;
	}
});

test("中身を書き換えた券は読めない(別のSkill・別の利用者・期限の延長)", () => {
	const {token} = Token.issue("backlog", "user@example.com");
	const [payload, signature] = token.split(".");
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
	for (const forged of [
		{...claims, s: "document-manager"},
		{...claims, u: "admin@example.com"},
		{...claims, e: claims.e + 365 * 24 * 60 * 60 * 1000}
	]) {
		const forgedPayload = Buffer.from(JSON.stringify(forged)).toString("base64url");
		assert.equal(Token.read(`${forgedPayload}.${signature}`), null, JSON.stringify(forged));
	}
});

test("形の崩れた券・空の券・他の用途の券は読めない(例外も出さない)", () => {
	for (const bad of [undefined, null, "", "x", "a.b.c", "....", 123, "eyJ9.@@@"]) {
		assert.equal(Token.read(bad), null, String(bad));
	}
	// モックアップの引換券(別の鍵で署名している)を流用できない
	const MockupToken = require("../app/lib/mockup-token.js");
	assert.equal(Token.read(MockupToken.issue("202610_x", "user@example.com")), null);
});
