/*!
 * text-diff.js : 2 つの本文(テキスト)の差分
 * Copyright(c) 2026 EARCE.NET <d.idei@earce.net>
 * MIT Licensed
 *
 * 版どうしを比べるときに使う(api/documents/:id/diff)。行ごとに比べ、変わった行の組では
 * 行の中のどの文字が変わったかも返す(画面で色を付ける)。日本語は語の区切りが無いので、
 * 行の中は文字ごとに比べる。
 *
 * 見た目(太字・色・レイアウト)は比べない。本文が同じなら「同じ」になる。
 *
 * 大きすぎる・違いすぎる本文で止まらないよう、比べる時間と返す行の数に上限を置く。
 */

const Diff = require("diff");

// 比べるのにかける時間の上限(ミリ秒)。超えたら「違いが大きすぎて比べられない」を返す
const TIMEOUT_MS = 3000;
// 返す行の上限(前後の行も含む)。超えた分は返さず clipped を立てる
const MAX_OUTPUT_LINES = 5000;
// 行の中の文字を比べるのは、この長さまでの行だけ(長い行は行ごとの色分けだけにする)
const MAX_INLINE_LENGTH = 2000;
// 行の中で変わった文字の割合がこれを超えたら、別の行とみなして文字の色分けをしない
const MAX_INLINE_CHANGE_RATIO = 0.6;
// 前後に付ける、変わっていない行の数の上限(「全文」は ALL_CONTEXT)
const MAX_CONTEXT = 50;
const ALL_CONTEXT = Number.MAX_SAFE_INTEGER;

const normalize = (text) => {
	const value = String(text ?? "").replace(/\r\n?/g, "\n");
	// 末尾の改行のあるなしだけの違いは数えない(取り出した本文は末尾がまちまち)
	return value === "" || value.endsWith("\n") ? value : `${value}\n`;
};

/** 行の中の変わった文字。消した側・足した側それぞれの [{text, changed}] を返す。比べないときは null */
const inlineSegments = (removed, added) => {
	if (removed.length > MAX_INLINE_LENGTH || added.length > MAX_INLINE_LENGTH) return null;
	const parts = Diff.diffChars(removed, added);
	const changedChars = parts.filter((p) => p.added || p.removed).reduce((sum, p) => sum + p.value.length, 0);
	if (changedChars / Math.max(removed.length + added.length, 1) > MAX_INLINE_CHANGE_RATIO) return null;
	return {
		del: parts.filter((p) => !p.added).map((p) => ({text: p.value, changed: Boolean(p.removed)})),
		add: parts.filter((p) => !p.removed).map((p) => ({text: p.value, changed: Boolean(p.added)}))
	};
};

/**
 * @param {string} oldText 比べる元(古い版)
 * @param {string} newText 比べる先(新しい版)
 * @param {{context?: number|"all"}} options context は前後に付ける変わっていない行の数
 * @returns {{status: "same"|"changed"|"too_different", added: number, removed: number, hunks: object[], clipped: boolean}}
 *   hunks[].lines[] は {type: "same"|"add"|"del", oldNo, newNo, text, segments?}
 */
const diffTexts = (oldText, newText, {context = 3} = {}) => {
	const before = normalize(oldText);
	const after = normalize(newText);
	if (before === after) return {status: "same", added: 0, removed: 0, hunks: [], clipped: false};
	const contextLines = context === "all" ? ALL_CONTEXT : Math.min(Math.max(Number.parseInt(context, 10) || 0, 0), MAX_CONTEXT);
	const patch = Diff.structuredPatch("", "", before, after, "", "", {context: contextLines, timeout: TIMEOUT_MS});
	if (patch == null) return {status: "too_different", added: 0, removed: 0, hunks: [], clipped: false};

	let added = 0;
	let removed = 0;
	let output = 0;
	let clipped = false;
	const hunks = [];
	for (const hunk of patch.hunks) {
		// 「末尾に改行が無い」の印は、上で揃えているので出ないが、念のため除く
		const raw = hunk.lines.filter((line) => !line.startsWith("\\"));
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		const lines = raw.map((line) => {
			const text = line.slice(1);
			if (line[0] === "+") {
				added += 1;
				return {type: "add", oldNo: null, newNo: newNo++, text};
			}
			if (line[0] === "-") {
				removed += 1;
				return {type: "del", oldNo: oldNo++, newNo: null, text};
			}
			return {type: "same", oldNo: oldNo++, newNo: newNo++, text};
		});
		// 続いた「消した行」と、その直後の「足した行」を順に組にして、行の中の違いを付ける
		for (let i = 0; i < lines.length;) {
			if (lines[i].type !== "del") {
				i += 1;
				continue;
			}
			const delStart = i;
			while (i < lines.length && lines[i].type === "del") i += 1;
			const addStart = i;
			while (i < lines.length && lines[i].type === "add") i += 1;
			const pairs = Math.min(addStart - delStart, i - addStart);
			for (let k = 0; k < pairs; k += 1) {
				const segments = inlineSegments(lines[delStart + k].text, lines[addStart + k].text);
				if (segments) {
					lines[delStart + k].segments = segments.del;
					lines[addStart + k].segments = segments.add;
				}
			}
		}
		if (clipped) continue;
		if (output + lines.length > MAX_OUTPUT_LINES) {
			clipped = true;
			const room = MAX_OUTPUT_LINES - output;
			if (room > 0) hunks.push({oldStart: hunk.oldStart, newStart: hunk.newStart, lines: lines.slice(0, room)});
			output = MAX_OUTPUT_LINES;
			continue;
		}
		output += lines.length;
		hunks.push({oldStart: hunk.oldStart, newStart: hunk.newStart, lines});
	}
	return {status: "changed", added, removed, hunks, clipped};
};

module.exports = {diffTexts, MAX_OUTPUT_LINES, MAX_CONTEXT};
