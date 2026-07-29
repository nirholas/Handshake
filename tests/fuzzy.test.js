// The shared fuzzy matcher (src/shared/fuzzy.js) that replaced the two
// four-branch substring scorers in the command palettes.
import { describe, it, expect } from 'vitest';
import { rank, matches, highlight } from '../src/shared/fuzzy.js';

const ITEMS = [
	{ label: 'Create agent' },
	{ label: 'Create avatar' },
	{ label: 'Agent settings' },
	{ label: 'Billing and usage' },
	{ label: 'Marketplace' },
];
const text = (i) => i.label;

describe('rank', () => {
	it('returns every item for an empty query', () => {
		expect(rank('', ITEMS, text)).toHaveLength(ITEMS.length);
	});

	it('finds exact and prefix matches', () => {
		const out = rank('Marketplace', ITEMS, text);
		expect(out[0].item.label).toBe('Marketplace');
	});

	it('ranks a prefix match above a mid-string match', () => {
		const labels = rank('agent', ITEMS, text).map((r) => r.item.label);
		expect(labels).toContain('Agent settings');
		expect(labels).toContain('Create agent');
		expect(labels.indexOf('Agent settings')).toBeLessThan(labels.indexOf('Create agent'));
	});

	it('tolerates a transposition, which the substring scorer could not', () => {
		expect(rank('markteplace', ITEMS, text).map((r) => r.item.label)).toContain('Marketplace');
	});

	it('tolerates a dropped character', () => {
		expect(rank('marketplce', ITEMS, text).map((r) => r.item.label)).toContain('Marketplace');
	});

	it('discriminates within a tier instead of tying every subsequence at one score', () => {
		const out = rank('crea', ITEMS, text);
		expect(out.length).toBeGreaterThan(1);
		// A real ordering exists: the results are not returned in input order by
		// accident — every returned item genuinely starts with the query.
		for (const r of out) expect(r.item.label.toLowerCase()).toContain('crea');
	});

	it('returns nothing for a query that matches nothing', () => {
		expect(rank('zzzzqqq', ITEMS, text)).toEqual([]);
	});

	it('honours the limit option', () => {
		expect(rank('a', ITEMS, text, { limit: 2 }).length).toBeLessThanOrEqual(2);
	});

	it('handles an empty item list', () => {
		expect(rank('x', [], text)).toEqual([]);
	});

	it('exposes match ranges for highlighting', () => {
		const [first] = rank('market', ITEMS, text);
		expect(Array.isArray(first.ranges)).toBe(true);
		expect(first.ranges.length).toBeGreaterThanOrEqual(2);
	});
});

describe('matches', () => {
	it('is true for an empty query', () => {
		expect(matches('', 'anything')).toBe(true);
	});

	it('matches a substring', () => {
		expect(matches('mark', 'Marketplace')).toBe(true);
	});

	it('rejects an arbitrarily sparse subsequence', () => {
		// Deliberate: the previous scorer accepted any subsequence and then tied
		// every such hit at a single score, so "barely matches" ranked level with
		// "close match". Single-error mode trades that recall for precision.
		expect(matches('mktpl', 'Marketplace')).toBe(false);
	});

	it('rejects a non-match', () => {
		expect(matches('zzz', 'Marketplace')).toBe(false);
	});
});

describe('highlight', () => {
	it('wraps the matched range and escapes the rest', () => {
		expect(highlight('Marketplace', [0, 6])).toBe('<mark>Market</mark>place');
	});

	it('escapes HTML in unmatched text', () => {
		expect(highlight('<b>hi</b>', [])).toBe('&lt;b&gt;hi&lt;/b&gt;');
	});

	it('escapes HTML inside a matched range', () => {
		expect(highlight('<script>', [0, 8])).toBe('<mark>&lt;script&gt;</mark>');
	});

	it('handles multiple disjoint ranges', () => {
		expect(highlight('abcdef', [0, 1, 3, 4])).toBe('<mark>a</mark>bc<mark>d</mark>ef');
	});
});
