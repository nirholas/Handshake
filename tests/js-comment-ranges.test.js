// Source-scanning guards read this codebase with regular expressions, and a
// regex cannot tell code from prose. The image-loading guard proved it: it
// reported three offenders that do not exist, because a security comment in
// src/game/combat-system.js quotes `<img onerror=…>` while explaining why the
// tombstone prompt is built with textContent, and src/ipfs.js names `<img src>`
// while explaining its scheme allowlist. Worse, the codemod the guard tells you
// to run would have rewritten both explanations in place.
//
// commentRanges is the primitive that fixes that class of bug for every such
// scanner, so what it must get right is exactly the places a `/` is not a
// comment: quoted strings, template literals, the code inside `${}`, and
// regular-expression literals. Each of those is a real pattern in src/, and
// each would silently corrupt a scan if the walker lost track of it.

import { describe, it, expect } from 'vitest';
import { commentRanges, isInsideComment, maskComments } from '../scripts/lib/js-comment-ranges.mjs';

/** The comment text the scanner found, for readable assertions. */
function comments(src) {
	return commentRanges(src).map(({ start, end }) => src.slice(start, end));
}

describe('commentRanges', () => {
	it('finds line and block comments', () => {
		expect(comments('const a = 1; // trailing\n/* block */ const b = 2;')).toEqual(['// trailing', '/* block */']);
	});

	it('ignores comment markers inside quoted strings', () => {
		expect(comments(`const url = 'https://three.ws/a'; // real\n`)).toEqual(['// real']);
		expect(comments('const s = "/* not a comment */";')).toEqual([]);
	});

	it('ignores comment markers inside template literals and their expressions', () => {
		expect(comments('const t = `https://three.ws/${id}/img`;')).toEqual([]);
		expect(comments('const t = `${obj["//"]}`; // real')).toEqual(['// real']);
	});

	it('tracks nested template expressions', () => {
		const src = 'const t = `a${ `b${ c["//x"] }d` }e`; // real';
		expect(comments(src)).toEqual(['// real']);
	});

	it('ignores comment markers inside regular-expression literals', () => {
		expect(comments('const re = /^https:\\/\\//; // real')).toEqual(['// real']);
		expect(comments('src.replace(/\\/\\*x\\*\\//g, "");')).toEqual([]);
	});

	it('does not mistake division for a regular expression', () => {
		expect(comments('const ratio = (a) / (b) / (c); // real')).toEqual(['// real']);
	});

	it('leaves an unterminated block comment closed at end of file', () => {
		expect(comments('const a = 1;\n/* never closed')).toEqual(['/* never closed']);
	});
});

describe('maskComments', () => {
	it('preserves length and line numbers so positions stay reportable', () => {
		const src = 'const a = 1; // note\nconst b = 2;\n';
		const masked = maskComments(src);
		expect(masked.length).toBe(src.length);
		expect(masked.split('\n').length).toBe(src.split('\n').length);
		expect(masked).toBe(`const a = 1;${' '.repeat(8)}\nconst b = 2;\n`);
	});

	it('hides a tag quoted in prose but keeps the one the code renders', () => {
		const src = [
			'// A display name like `<img onerror=alert(1)>` must render as text.',
			'export const thumb = (u) => `<img src="${u}" alt="" loading="lazy">`;',
		].join('\n');
		const masked = maskComments(src);
		expect(masked).not.toContain('<img onerror');
		expect(masked).toContain('<img src="${u}" alt="" loading="lazy">');
	});
});

describe('isInsideComment', () => {
	it('answers for positions before, inside and after each range', () => {
		const src = 'a; // one\nb; /* two */ c;';
		const ranges = commentRanges(src);
		expect(isInsideComment(ranges, src.indexOf('a'))).toBe(false);
		expect(isInsideComment(ranges, src.indexOf('one'))).toBe(true);
		expect(isInsideComment(ranges, src.indexOf('b'))).toBe(false);
		expect(isInsideComment(ranges, src.indexOf('two'))).toBe(true);
		expect(isInsideComment(ranges, src.indexOf('c'))).toBe(false);
	});
});
