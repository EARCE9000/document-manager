/*!
 * mockup-token.test.js : モックアップ配信の引換券(app/lib/mockup-token.js)の検証
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 実行: リポジトリ直下で `npm test`
 *
 * この引換券は、モックアップの中身を配信するときに**認証の代わり**になる。
 * つまりここが破られると、認証していない相手にモックアップが見えてしまう。
 * 偽造・使い回し・期限切れの扱いを念入りに確かめる。
 */

process.env.SESSION_SECRET = "test-secret-for-mockup-token";
process.env.MOCKUP_VIEW_TOKEN_MINUTES = "60";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const MockupToken = require("../app/lib/mockup-token.js");

const ID = "mockup-aaaaaaaaaaaa";
const OTHER = "mockup-bbbbbbbbbbbb";

test("発行した券はそのモックアップに対して通る", () => {
	const token = MockupToken.issue(ID, "tester@example.com");
	assert.equal(MockupToken.verify(token, ID), true);
});

test("URLのパスに置ける文字だけを使う(スラッシュが入ると配信パスが壊れる)", () => {
	for (let i = 0; i < 50; i += 1) {
		const token = MockupToken.issue(`mockup-${crypto.randomBytes(6).toString("hex")}`, "tester");
		assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, `URLに使えない文字が入った: ${token}`);
		assert.equal(encodeURIComponent(token), token, "エスケープが要る文字が入っている");
	}
});

test("他のモックアップには使えない(1件だけに効く)", () => {
	const token = MockupToken.issue(ID, "tester");
	assert.equal(MockupToken.verify(token, OTHER), false);
	// IDの前方一致・部分一致でもすり抜けない
	assert.equal(MockupToken.verify(token, ID.slice(0, -1)), false);
	assert.equal(MockupToken.verify(token, `${ID}x`), false);
});

test("期限が切れた券は通らない", () => {
	const token = MockupToken.issue(ID, "tester");
	assert.equal(MockupToken.verify(token, ID), true);

	// 1時間1分だけ時計を進める(本物の待ち時間を使わない)
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + 61 * 60 * 1000;
		assert.equal(MockupToken.verify(token, ID), false, "期限切れを通してはいけない");
	} finally {
		Date.now = realNow;
	}
});

test("中身を書き換えた券は通らない(署名の検証)", () => {
	const token = MockupToken.issue(ID, "tester");
	const [payload, signature] = token.split(".");
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));

	// 対象のモックアップを他に差し替える
	const swapped = Buffer.from(JSON.stringify({...claims, m: OTHER})).toString("base64url");
	assert.equal(MockupToken.verify(`${swapped}.${signature}`, OTHER), false, "対象の差し替えを通してはいけない");

	// 期限を伸ばす
	const extended = Buffer.from(JSON.stringify({...claims, e: claims.e + 86400000})).toString("base64url");
	assert.equal(MockupToken.verify(`${extended}.${signature}`, ID), false, "期限の延長を通してはいけない");

	// 署名だけいじる
	const flipped = Buffer.from(signature, "base64url");
	flipped[0] ^= 0xff;
	assert.equal(MockupToken.verify(`${payload}.${flipped.toString("base64url")}`, ID), false);
});

test("署名を外した・でっち上げた券は通らない", () => {
	const claims = Buffer.from(JSON.stringify({m: ID, e: Date.now() + 3600000})).toString("base64url");
	// 署名なし
	assert.equal(MockupToken.verify(claims, ID), false);
	// 空の署名
	assert.equal(MockupToken.verify(`${claims}.`, ID), false);
	// 別の鍵で署名(鍵を知らない相手が作った券)
	const forged = crypto.createHmac("sha256", "別の鍵").update(claims).digest("base64url");
	assert.equal(MockupToken.verify(`${claims}.${forged}`, ID), false);
});

test("でたらめな値を渡しても例外にならず、単に通らない", () => {
	const inputs = [
		"", ".", "..", "a.b", "....", "-", "_",
		"x".repeat(5000),
		`${Buffer.from("これはJSONではない").toString("base64url")}.${"A".repeat(43)}`,
		null, undefined, 0, 1, true, {}, [], () => {}
	];
	for (const input of inputs) {
		assert.equal(MockupToken.verify(input, ID), false, `通してはいけない: ${String(input)}`);
	}
	// モックアップIDの側がおかしい場合も同じ
	const token = MockupToken.issue(ID, "tester");
	for (const bad of [null, undefined, 0, {}, [], ""]) {
		assert.equal(MockupToken.verify(token, bad), false, `通してはいけないID: ${String(bad)}`);
	}
});

test("発行のたびに違う値になる(期限が秒未満で変わるため)", () => {
	const seen = new Set();
	const realNow = Date.now;
	try {
		let tick = realNow();
		Date.now = () => (tick += 1);
		for (let i = 0; i < 20; i += 1) seen.add(MockupToken.issue(ID, "tester"));
	} finally {
		Date.now = realNow;
	}
	assert.equal(seen.size, 20, "同じ券が出回ると、履歴やログからの使い回しが効きやすくなる");
});
