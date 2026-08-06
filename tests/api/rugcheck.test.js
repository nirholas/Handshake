// RugCheck client (api/_lib/rugcheck.js) and its wiring into the Oracle
// live-market aggregator (api/_lib/oracle/market.js) as the second security
// opinion next to GoPlus.
//
// Fixtures mirror the live api.rugcheck.xyz shapes captured 2026-08-05 for
// $THREE (the platform's own promoted coin, the only real mint used here); no
// network is touched (URL-routing fetch mock, oracle-market test style).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { fetchRugcheckSummary, rugcheckLevel } from '../../api/_lib/rugcheck.js';
import { mergeMarketSources, fetchCoinMarket, __resetCoinMarketCache } from '../../api/_lib/oracle/market.js';

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AT = '2026-08-05T00:00:00.000Z';

const realFetch = global.fetch;
const realBirdeyeKey = process.env.BIRDEYE_API_KEY;
afterAll(() => {
	global.fetch = realFetch;
	if (realBirdeyeKey == null) delete process.env.BIRDEYE_API_KEY;
	else process.env.BIRDEYE_API_KEY = realBirdeyeKey;
});

function jres(obj, ok = true, status = 200) {
	return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// Live shape from GET /v1/tokens/{$THREE}/report/summary (captured 2026-08-05).
const THREE_SUMMARY = {
	tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
	tokenType: '',
	risks: [],
	score: 1,
	score_normalised: 1,
	lpLockedPct: 62.07117368099572,
};

describe('fetchRugcheckSummary', () => {
	it('normalizes the live summary shape for $THREE', async () => {
		global.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`https://api.rugcheck.xyz/v1/tokens/${THREE}/report/summary`);
			return jres(THREE_SUMMARY);
		});
		const s = await fetchRugcheckSummary(THREE);
		expect(s.mint).toBe(THREE);
		expect(s.score_normalised).toBe(1);
		expect(s.level).toBe('low');
		expect(s.risks).toEqual([]);
		expect(s.lp_locked_pct).toBeCloseTo(62.07, 1);
		expect(s.token_program).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
	});

	it('maps populated risk findings (live shape: name/value/description/score/level)', async () => {
		global.fetch = vi.fn(async () => jres({
			tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
			tokenType: '',
			risks: [{ name: 'Creator history of rugged tokens', value: '', description: 'Creator has a history of rugging tokens.', score: 115200, level: 'danger' }],
			score: 115201,
			score_normalised: 80,
			lpLockedPct: 0,
		}));
		const s = await fetchRugcheckSummary(THREE);
		expect(s.score_normalised).toBe(80);
		expect(s.level).toBe('critical');
		expect(s.risks).toEqual([
			{ name: 'Creator history of rugged tokens', description: 'Creator has a history of rugging tokens.', level: 'danger', score: 115200 },
		]);
	});

	it('clamps an out-of-range score into 0-100', async () => {
		global.fetch = vi.fn(async () => jres({ risks: [], score_normalised: 250, lpLockedPct: 0 }));
		const s = await fetchRugcheckSummary(THREE);
		expect(s.score_normalised).toBe(100);
		expect(s.level).toBe('critical');
	});

	it('returns null on a non-2xx answer (RugCheck 400s unknown/invalid mints)', async () => {
		global.fetch = vi.fn(async () => jres({ error: 'invalid length, expected 32, got 6' }, false, 400));
		expect(await fetchRugcheckSummary(THREE)).toBeNull();
	});

	it('returns null on a malformed or shape-drifted body', async () => {
		global.fetch = vi.fn(async () => jres({ something: 'else' }));
		expect(await fetchRugcheckSummary(THREE)).toBeNull();
		global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
		expect(await fetchRugcheckSummary(THREE)).toBeNull();
	});
});

describe('rugcheckLevel', () => {
	it('uses the same cut points as buildTokenRisk (22 / 45 / 70)', () => {
		expect(rugcheckLevel(0)).toBe('low');
		expect(rugcheckLevel(21)).toBe('low');
		expect(rugcheckLevel(22)).toBe('medium');
		expect(rugcheckLevel(44)).toBe('medium');
		expect(rugcheckLevel(45)).toBe('high');
		expect(rugcheckLevel(69)).toBe('high');
		expect(rugcheckLevel(70)).toBe('critical');
		expect(rugcheckLevel(null)).toBeNull();
	});
});

// ── mergeMarketSources: GoPlus + RugCheck security blend ─────────────────────

const GOPLUS_PARTIAL = {
	sources: ['goplus'],
	holders: 12943,
	security: { mint_authority_revoked: true, freeze_authority_revoked: true, metadata_mutable: false, transfer_fee_pct: 0, top10_holder_pct: 17.34, source: 'goplus' },
	top_holders: [{ account: 'poolAcct', pct: 3.37, is_locked: false, tag: null }],
};
const RUGCHECK_PARTIAL = {
	sources: ['rugcheck'],
	security: { rugcheck_score: 1, rugcheck_level: 'low', rugcheck_risks: [], lp_locked_pct: 62.07, source: 'rugcheck' },
};
const DEX_PARTIAL = { sources: ['dexscreener'], identity: { symbol: 'three' }, price_usd: 0.0021, change: {}, volume: {}, pairs: [], links: {} };

