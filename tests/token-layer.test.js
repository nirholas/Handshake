// Unit tests for the $THREE on-chain token layer (api/_lib/token/*).
//
// All external calls are mocked: no live RPC, no DB, no cache. The tests
// prove the cryptographic correctness of the quote lifecycle, split math,
// boot guards, and on-chain verification logic — the parts that must never
// be wrong in production.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheGetFresh: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
	cacheDel: vi.fn(async () => {}),
	// The market-data fallback chain single-flights through the shared lock and
	// reads through cacheWrap; without these the chain dies on a missing export
	// instead of on the upstream it is meant to be exercising.
	acquireLock: vi.fn(async () => true),
	releaseLock: vi.fn(async () => {}),
	cacheWrap: vi.fn(async (_key, _ttl, fn) => fn()),
	cacheWrapLastGood: vi.fn(async (_key, _ttl, fn) => fn()),
}));

vi.mock('../api/_lib/db.js', () => {
	const queue = [];
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	sql.__queue = queue;
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

// Module-level variable controlled per test so the Connection mock (a real
// class) can return different parsed tx responses without needing vi.fn
// as a constructor argument (arrow functions aren't constructors).
let _mockTxResponse = undefined;
vi.mock('@solana/web3.js', async (importOriginal) => {
	const real = await importOriginal();
	class MockConnection {
		// eslint-disable-next-line no-unused-vars
		constructor(_url, _commitment) {}
		async getParsedTransaction() {
			if (_mockTxResponse === undefined) throw new Error('tx_not_found_mock');
			return _mockTxResponse;
		}
	}
	return { ...real, Connection: MockConnection };
});

// Controlled fetch: set responses per-test via mockFetch.
let fetchResponses = [];
const mockFetch = (url, opts = {}) => {
	const resp = fetchResponses.shift();
	if (!resp) throw new Error(`Unexpected fetch: ${url}`);
	if (resp.error) return Promise.reject(resp.error);
	const body = resp.body;
	// text() has to serialize the SAME body json() returns: the upstream fetch
	// wrapper reads text() and parses it, so a stub that answered with the status
	// string made every parsed body come back as the number 200.
	const asText = body === undefined
		? String(resp.status ?? 200)
		: (typeof body === 'string' ? body : JSON.stringify(body));
	return Promise.resolve({
		ok: resp.ok ?? true,
		status: resp.status ?? 200,
		headers: new Headers(resp.headers || {}),
		json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
		text: async () => asText,
	});
};
vi.stubGlobal('fetch', mockFetch);

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
	TOKEN_MINT,
	TOKEN_DECIMALS,
	ATOMICS_PER_TOKEN,
	SPLIT_POLICIES,
	resolveSplitLegs,
	applySplit,
	treasuryWallet,
	burnAddress,
	publicConfig,
} from '../api/_lib/token/config.js';
import { getTokenPriceUsd, quoteTokenForUsd, atomicsToTokens } from '../api/_lib/token/price.js';
import { __resetMarketCache } from '../api/_lib/market/token-market.js';
import { issueQuote, verifyQuote } from '../api/_lib/token/quote.js';
import { verifyOnChain } from '../api/_lib/token/payments.js';
import { cacheGet, cacheSet } from '../api/_lib/cache.js';
import { sql } from '../api/_lib/db.js';

beforeEach(() => {
	fetchResponses = [];
	vi.clearAllMocks();
	cacheGet.mockResolvedValue(null);
	cacheSet.mockResolvedValue();
	sql.mockResolvedValue([]);
	__resetMarketCache();
});

afterEach(() => {
	if (fetchResponses.length) {
		throw new Error(`Test left ${fetchResponses.length} unconsumed fetch mock(s)`);
	}
});

// ── Config ────────────────────────────────────────────────────────────────────

describe('token config', () => {
	it('exports the canonical $THREE mint', () => {
		expect(TOKEN_MINT).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});

	it('exports 6 decimals and correct atomics multiplier', () => {
		expect(TOKEN_DECIMALS).toBe(6);
		expect(ATOMICS_PER_TOKEN).toBe(1_000_000n);
	});

	it('burnAddress returns the incinerator', () => {
		expect(burnAddress()).toBe('1nc1nerator11111111111111111111111111111111');
	});

	it('publicConfig includes expected fields', () => {
		const c = publicConfig();
		expect(c.mint).toBe(TOKEN_MINT);
		expect(c.symbol).toBe('$THREE');
		expect(c.decimals).toBe(6);
		// Burn address is retained for the user-invoked burn primitive only.
		expect(c.burn_address).toBe('1nc1nerator11111111111111111111111111111111');
		// Rewards (reflections) pool is the deflation-free alternative to burning.
		expect('rewards_wallet' in c).toBe(true);
		expect(c.quote_ttl_seconds).toBeGreaterThan(0);
		expect(c.split_policies.consumption).toBeDefined();
		expect(c.split_policies.spin).toBeDefined();
		expect(c.split_policies.marketplace_sale).toBeDefined();
		expect(c.split_policies.scarcity_mint).toBeDefined();
	});

	it('no platform split policy routes to a burn leg', () => {
		for (const [name, legs] of Object.entries(SPLIT_POLICIES)) {
			expect(legs.some((l) => l.role === 'burn'), `${name} must not burn`).toBe(false);
		}
	});

	it('treasuryWallet warns in dev when unset and falls back to burn', () => {
		const prior = process.env.THREE_TREASURY_WALLET;
		delete process.env.THREE_TREASURY_WALLET;
		const w = treasuryWallet();
		expect(w).toBe(burnAddress());
		if (prior !== undefined) process.env.THREE_TREASURY_WALLET = prior;
	});

	it('treasuryWallet throws a typed 503 in production when unset', () => {
		const priorNode = process.env.NODE_ENV;
		const priorWallet = process.env.THREE_TREASURY_WALLET;
		process.env.NODE_ENV = 'production';
		delete process.env.THREE_TREASURY_WALLET;
		// The quote endpoint translates this exact code into an honest 503; lock it.
		expect(() => treasuryWallet()).toThrow(/THREE_TREASURY_WALLET/);
		expect(() => treasuryWallet()).toThrowError(
			expect.objectContaining({ status: 503, code: 'treasury_unavailable' }),
		);
		process.env.NODE_ENV = priorNode;
		if (priorWallet !== undefined) process.env.THREE_TREASURY_WALLET = priorWallet;
	});

	it('publicConfig never throws in production when treasury/rewards unset — read path stays 200', () => {
		// Regression: the read-only config endpoint must not 500 just because a
		// fund-routing env var is unset. The strict treasuryWallet()/rewardsWallet()
		// guards belong on fund movement only; publicConfig uses the *OrNull lookups.
		const priorNode = process.env.NODE_ENV;
		const priorTreasury = process.env.THREE_TREASURY_WALLET;
		const priorRewards = process.env.THREE_REWARDS_WALLET;
		process.env.NODE_ENV = 'production';
		delete process.env.THREE_TREASURY_WALLET;
		delete process.env.THREE_REWARDS_WALLET;
		let c;
		expect(() => {
			c = publicConfig();
		}).not.toThrow();
		expect(c.treasury).toBeNull();
		expect(c.treasury_configured).toBe(false);
		expect(c.rewards_wallet).toBeNull();
		expect(c.rewards_configured).toBe(false);
		// Non-treasury fields still resolve so the client renders a useful state.
		expect(c.mint).toBe(TOKEN_MINT);
		expect(c.split_policies.consumption).toBeDefined();
		process.env.NODE_ENV = priorNode;
		if (priorTreasury !== undefined) process.env.THREE_TREASURY_WALLET = priorTreasury;
		if (priorRewards !== undefined) process.env.THREE_REWARDS_WALLET = priorRewards;
	});
});

// ── Split policy ───────────────────────────────────────────────────────────────

describe('resolveSplitLegs', () => {
	it('every policy sums to exactly 10000 bps', () => {
		for (const name of Object.keys(SPLIT_POLICIES)) {
			const opts = SPLIT_POLICIES[name].some((l) => l.role === 'seller')
				? { sellerWallet: 'So11111111111111111111111111111111111111112' }
				: {};
			const legs = resolveSplitLegs(name, opts);
			expect(legs.reduce((s, l) => s + l.bps, 0), `${name}`).toBe(10_000);
		}
	});

	it('consumption policy yields treasury + rewards legs (no burn)', () => {
		const legs = resolveSplitLegs('consumption');
		expect(legs).toHaveLength(2);
		expect(legs.find((l) => l.role === 'treasury').bps).toBe(7000);
		expect(legs.find((l) => l.role === 'rewards').bps).toBe(3000);
		expect(legs.find((l) => l.role === 'burn')).toBeUndefined();
	});

	it('spin policy routes the former burn half to rewards instead', () => {
		const legs = resolveSplitLegs('spin');
		expect(legs).toHaveLength(2);
		expect(legs.find((l) => l.role === 'treasury').bps).toBe(5000);
		expect(legs.find((l) => l.role === 'rewards').bps).toBe(5000);
		expect(legs.find((l) => l.role === 'burn')).toBeUndefined();
	});

	it('marketplace_sale yields seller + treasury + rewards legs', () => {
		const seller = 'So11111111111111111111111111111111111111112';
		const legs = resolveSplitLegs('marketplace_sale', { sellerWallet: seller });
		expect(legs).toHaveLength(3);
		expect(legs.find((l) => l.role === 'seller').bps).toBe(9000);
		expect(legs.find((l) => l.role === 'treasury').bps).toBe(500);
		expect(legs.find((l) => l.role === 'rewards').bps).toBe(500);
		expect(legs.find((l) => l.role === 'seller').address).toBe(seller);
	});

	it('scarcity_mint yields treasury + rewards legs (no seller, no burn)', () => {
		const legs = resolveSplitLegs('scarcity_mint');
		expect(legs.find((l) => l.role === 'treasury').bps).toBe(8000);
		expect(legs.find((l) => l.role === 'rewards').bps).toBe(2000);
		expect(legs.find((l) => l.role === 'seller')).toBeUndefined();
	});

	it('marketplace_sale throws when sellerWallet is missing', () => {
		expect(() => resolveSplitLegs('marketplace_sale')).toThrow(/sellerWallet/);
	});

	it('throws on unknown policy name', () => {
		expect(() => resolveSplitLegs('nonexistent_policy')).toThrow(/unknown split policy/);
	});
});

describe('applySplit', () => {
	it('spin: 50/50 split with no remainder', () => {
		const legs = resolveSplitLegs('spin');
		const result = applySplit(2_000_000n, legs);
		expect(result[0].atomics).toBe(1_000_000n);
		expect(result[1].atomics).toBe(1_000_000n);
	});

	it('spin: odd total — remainder goes to the highest-bps leg (treasury=rewards tie)', () => {
		const legs = resolveSplitLegs('spin');
		const result = applySplit(1_000_001n, legs);
		const total = result.reduce((s, l) => s + l.atomics, 0n);
		expect(total).toBe(1_000_001n);
		// Both legs are 50/50; either may absorb the 1-atom remainder — just verify sum
	});

	it('marketplace_sale: 90/5/5 split is exact on 1_000_000', () => {
		const legs = resolveSplitLegs('marketplace_sale', {
			sellerWallet: 'So11111111111111111111111111111111111111112',
		});
		const result = applySplit(1_000_000n, legs);
		expect(result.find((l) => l.role === 'seller').atomics).toBe(900_000n);
		expect(result.find((l) => l.role === 'treasury').atomics).toBe(50_000n);
		expect(result.find((l) => l.role === 'rewards').atomics).toBe(50_000n);
	});

	it('marketplace_sale: 95/5 split on odd total sums exactly', () => {
		const legs = resolveSplitLegs('marketplace_sale', {
			sellerWallet: 'So11111111111111111111111111111111111111112',
		});
		const result = applySplit(1_000_007n, legs);
		const total = result.reduce((s, l) => s + l.atomics, 0n);
		expect(total).toBe(1_000_007n);
	});

	it('handles string and number totals', () => {
		const legs = resolveSplitLegs('spin');
		const r1 = applySplit('2000000', legs);
		const r2 = applySplit(2000000, legs);
		expect(r1[0].atomics).toBe(r2[0].atomics);
	});

	it('zero total produces zero atomics on all legs', () => {
		const legs = resolveSplitLegs('spin');
		const result = applySplit(0n, legs);
		expect(result.every((l) => l.atomics === 0n)).toBe(true);
	});
});

// ── Price ─────────────────────────────────────────────────────────────────────

describe('getTokenPriceUsd', () => {
	it('returns Jupiter price and caches it', async () => {
		fetchResponses.push({
			body: { [TOKEN_MINT]: { usdPrice: 0.000307 } },
		});
		const p = await getTokenPriceUsd({ fresh: true });
		expect(p.priceUsd).toBe(0.000307);
		expect(p.source).toBe('jupiter');
		expect(p.mint).toBe(TOKEN_MINT);
		// Writes the live cache AND the long-lived last-known-good entry.
		expect(cacheSet).toHaveBeenCalledTimes(2);
	});

	it('falls back to Birdeye when Jupiter returns null price', async () => {
		const priorKey = process.env.BIRDEYE_API_KEY;
		process.env.BIRDEYE_API_KEY = 'test-key';
		// Jupiter returns with missing field → null
		fetchResponses.push({ body: { [TOKEN_MINT]: {} } });
		// Market module's first source is Birdeye token_overview ({ data: { price } }).
		fetchResponses.push({ body: { data: { price: 0.0004 } } });
		const p = await getTokenPriceUsd({ fresh: true });
		expect(p.priceUsd).toBe(0.0004);
		expect(p.source).toBe('birdeye');
		if (priorKey !== undefined) process.env.BIRDEYE_API_KEY = priorKey;
		else delete process.env.BIRDEYE_API_KEY;
	});

	it('serves from cache on warm hit', async () => {
		const cached = {
			priceUsd: 0.0005,
			source: 'jupiter',
			mint: TOKEN_MINT,
			at: new Date().toISOString(),
		};
		cacheGet.mockResolvedValueOnce(cached);
		const p = await getTokenPriceUsd();
		expect(p.priceUsd).toBe(0.0005);
		expect(fetchResponses.length).toBe(0); // no upstream call
	});

	it('throws price_unavailable when all feeds fail', async () => {
		const priorKey = process.env.BIRDEYE_API_KEY;
		process.env.BIRDEYE_API_KEY = 'test-key';
		// Jupiter, then the market module's three sources (Birdeye, DexScreener,
		// GeckoTerminal) all 503 → no price → price_unavailable.
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // jupiter
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // birdeye
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // dexscreener
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // geckoterminal
		await expect(getTokenPriceUsd({ fresh: true })).rejects.toMatchObject({
			code: 'price_unavailable',
		});
		if (priorKey !== undefined) process.env.BIRDEYE_API_KEY = priorKey;
		else delete process.env.BIRDEYE_API_KEY;
	});

	it('serves a recent last-known-good price when every live feed misses', async () => {
		const priorKey = process.env.BIRDEYE_API_KEY;
		process.env.BIRDEYE_API_KEY = 'test-key';
		// All four live feeds miss this request...
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // jupiter
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // birdeye
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // dexscreener
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // geckoterminal
		// ...but a 60s-old last-known-good is in cache (live key miss, last-good hit).
		cacheGet.mockResolvedValueOnce(null); // live PRICE_CACHE_KEY (skipped on fresh, harmless)
		cacheGet.mockResolvedValueOnce({
			priceUsd: 0.00042,
			source: 'jupiter',
			mint: TOKEN_MINT,
			at: new Date(Date.now() - 60_000).toISOString(),
		});
		const p = await getTokenPriceUsd({ fresh: true });
		expect(p.priceUsd).toBe(0.00042);
		expect(p.stale).toBe(true);
		expect(p.source).toBe('jupiter-stale');
		if (priorKey !== undefined) process.env.BIRDEYE_API_KEY = priorKey;
		else delete process.env.BIRDEYE_API_KEY;
	});

	it('rejects a last-known-good price older than the staleness window', async () => {
		const priorKey = process.env.BIRDEYE_API_KEY;
		process.env.BIRDEYE_API_KEY = 'test-key';
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // jupiter
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // birdeye
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // dexscreener
		fetchResponses.push({ ok: false, status: 503, body: 'down' }); // geckoterminal
		// A 10-minute-old price is beyond the 5-minute window → still fail rather
		// than price a payment off a stale number.
		cacheGet.mockResolvedValue({
			priceUsd: 0.00042,
			source: 'jupiter',
			mint: TOKEN_MINT,
			at: new Date(Date.now() - 600_000).toISOString(),
		});
		await expect(getTokenPriceUsd({ fresh: true })).rejects.toMatchObject({
			code: 'price_unavailable',
		});
		if (priorKey !== undefined) process.env.BIRDEYE_API_KEY = priorKey;
		else delete process.env.BIRDEYE_API_KEY;
	});
});

describe('quoteTokenForUsd', () => {
	it('converts USD to correct atomics at given price', async () => {
		fetchResponses.push({ body: { [TOKEN_MINT]: { usdPrice: 0.001 } } });
		const q = await quoteTokenForUsd(1.0);
		// $1 / $0.001 per token = 1000 tokens = 1_000_000_000 atomics (6 decimals)
		expect(q.atomics).toBe(1_000_000_000n);
		expect(q.tokenAmount).toBeCloseTo(1000, 2);
		expect(q.usd).toBe(1.0);
	});

	it('rejects non-positive USD', async () => {
		await expect(quoteTokenForUsd(0)).rejects.toMatchObject({ code: 'bad_request' });
		await expect(quoteTokenForUsd(-1)).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('rejects NaN', async () => {
		await expect(quoteTokenForUsd(NaN)).rejects.toMatchObject({ code: 'bad_request' });
	});

	// GET /api/token/price?usd= feeds this straight from the query string. At a
	// sub-cent price a large-but-finite USD figure scales past Number.MAX_VALUE,
	// and BigInt(Infinity) is a RangeError: unguarded it surfaced as an
	// unauthenticated 500 with a Sentry capture and an ops alert per hit.
	it('rejects a USD amount whose atomics overflow the float range', async () => {
		fetchResponses.push({ body: { [TOKEN_MINT]: { usdPrice: 0.0017 } } });
		await expect(quoteTokenForUsd(1e300)).rejects.toMatchObject({
			code: 'amount_too_large',
			status: 422,
		});
	});

	it('quotes against a caller-supplied price without a second lookup', async () => {
		// No fetch response is queued: a live lookup here would throw "Unexpected fetch".
		const q = await quoteTokenForUsd(2, {
			price: { priceUsd: 0.002, source: 'caller', at: '2026-08-16T00:00:00.000Z' },
		});
		expect(q.priceUsd).toBe(0.002);
		expect(q.source).toBe('caller');
		expect(q.priceAt).toBe('2026-08-16T00:00:00.000Z');
		expect(q.atomics).toBe(1_000_000_000n);
	});
});

describe('atomicsToTokens', () => {
	it('converts 1_000_000 atomics to 1.0 token', () => {
		expect(atomicsToTokens(1_000_000n)).toBe(1.0);
	});

	it('converts 500_000 atomics to 0.5 token', () => {
		expect(atomicsToTokens(500_000n)).toBeCloseTo(0.5);
	});
});

// ── Quote sign / verify ───────────────────────────────────────────────────────

describe('issueQuote + verifyQuote', () => {
	async function makeQuote(overrides = {}) {
		fetchResponses.push({ body: { [TOKEN_MINT]: { usdPrice: 0.001 } } });
		return issueQuote({
			purpose: 'spin',
			usd: 0.5,
			splitPolicy: 'spin',
			refType: 'spin',
			refId: 'test-spin-42',
			...overrides,
		});
	}

	it('issues a verifiable quote token', async () => {
		const { token, quote } = await makeQuote();
		expect(typeof token).toBe('string');
		expect(token).toContain('.');
		const v = verifyQuote(token);
		expect(v.nonce).toBe(quote.nonce);
		expect(v.purpose).toBe('spin');
		expect(v.total).toBe(quote.total);
		expect(v.legs).toHaveLength(2);
	});

	it('quote legs atomics sum equals total', async () => {
		const { quote } = await makeQuote();
		const sum = quote.legs.reduce((s, l) => s + BigInt(l.atomics), 0n);
		expect(sum.toString()).toBe(quote.total);
	});

	it('quote includes nonce, iat, exp', async () => {
		const { quote } = await makeQuote();
		expect(quote.nonce).toBeTruthy();
		expect(quote.iat).toBeGreaterThan(0);
		expect(quote.exp).toBeGreaterThan(quote.iat);
	});

	it('rejects tampered body', async () => {
		const { token } = await makeQuote();
		const [body, sig] = token.split('.');
		const tampered = body.slice(0, -2) + 'ZZ';
		expect(() => verifyQuote(`${tampered}.${sig}`)).toThrow();
	});

	it('rejects tampered signature', async () => {
		const { token } = await makeQuote();
		const [body, sig] = token.split('.');
		const tampered = sig.slice(0, -2) + 'ZZ';
		expect(() => verifyQuote(`${body}.${tampered}`)).toThrow();
	});

	it('rejects malformed token (no dot)', () => {
		expect(() => verifyQuote('notavalidtoken')).toThrow(/malformed/);
	});

	it('rejects expired quote', async () => {
		const priorTtl = process.env.THREE_QUOTE_TTL_S;
		process.env.THREE_QUOTE_TTL_S = '-1';
		fetchResponses.push({ body: { [TOKEN_MINT]: { usdPrice: 0.001 } } });
		const { token } = await issueQuote({ purpose: 'spin', usd: 0.5, splitPolicy: 'spin' });
		expect(() => verifyQuote(token)).toThrow(/expired/);
		if (priorTtl !== undefined) process.env.THREE_QUOTE_TTL_S = priorTtl;
		else delete process.env.THREE_QUOTE_TTL_S;
	});

	it('marketplace_sale quote has seller + treasury legs', async () => {
		fetchResponses.push({ body: { [TOKEN_MINT]: { usdPrice: 0.001 } } });
		const seller = 'So11111111111111111111111111111111111111112';
		const { quote } = await issueQuote({
			purpose: 'marketplace_sale',
			usd: 10,
			splitPolicy: 'marketplace_sale',
			sellerWallet: seller,
		});
		const sellerLeg = quote.legs.find((l) => l.role === 'seller');
		const treasuryLeg = quote.legs.find((l) => l.role === 'treasury');
		const rewardsLeg = quote.legs.find((l) => l.role === 'rewards');
		expect(sellerLeg).toBeDefined();
		expect(treasuryLeg).toBeDefined();
		expect(rewardsLeg).toBeDefined();
		expect(sellerLeg.address).toBe(seller);
		// seller gets 90%
		const sellerAtomics = BigInt(sellerLeg.atomics);
		const total = BigInt(quote.total);
		expect(sellerAtomics * 100n).toBeGreaterThanOrEqual(total * 89n);
		expect(sellerAtomics * 100n).toBeLessThanOrEqual(total * 91n);
	});

	it('different quotes produce different nonces', async () => {
		const cached = {
			priceUsd: 0.001,
			source: 'jupiter',
			mint: TOKEN_MINT,
			at: new Date().toISOString(),
		};
		// Both calls hit cache — no fetch needed.
		cacheGet.mockResolvedValue(cached);
		const { quote: q1 } = await issueQuote({ purpose: 'spin', usd: 0.5, splitPolicy: 'spin' });
		const { quote: q2 } = await issueQuote({ purpose: 'spin', usd: 0.5, splitPolicy: 'spin' });
		expect(q1.nonce).not.toBe(q2.nonce);
		cacheGet.mockResolvedValue(null);
	});
});

// ── On-chain verification ─────────────────────────────────────────────────────

describe('verifyOnChain', () => {
	const REWARDS = 'RewardsXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
	const TREASURY = 'TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
	const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
	const NONCE = 'test-nonce-abc123';

	beforeEach(() => {
		_mockTxResponse = undefined;
	});

	function makeQuotePayload(legs = null) {
		return {
			nonce: NONCE,
			mint: TOKEN_MINT,
			total: '2000',
			legs: legs ?? [
				{ role: 'treasury', address: TREASURY, bps: 5000, atomics: '1000' },
				{ role: 'rewards', address: REWARDS, bps: 5000, atomics: '1000' },
			],
		};
	}

	function makeTx({ memo = NONCE, preBalances = [], postBalances = [] } = {}) {
		return {
			slot: 123456,
			meta: { err: null, preTokenBalances: preBalances, postTokenBalances: postBalances },
			transaction: {
				message: {
					accountKeys: [{ pubkey: { toString: () => 'payer' } }],
					instructions: [{ programId: { toString: () => MEMO_PROGRAM }, parsed: memo }],
				},
			},
		};
	}

	it('rejects a tx with memo mismatch', async () => {
		_mockTxResponse = makeTx({ memo: 'wrong-nonce' });
		await expect(
			verifyOnChain({ quote: makeQuotePayload(), txSignature: 'sig', network: 'devnet' }),
		).rejects.toMatchObject({ code: 'memo_mismatch' });
	});

	it('rejects a failed on-chain tx', async () => {
		_mockTxResponse = {
			slot: 1,
			meta: { err: { InstructionError: [0, 'GenericError'] } },
			transaction: { message: { accountKeys: [], instructions: [] } },
		};
		await expect(
			verifyOnChain({ quote: makeQuotePayload(), txSignature: 'sig', network: 'devnet' }),
		).rejects.toMatchObject({ code: 'tx_failed' });
	});

	it('rejects when tx not found (null response)', async () => {
		_mockTxResponse = null;
		await expect(
			verifyOnChain({ quote: makeQuotePayload(), txSignature: 'sig', network: 'devnet' }),
		).rejects.toMatchObject({ code: 'tx_not_found' });
	});

	it('rejects when a split leg receives less than required', async () => {
		// Only treasury gets credited; rewards receives nothing → delta 0 < 1000 required
		_mockTxResponse = makeTx({
			postBalances: [
				{
					mint: TOKEN_MINT,
					owner: TREASURY,
					accountIndex: 0,
					uiTokenAmount: { amount: '1000' },
				},
			],
		});
		await expect(
			verifyOnChain({ quote: makeQuotePayload(), txSignature: 'sig', network: 'devnet' }),
		).rejects.toMatchObject({ code: 'split_underpaid' });
	});

	it('succeeds when all legs are credited at or above required', async () => {
		_mockTxResponse = makeTx({
			postBalances: [
				{
					mint: TOKEN_MINT,
					owner: TREASURY,
					accountIndex: 0,
					uiTokenAmount: { amount: '1000' },
				},
				{
					mint: TOKEN_MINT,
					owner: REWARDS,
					accountIndex: 1,
					uiTokenAmount: { amount: '1000' },
				},
			],
		});
		const result = await verifyOnChain({
			quote: makeQuotePayload(),
			txSignature: 'sig',
			network: 'devnet',
		});
		expect(result.slot).toBe(123456);
		expect(result.credited).toBeDefined();
	});

	it('succeeds when a leg is overpaid (excess is fine)', async () => {
		_mockTxResponse = makeTx({
			postBalances: [
				{
					mint: TOKEN_MINT,
					owner: TREASURY,
					accountIndex: 0,
					uiTokenAmount: { amount: '2000' },
				},
				{
					mint: TOKEN_MINT,
					owner: REWARDS,
					accountIndex: 1,
					uiTokenAmount: { amount: '2000' },
				},
			],
		});
		const result = await verifyOnChain({
			quote: makeQuotePayload(),
			txSignature: 'sig',
			network: 'devnet',
		});
		expect(result.slot).toBe(123456);
	});
});
