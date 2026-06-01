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
	cacheSet: vi.fn(async () => {}),
	cacheDel: vi.fn(async () => {}),
}));

vi.mock('../api/_lib/db.js', () => {
	const queue = [];
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	sql.__queue = queue;
	return { sql };
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
	return Promise.resolve({
		ok: resp.ok ?? true,
		status: resp.status ?? 200,
		json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
		text: async () => String(resp.status ?? 200),
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
		expect(c.burn_address).toBe('1nc1nerator11111111111111111111111111111111');
		expect(c.quote_ttl_seconds).toBeGreaterThan(0);
		expect(c.split_policies.spin).toBeDefined();
		expect(c.split_policies.marketplace_sale).toBeDefined();
	});

	it('treasuryWallet warns in dev when unset and falls back to burn', () => {
		const prior = process.env.THREE_TREASURY_WALLET;
		delete process.env.THREE_TREASURY_WALLET;
		const w = treasuryWallet();
		expect(w).toBe(burnAddress());
		if (prior !== undefined) process.env.THREE_TREASURY_WALLET = prior;
	});

	it('treasuryWallet throws in production when unset', () => {
		const priorNode = process.env.NODE_ENV;
		const priorWallet = process.env.THREE_TREASURY_WALLET;
		process.env.NODE_ENV = 'production';
		delete process.env.THREE_TREASURY_WALLET;
		expect(() => treasuryWallet()).toThrow(/THREE_TREASURY_WALLET/);
		process.env.NODE_ENV = priorNode;
		if (priorWallet !== undefined) process.env.THREE_TREASURY_WALLET = priorWallet;
	});
});

// ── Split policy ───────────────────────────────────────────────────────────────

describe('resolveSplitLegs', () => {
	it('spin policy yields burn + treasury legs summing to 10000 bps', () => {
		const legs = resolveSplitLegs('spin');
		expect(legs).toHaveLength(2);
		const total = legs.reduce((s, l) => s + l.bps, 0);
		expect(total).toBe(10_000);
		const burnLeg = legs.find((l) => l.role === 'burn');
		const treasuryLeg = legs.find((l) => l.role === 'treasury');
		expect(burnLeg.bps).toBe(5000);
		expect(treasuryLeg.bps).toBe(5000);
		expect(burnLeg.address).toBe(burnAddress());
	});

	it('marketplace_sale policy yields seller + treasury legs summing to 10000 bps', () => {
		const seller = 'So11111111111111111111111111111111111111112';
		const legs = resolveSplitLegs('marketplace_sale', { sellerWallet: seller });
		expect(legs).toHaveLength(2);
		const sellerLeg = legs.find((l) => l.role === 'seller');
		const treasuryLeg = legs.find((l) => l.role === 'treasury');
		expect(sellerLeg.bps).toBe(9500);
		expect(treasuryLeg.bps).toBe(500);
		expect(sellerLeg.address).toBe(seller);
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

	it('spin: odd total — remainder goes to the highest-bps leg (burn=treasury tie → first higher-index wins)', () => {
		const legs = resolveSplitLegs('spin');
		const result = applySplit(1_000_001n, legs);
		const total = result.reduce((s, l) => s + l.atomics, 0n);
		expect(total).toBe(1_000_001n);
		// Both legs are 50/50; either may absorb the 1-atom remainder — just verify sum
	});

	it('marketplace_sale: 95/5 split is exact on 1_000_000', () => {
		const legs = resolveSplitLegs('marketplace_sale', {
			sellerWallet: 'So11111111111111111111111111111111111111112',
		});
		const result = applySplit(1_000_000n, legs);
		expect(result.find((l) => l.role === 'seller').atomics).toBe(950_000n);
		expect(result.find((l) => l.role === 'treasury').atomics).toBe(50_000n);
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
		expect(cacheSet).toHaveBeenCalledOnce();
	});

	it('falls back to Birdeye when Jupiter returns null price', async () => {
		const priorKey = process.env.BIRDEYE_API_KEY;
		process.env.BIRDEYE_API_KEY = 'test-key';
		// Jupiter returns with missing field
		fetchResponses.push({ body: { [TOKEN_MINT]: {} } });
		// Birdeye
		fetchResponses.push({ body: { data: { value: 0.0004 } } });
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
		fetchResponses.push({ ok: false, status: 503, body: 'down' });
		fetchResponses.push({ ok: false, status: 503, body: 'down' });
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
		expect(sellerLeg).toBeDefined();
		expect(treasuryLeg).toBeDefined();
		expect(sellerLeg.address).toBe(seller);
		// seller gets 95%
		const sellerAtomics = BigInt(sellerLeg.atomics);
		const total = BigInt(quote.total);
		expect(sellerAtomics * 100n).toBeGreaterThanOrEqual(total * 94n);
		expect(sellerAtomics * 100n).toBeLessThanOrEqual(total * 96n);
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
	const BURN_ADDR = '1nc1nerator11111111111111111111111111111111';
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
				{ role: 'burn', address: BURN_ADDR, bps: 5000, atomics: '1000' },
				{ role: 'treasury', address: TREASURY, bps: 5000, atomics: '1000' },
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
		// Only burn gets credited; treasury receives nothing → delta 0 < 1000 required
		_mockTxResponse = makeTx({
			postBalances: [
				{
					mint: TOKEN_MINT,
					owner: BURN_ADDR,
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
					owner: BURN_ADDR,
					accountIndex: 0,
					uiTokenAmount: { amount: '1000' },
				},
				{
					mint: TOKEN_MINT,
					owner: TREASURY,
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
					owner: BURN_ADDR,
					accountIndex: 0,
					uiTokenAmount: { amount: '2000' },
				},
				{
					mint: TOKEN_MINT,
					owner: TREASURY,
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