describe('mergeMarketSources security second opinion', () => {
	it('blends GoPlus facts with the RugCheck grade when both answer', () => {
		const m = mergeMarketSources(THREE, 'mainnet', { dex: DEX_PARTIAL, pump: null, gecko: null, goplus: GOPLUS_PARTIAL, rugcheck: RUGCHECK_PARTIAL, birdeye: null, coingecko: null }, AT);
		expect(m.security.mint_authority_revoked).toBe(true);
		expect(m.security.top10_holder_pct).toBe(17.34);
		expect(m.security.rugcheck_score).toBe(1);
		expect(m.security.rugcheck_level).toBe('low');
		expect(m.security.lp_locked_pct).toBe(62.07);
		expect(m.security.source).toBe('goplus+rugcheck');
		expect(m.sources).toEqual(expect.arrayContaining(['goplus', 'rugcheck']));
	});

	it('RugCheck alone still yields a security block (GoPlus outage fails soft)', () => {
		const m = mergeMarketSources(THREE, 'mainnet', { dex: DEX_PARTIAL, pump: null, gecko: null, goplus: null, rugcheck: RUGCHECK_PARTIAL, birdeye: null, coingecko: null }, AT);
		expect(m.security.rugcheck_score).toBe(1);
		expect(m.security.rugcheck_risks).toEqual([]);
		expect(m.security.source).toBe('rugcheck');
		expect(m.top_holders).toEqual([]);
	});

	it('GoPlus alone keeps its original read (RugCheck outage fails soft)', () => {
		const m = mergeMarketSources(THREE, 'mainnet', { dex: DEX_PARTIAL, pump: null, gecko: null, goplus: GOPLUS_PARTIAL, rugcheck: null, birdeye: null, coingecko: null }, AT);
		expect(m.security.mint_authority_revoked).toBe(true);
		expect(m.security.source).toBe('goplus');
		expect(m.security.rugcheck_score).toBeUndefined();
	});

	it('neither opinion answering leaves security null, as before', () => {
		const m = mergeMarketSources(THREE, 'mainnet', { dex: DEX_PARTIAL, pump: null, gecko: null, goplus: null, rugcheck: null, birdeye: null, coingecko: null }, AT);
		expect(m.security).toBeNull();
	});
});

// ── fetchCoinMarket: RugCheck in the live fan-out ────────────────────────────

function routeFetch(overrides = {}) {
	return vi.fn(async (url) => {
		const u = String(url);
		for (const [needle, answer] of Object.entries(overrides)) {
			if (u.includes(needle)) return answer(u);
		}
		if (u.includes('dexscreener.com')) return jres({ pairs: [{ chainId: 'solana', dexId: 'pumpswap', url: 'https://d/x', pairAddress: 'P', baseToken: { name: 'three.ws', symbol: 'three' }, quoteToken: { symbol: 'SOL' }, priceUsd: '0.0021', priceChange: { h24: 3 }, volume: { h24: 465000 }, liquidity: { usd: 223000 }, marketCap: 2100000 }] });
		if (u.includes('frontend-api-v3.pump.fun')) return jres({}, false, 404);
		if (u.includes('geckoterminal.com')) return jres({ data: { attributes: { decimals: 6, price_usd: '0.0021' } } });
		if (u.includes('gopluslabs.io')) return jres({ result: { [THREE]: { holder_count: 12943, mintable: { status: '0' }, freezable: { status: '0' }, metadata_mutable: { status: '0' }, transfer_fee: {}, holders: [] } } });
		if (u.includes('api.rugcheck.xyz')) return jres(THREE_SUMMARY);
		throw new Error(`unexpected url ${u}`);
	});
}

describe('fetchCoinMarket RugCheck fan-out', () => {
	beforeEach(() => {
		__resetCoinMarketCache();
		delete process.env.BIRDEYE_API_KEY; // Birdeye stays out of these cases
	});

	it('calls RugCheck alongside GoPlus and blends both into security', async () => {
		global.fetch = routeFetch();
		const m = await fetchCoinMarket(THREE, 'mainnet', { fresh: true });
		expect(global.fetch.mock.calls.some(([u]) => String(u).includes(`api.rugcheck.xyz/v1/tokens/${THREE}/report/summary`))).toBe(true);
		expect(m.security.mint_authority_revoked).toBe(true);
		expect(m.security.rugcheck_score).toBe(1);
		expect(m.security.lp_locked_pct).toBeCloseTo(62.07, 1);
		expect(m.security.source).toBe('goplus+rugcheck');
		expect(m.sources).toEqual(expect.arrayContaining(['goplus', 'rugcheck']));
	});

	it('fails soft when RugCheck is down: the read survives with GoPlus-only security', async () => {
		global.fetch = routeFetch({ 'api.rugcheck.xyz': () => { throw new Error('ECONNRESET'); } });
		const m = await fetchCoinMarket(THREE, 'mainnet', { fresh: true });
		expect(m.price.usd).toBe(0.0021);
		expect(m.security.source).toBe('goplus');
		expect(m.security.rugcheck_score).toBeUndefined();
	});

	it('fails soft the other way: GoPlus down, RugCheck still delivers security', async () => {
		global.fetch = routeFetch({ 'gopluslabs.io': () => { throw new Error('ECONNRESET'); } });
		const m = await fetchCoinMarket(THREE, 'mainnet', { fresh: true });
		expect(m.price.usd).toBe(0.0021);
		expect(m.security.source).toBe('rugcheck');
		expect(m.security.rugcheck_level).toBe('low');
	});

	it('skips RugCheck off mainnet, like GoPlus', async () => {
		global.fetch = routeFetch();
		await fetchCoinMarket(THREE, 'devnet', { fresh: true });
		expect(global.fetch.mock.calls.some(([u]) => String(u).includes('api.rugcheck.xyz'))).toBe(false);
	});
});
