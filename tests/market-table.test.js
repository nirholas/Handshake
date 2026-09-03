/**
 * Shared market-table primitives (src/shared/market-table.js), rendered by both
 * /coins and /screener. The two pages used to carry their own copies of this
 * markup and sorting, which is how they drifted apart on aria-sort; the tests
 * here pin the contract they now share.
 */

import { describe, it, expect } from 'vitest';
import {
	coinRow,
	COIN_COLUMNS,
	coinSortValue,
	sortableHeaderCells,
} from '../src/shared/market-table.js';

const ROW = {
	id: 'bitcoin',
	symbol: 'BTC',
	name: 'Bitcoin',
	image: 'https://img/btc.png',
	rank: 1,
	price: 64_000,
	change_24h: 0.58,
	change_7d: 1.71,
	market_cap: 1_290_000_000_000,
	volume_24h: 12_700_000_000,
	sparkline: [1, 2, 3],
};

const cells = (html) => (html.match(/<td/g) || []).length;

describe('coinRow', () => {
	it('renders the 7d chart cell by default', () => {
		const html = coinRow(ROW);
		expect(cells(html)).toBe(COIN_COLUMNS.length + 1);
		expect(html).toContain('<svg');
	});

	// A body row with one more cell than the header row shifts every column
	// under the wrong label, so the /screener table (no chart column) opts out.
	it('omits the chart cell so a 7-column header keeps 7 cells per row', () => {
		const html = coinRow(ROW, { sparkline: false });
		expect(cells(html)).toBe(COIN_COLUMNS.length);
		expect(html).not.toContain('<svg');
	});

	it('escapes remote strings and links to the coin detail page', () => {
		const html = coinRow({ ...ROW, id: 'a b', name: '<img onerror=x>' }, { sparkline: false });
		expect(html).toContain('/coin/a%20b');
		expect(html).not.toContain('<img onerror');
		expect(html).toContain('&lt;img onerror=x&gt;');
	});
});

describe('sortableHeaderCells', () => {
	it('marks the active column and gives every other column aria-sort="none"', () => {
		const html = sortableHeaderCells(COIN_COLUMNS, 'market_cap', 'desc');
		expect(html).toContain('data-key="market_cap" aria-sort="descending"');
		expect((html.match(/aria-sort="none"/g) || []).length).toBe(COIN_COLUMNS.length - 1);
		expect((html.match(/tabindex="0"/g) || []).length).toBe(COIN_COLUMNS.length);
	});

	it('flips the arrow with the direction', () => {
		expect(sortableHeaderCells(COIN_COLUMNS, 'rank', 'asc')).toContain('ascending');
		expect(sortableHeaderCells(COIN_COLUMNS, 'rank', 'desc')).toContain('descending');
	});
});

describe('coinSortValue', () => {
	const byRank = (rows) =>
		[...rows].sort((a, b) => coinSortValue(a, 'rank') - coinSortValue(b, 'rank'));

	it('sorts unranked coins last without producing a NaN comparison', () => {
		expect(coinSortValue({ rank: null }, 'rank') - coinSortValue({ rank: null }, 'rank')).toBe(
			0,
		);
		const order = byRank([
			{ id: 'unranked-a', rank: null },
			{ id: 'btc', rank: 1 },
			{ id: 'unranked-b', rank: null },
			{ id: 'eth', rank: 2 },
		]).map((c) => c.id);
		expect(order.slice(0, 2)).toEqual(['btc', 'eth']);
		expect(order.slice(2).sort()).toEqual(['unranked-a', 'unranked-b']);
	});

	it('sorts names case-insensitively and treats a missing number as zero', () => {
		expect(coinSortValue({ name: 'Bitcoin' }, 'name')).toBe('bitcoin');
		expect(coinSortValue({}, 'market_cap')).toBe(0);
		expect(coinSortValue({ market_cap: 5 }, 'market_cap')).toBe(5);
	});
});
