// The lexical fallback ranking used when a semantic surface cannot embed its
// query (a down embedder has no cross-provider failover: a vector from another
// lane lives in another space entirely).
import { describe, it, expect } from 'vitest';
import { tokenize, lexicalScore, rankLexically } from '../api/_lib/lexical-rank.js';

describe('tokenize', () => {
	it('lowercases, splits on punctuation and drops stop words and single characters', () => {
		expect(tokenize('The 3D Avatar, and a Rig!')).toEqual(['3d', 'avatar', 'rig']);
	});
	it('keeps non-latin words rather than dropping them', () => {
		expect(tokenize('三次元 avatar')).toEqual(['三次元', 'avatar']);
	});
	it('is shape safe', () => {
		expect(tokenize('')).toEqual([]);
		expect(tokenize(null)).toEqual([]);
		expect(tokenize(undefined)).toEqual([]);
	});
});

describe('lexicalScore', () => {
	const q = 'rigged knight avatar';
	const tokens = tokenize(q);

	it('scores by the share of distinct query terms present', () => {
		const all = lexicalScore(tokens, q, 'a rigged knight avatar you can animate');
		const some = lexicalScore(tokens, q, 'a knight, unrigged and static');
		expect(all).toBeGreaterThan(some);
		expect(some).toBeGreaterThan(0);
	});
	it('gives a contiguous phrase match the strongest evidence available', () => {
		const phrase = lexicalScore(tokens, q, 'this is a rigged knight avatar');
		const scattered = lexicalScore(tokens, q, 'avatar. later: knight. later still: rigged');
		expect(phrase).toBeGreaterThan(scattered);
	});
	it('does not let repetition outrank precision', () => {
		const precise = lexicalScore(tokens, q, 'rigged knight avatar');
		const padded = lexicalScore(tokens, q, `knight ${'knight '.repeat(50)}`);
		expect(precise).toBeGreaterThan(padded);
	});
	it('returns 0 when nothing matches, and stays in range', () => {
		expect(lexicalScore(tokens, q, 'completely unrelated text')).toBe(0);
		expect(lexicalScore(tokens, q, '')).toBe(0);
		expect(lexicalScore([], '', 'anything')).toBe(0);
		expect(lexicalScore(tokens, q, 'rigged knight avatar rigged knight avatar')).toBeLessThanOrEqual(1);
	});
});

describe('rankLexically', () => {
	const docs = [
		{ id: 'a', text: 'A rigged knight avatar ready to animate' },
		{ id: 'b', text: 'A static rock prop' },
		{ id: 'c', text: 'knight helmet, no rig' },
	];

	it('orders by overlap and drops coincidental matches', () => {
		const out = rankLexically('rigged knight avatar', docs);
		expect(out[0].id).toBe('a');
		expect(out.map((r) => r.id)).not.toContain('b');
	});

	it('labels every row as lexical and never invents a semantic score', () => {
		const [top] = rankLexically('rigged knight avatar', docs);
		expect(top.match).toBe('lexical');
		expect(top.score).toBeNull();
		expect(top.lexicalScore).toBeGreaterThan(0);
	});

	it('honours the limit and is shape safe', () => {
		expect(rankLexically('knight', docs, { limit: 1 })).toHaveLength(1);
		expect(rankLexically('', docs)).toEqual([]);
		expect(rankLexically('knight', null)).toEqual([]);
		expect(rankLexically('knight', [{ id: 'x' }])).toEqual([]);
	});
});
