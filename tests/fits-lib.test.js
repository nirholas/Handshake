// Helpers for /fits (the public cosmetics economy). These format money that
// real creators are owed and rank fits by scarcity, so the edges matter:
// sub-cent sales must not collapse to $0.00, and a headline number must never
// disagree with the rows rendered beneath it.
import { describe, it, expect } from 'vitest';

import {
	rarityRank,
	fmtUsdc,
	fmtCount,
	shortWallet,
	displayAccount,
	rankFits,
	summarizeBoard,
	boardIsEmpty,
	coinWorldUrl,
	solscanAccountUrl,
	looksLikeWallet,
	RARITY_LABEL,
} from '../src/fits-lib.js';

const WALLET = '9wgvwps9qK5jNniC5RJdrYCfaV3CLKTnxYVqBjXwegEV';

describe('fmtUsdc', () => {
	it('renders ordinary amounts as dollars', () => {
		expect(fmtUsdc(0.25)).toBe('$0.25');
		expect(fmtUsdc(1)).toBe('$1.00');
		expect(fmtUsdc(12.5)).toBe('$12.50');
	});

	it('keeps precision below a cent instead of collapsing to $0.00', () => {
		expect(fmtUsdc(0.001)).toBe('$0.001');
		expect(fmtUsdc(0.0005)).toBe('$0.0005');
	});

	it('rounds and groups large totals', () => {
		expect(fmtUsdc(1234.56)).toBe('$1,235');
	});

	it('never throws on garbage', () => {
		expect(fmtUsdc(null)).toBe('$0.00');
		expect(fmtUsdc(undefined)).toBe('$0.00');
		expect(fmtUsdc('not-a-number')).toBe('$0.00');
		expect(fmtUsdc(0)).toBe('$0.00');
	});
});

describe('rarity', () => {
	it('orders tiers by scarcity', () => {
		expect(rarityRank('legendary')).toBeGreaterThan(rarityRank('epic'));
		expect(rarityRank('epic')).toBeGreaterThan(rarityRank('rare'));
		expect(rarityRank('rare')).toBeGreaterThan(rarityRank('common'));
	});

	it('treats an unknown tier as the lowest rather than throwing', () => {
		expect(rarityRank('mythic')).toBe(0);
		expect(rarityRank(null)).toBe(0);
	});

	it('has a label for every tier it ranks', () => {
		for (const tier of ['common', 'rare', 'epic', 'legendary']) {
			expect(RARITY_LABEL[tier]).toBeTruthy();
		}
	});
});

describe('rankFits', () => {
	it('puts the fewest-owned fit first', () => {
		const ranked = rankFits([
			{ name: 'c', owners: 9, rarity: 'rare' },
			{ name: 'a', owners: 1, rarity: 'common' },
			{ name: 'b', owners: 4, rarity: 'epic' },
		]);
		expect(ranked.map((f) => f.name)).toEqual(['a', 'b', 'c']);
	});

	it('breaks owner-count ties by rarity, not input order', () => {
		const ranked = rankFits([
			{ name: 'rare-one', owners: 2, rarity: 'rare' },
			{ name: 'legendary-one', owners: 2, rarity: 'legendary' },
		]);
		expect(ranked[0].name).toBe('legendary-one');
	});

	it('does not mutate the caller array', () => {
		const input = [{ owners: 5 }, { owners: 1 }];
		rankFits(input);
		expect(input[0].owners).toBe(5);
	});

	it('handles missing input', () => {
		expect(rankFits(undefined)).toEqual([]);
	});
});

describe('displayAccount / shortWallet', () => {
	it('labels guest session handles rather than truncating them into noise', () => {
		expect(displayAccount('g_threews_live_demo')).toBe('Guest');
		expect(displayAccount('guest-t6q8ci22bj')).toBe('Guest');
	});

	it('truncates real wallets', () => {
		expect(displayAccount(WALLET)).toBe('9wgv…egEV');
		expect(shortWallet('short')).toBe('short');
	});
});

describe('summarizeBoard', () => {
	const board = {
		rarestFits: [
			{ name: 'Headbang', owners: 2, rarity: 'rare' },
			{ name: 'Crimson', owners: 3, rarity: 'rare' },
		],
		topCollectors: [{ account: 'g_a', flexScore: 4, fits: 1 }],
		topCreators: [
			{ wallet: WALLET, sales: 1, earnedUsdc: 0.25 },
			{ wallet: 'other', sales: 2, earnedUsdc: 0.5 },
		],
		recent: [{ priceUsdc: 0.5 }, { priceUsdc: 0.25 }],
	};

	it('derives headline numbers from the same rows the page renders', () => {
		const s = summarizeBoard(board);
		expect(s.fitsTracked).toBe(2);
		expect(s.collectors).toBe(1);
		expect(s.creators).toBe(2);
		expect(s.creatorSales).toBe(3);
		expect(s.creatorEarnedUsdc).toBeCloseTo(0.75);
		expect(s.recentGrossUsdc).toBeCloseTo(0.75);
		expect(s.recentSales).toBe(2);
	});

	it('reports the scarcest fit, not merely the first', () => {
		expect(summarizeBoard(board).rarest.name).toBe('Headbang');
	});

	it('skips unparseable amounts instead of producing NaN', () => {
		const s = summarizeBoard({ recent: [{ priceUsdc: 'x' }, { priceUsdc: 1 }], topCreators: [] });
		expect(s.recentGrossUsdc).toBe(1);
	});

	it('is safe on an empty or absent board', () => {
		const s = summarizeBoard(null);
		expect(s.fitsTracked).toBe(0);
		expect(s.recentGrossUsdc).toBe(0);
		expect(s.rarest).toBe(null);
	});
});

describe('boardIsEmpty', () => {
	it('is true only when every section is empty', () => {
		expect(boardIsEmpty(null)).toBe(true);
		expect(boardIsEmpty({ rarestFits: [], topCollectors: [], topCreators: [], recent: [] })).toBe(
			true,
		);
		expect(boardIsEmpty({ rarestFits: [], topCollectors: [], topCreators: [], recent: [{}] })).toBe(
			false,
		);
	});
});

describe('links', () => {
	it('deep-links a fit to its coin world, URL-encoded', () => {
		expect(coinWorldUrl('MintABC')).toBe('/play?coin=MintABC');
		expect(coinWorldUrl('a/b')).toBe('/play?coin=a%2Fb');
	});

	it('returns null for a missing mint so callers render plain text', () => {
		expect(coinWorldUrl(null)).toBe(null);
		expect(coinWorldUrl('  ')).toBe(null);
		expect(solscanAccountUrl('')).toBe(null);
	});

	it('builds a solscan account link', () => {
		expect(solscanAccountUrl(WALLET)).toBe(`https://solscan.io/account/${WALLET}`);
	});
});

describe('looksLikeWallet', () => {
	it('accepts a base58 Solana address', () => {
		expect(looksLikeWallet(WALLET)).toBe(true);
	});

	it('rejects obvious typos before spending a request', () => {
		expect(looksLikeWallet('')).toBe(false);
		expect(looksLikeWallet('too-short')).toBe(false);
		expect(looksLikeWallet('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(false);
		// 0, O, I and l are not in the base58 alphabet.
		expect(looksLikeWallet('0OIl'.repeat(9))).toBe(false);
	});
});

describe('fmtCount', () => {
	it('groups thousands and survives junk', () => {
		expect(fmtCount(1234)).toBe('1,234');
		expect(fmtCount(null)).toBe('0');
		expect(fmtCount('x')).toBe('0');
	});
});
