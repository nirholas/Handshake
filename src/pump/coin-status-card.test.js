// Unit tests for the shared coin-status formatters. These are the formatting
// primitives copied from the three pre-refactor implementations; locking them
// down here keeps all three surfaces rendering identically.

import { describe, it, expect } from 'vitest';
import {
	formatMcap,
	formatPrice,
	formatPct,
	formatSolMcap,
	formatSolPrice,
	mapCoin,
	mapCurve,
	NO_VALUE,
} from './coin-status-card.js';

describe('formatMcap', () => {
	it('renders billions, millions, and thousands compactly', () => {
		expect(formatMcap(2_400_000_000)).toBe('$2.40B');
		expect(formatMcap(1_200_000)).toBe('$1.20M');
		expect(formatMcap(340_000)).toBe('$340.0K');
	});

	it('renders sub-thousand values as whole dollars', () => {
		expect(formatMcap(420)).toBe('$420');
		expect(formatMcap(0)).toBe('$0');
	});

	it('returns an em dash for non-finite input', () => {
		expect(formatMcap(NaN)).toBe('—');
		expect(formatMcap(Infinity)).toBe('—');
		expect(formatMcap(undefined)).toBe('—');
	});
});

describe('formatPct', () => {
	it('rounds to whole numbers at or above 10%', () => {
		expect(formatPct(34)).toBe('34%');
		expect(formatPct(100)).toBe('100%');
	});

	it('keeps one decimal below 10% (but not at zero)', () => {
		expect(formatPct(7.5)).toBe('7.5%');
		expect(formatPct(0)).toBe('0%');
	});

	it('clamps out-of-range input to 0–100', () => {
		expect(formatPct(-5)).toBe('0%');
		expect(formatPct(140)).toBe('100%');
	});

	it('returns an em dash for non-finite input', () => {
		expect(formatPct(NaN)).toBe('—');
	});
});

describe('formatPrice', () => {
	it('shows small per-token prices with two significant figures', () => {
		expect(formatPrice(0.00012)).toBe('$0.00012');
	});

	it('formats whole-dollar prices to cents', () => {
		expect(formatPrice(1.2)).toBe('$1.20');
	});

	it('rejects zero and non-finite input', () => {
		expect(formatPrice(0)).toBe('—');
		expect(formatPrice(NaN)).toBe('—');
	});
});

describe('SOL denomination', () => {
	it('renders compact SOL market caps', () => {
		expect(formatSolMcap(1_200)).toBe('◎1.20K');
		expect(formatSolMcap(4.312)).toBe('◎4.31');
		expect(formatSolMcap(0.0042)).toBe('◎0.0042');
		expect(formatSolMcap(0)).toBe('◎0');
	});

	it('renders tiny per-token SOL prices without exponent notation', () => {
		expect(formatSolPrice(0.000000028)).toBe('◎0.000000028');
		expect(formatSolPrice(0)).toBe(NO_VALUE);
		expect(formatSolPrice(NaN)).toBe(NO_VALUE);
	});

	// The SOL and USD formatters must agree on the placeholder, or a row that
	// switches source mid-refresh would flicker between two "no value" glyphs.
	it('shares the no-value placeholder with the USD formatters', () => {
		expect(formatSolMcap(NaN)).toBe(formatMcap(NaN));
		expect(formatSolPrice(NaN)).toBe(formatPrice(NaN));
	});
});

// The on-chain lane: a bonding-curve payload from /api/pump/curve, which is the
// only market source that exists on devnet and the fallback on mainnet while
// pump.fun's indexer catches up to a fresh launch.
const CURVE_MINT = '3wsSynthetic11111111111111111111111111111';

function curveBody(overrides = {}) {
	return {
		mint: CURVE_MINT,
		network: 'devnet',
		curve: {
			realSolReserves: '1200000000', // 1.2 SOL raised
			complete: false,
		},
		price: {
			marketCap: '32000000000', // 32 SOL
			buyPricePerToken: '32', // 0.000000032 SOL
		},
		graduation: { progressBps: 1500, solAccumulated: '1200000000' },
		...overrides,
	};
}

describe('mapCurve', () => {
	it('prices a devnet coin in SOL and tags the network', () => {
		const coin = mapCurve(curveBody(), CURVE_MINT, {
			network: 'devnet',
			meta: { symbol: 'RSL', name: 'Rehearsal', createdAt: 1_700_000_000_000 },
		});
		expect(coin.denom).toBe('sol');
		expect(coin.network).toBe('devnet');
		expect(coin.source).toBe('curve');
		expect(coin.mcap).toBeCloseTo(32, 6);
		expect(coin.price).toBeCloseTo(0.000000032, 12);
		expect(coin.graduationPct).toBeCloseTo(15, 6);
		expect(coin.graduated).toBe(false);
		// Identity comes from our own launch record; the curve carries economics.
		expect(coin.symbol).toBe('RSL');
		expect(coin.createdAt).toBe(1_700_000_000_000);
		// A bonding curve has no trade history to total up.
		expect(coin.volume24h).toBeNull();
	});

	it('converts to USD on mainnet when a SOL price is supplied', () => {
		const coin = mapCurve(curveBody({ network: 'mainnet' }), CURVE_MINT, {
			network: 'mainnet',
			solUsd: 200,
		});
		expect(coin.denom).toBe('usd');
		expect(coin.mcap).toBeCloseTo(6400, 6); // 32 SOL × $200
	});

	it('falls back to SOL when the USD rate is unavailable', () => {
		const coin = mapCurve(curveBody({ network: 'mainnet' }), CURVE_MINT, {
			network: 'mainnet',
			solUsd: null,
		});
		expect(coin.denom).toBe('sol');
		expect(coin.mcap).toBeCloseTo(32, 6);
	});

	it('reports a graduated coin at 100% with its DEX price', () => {
		const coin = mapCurve(
			{
				mint: CURVE_MINT,
				network: 'mainnet',
				curve: null,
				graduated: true,
				graduation: { isGraduated: true, progressBps: 10_000 },
				graduatedPrice: { priceUsd: 0.00004, marketCapUsd: 40_000, source: 'jupiter' },
			},
			CURVE_MINT,
			{ network: 'mainnet', solUsd: 200 },
		);
		expect(coin.graduated).toBe(true);
		expect(coin.graduationPct).toBe(100);
		expect(coin.denom).toBe('usd');
		expect(coin.mcap).toBe(40_000);
	});

	it('returns null when the mint has no curve to render', () => {
		expect(mapCurve({ mint: CURVE_MINT, curve: null }, CURVE_MINT)).toBeNull();
		expect(mapCurve(null, CURVE_MINT)).toBeNull();
	});
});

describe('mapCoin', () => {
	it('tags indexer-sourced coins as mainnet USD', () => {
		const coin = mapCoin(
			{ mint: CURVE_MINT, symbol: 'SYN', usd_market_cap: 34_500, total_supply: 1e15 },
			CURVE_MINT,
		);
		expect(coin.denom).toBe('usd');
		expect(coin.network).toBe('mainnet');
		expect(coin.source).toBe('indexer');
	});
});
