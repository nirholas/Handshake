import { describe, it, expect, vi, beforeEach } from 'vitest';
import BN from 'bn.js';

// ── Mocks ──────────────────────────────────────────────────────────────────
// amm-exit.js reaches the chain through api/_lib/pump.js (getAmmPoolState +
// getConnection) and @pump-fun/pump-swap-sdk. Mock both so the module's pure
// routing + pricing-shape logic is exercised without RPC. Resolved-module-id
// matching means the path here (relative to this test) intercepts the worker
// module's own '../../api/_lib/pump.js' import.

const mockGetAmmPoolState = vi.fn();
const mockSellBaseInput = vi.fn();
const mockBuyQuoteInput = vi.fn();
const mockSwapSolanaState = vi.fn();
const mockOfflineSellBaseInput = vi.fn();
const mockOfflineBuyQuoteInput = vi.fn();
const MOCK_POOL = '9WZDXbs5da3XuBTOBiGHqKkqFGC4j2HJvBQKzXAMsRg';

vi.mock('../api/_lib/pump.js', () => ({
	getAmmPoolState: (...a) => mockGetAmmPoolState(...a),
	getConnection: () => ({}),
}));

vi.mock('@pump-fun/pump-swap-sdk', () => ({
	sellBaseInput: (...a) => mockSellBaseInput(...a),
	buyQuoteInput: (...a) => mockBuyQuoteInput(...a),
	PumpAmmSdk: class {
		sellBaseInput(...a) {
			return mockOfflineSellBaseInput(...a);
		}
		buyQuoteInput(...a) {
			return mockOfflineBuyQuoteInput(...a);
		}
	},
	OnlinePumpAmmSdk: class {
		swapSolanaState(...a) {
			return mockSwapSolanaState(...a);
		}
	},
}));

// Import AFTER mocks are registered.
const { isGraduated, quoteAmmSell, buildAmmSellInstructions, quoteAmmBuy, buildAmmBuyInstructions } = await import(
	'../workers/agent-sniper/amm-exit.js'
);

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT = 'THREEsynthetic1111111111111111111111111111111';

// Mirrors the real getAmmPoolState return, including the effective quote reserve
// (vault balance + the pool's virtual quote reserves) that pricing runs against.
function poolState({
	quoteMint = WSOL,
	baseReserve = 1_000_000_000,
	quoteReserve = 1_000_000_000,
	virtualQuoteReserves = 0,
} = {}) {
	return {
		poolKey: { toString: () => MOCK_POOL },
		pool: {
			quoteMint: { toString: () => quoteMint },
			baseMint: { toString: () => MINT },
			coinCreator: { toString: () => '11111111111111111111111111111111' },
			creator: { toString: () => '11111111111111111111111111111111' },
			virtualQuoteReserves: new BN(virtualQuoteReserves),
		},
		baseReserve: new BN(baseReserve),
		quoteReserve: new BN(quoteReserve),
		virtualQuoteReserves: new BN(virtualQuoteReserves),
		effectiveQuoteReserve: new BN(quoteReserve).add(new BN(virtualQuoteReserves)),
		baseMintAccount: { decimals: 6 },
		globalConfig: { mock: true },
		feeConfig: null,
	};
}

function poolNotFound() {
	const e = new Error('pump.fun AMM pool not found for mint');
	e.status = 404;
	e.code = 'pool_not_found';
	return e;
}

describe('isGraduated — deterministic graduation detection', () => {
	beforeEach(() => {
		mockGetAmmPoolState.mockReset();
	});

	it('returns true when a canonical AMM pool exists', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		expect(await isGraduated({ network: 'mainnet', mint: MINT })).toBe(true);
	});

	it('returns false when no pool exists (still on the bonding curve)', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(poolNotFound());
		expect(await isGraduated({ network: 'mainnet', mint: MINT })).toBe(false);
	});

	it('rethrows a transient RPC error rather than reporting "not graduated"', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(
			Object.assign(new Error('rpc 502'), { code: 'pool_accounts_missing', status: 502 }),
		);
		await expect(isGraduated({ network: 'mainnet', mint: MINT })).rejects.toThrow('rpc 502');
	});
});

describe('quoteAmmSell — re-quote a graduated position off the AMM', () => {
	beforeEach(() => {
		mockGetAmmPoolState.mockReset();
		mockSellBaseInput.mockReset();
	});

	it('returns expected + min SOL out and the pool key', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		mockSellBaseInput.mockReturnValueOnce({
			uiQuote: new BN(9_800),
			minQuote: new BN(9_700),
		});

		const r = await quoteAmmSell({
			network: 'mainnet',
			mint: MINT,
			baseAmount: new BN(10_000),
			slippagePct: 5,
		});

		expect(r.expectedQuoteOut).toBe(9_800n);
		expect(r.minQuoteOut).toBe(9_700n);
		expect(r.poolKey).toBe(MOCK_POOL);
		expect(typeof r.priceImpactPct).toBe('number');
		expect(r.priceImpactPct).toBeGreaterThanOrEqual(0);
	});

	it('forwards the base amount, slippage, and live reserves to the SDK', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(50), minQuote: new BN(45) });

		await quoteAmmSell({ network: 'mainnet', mint: MINT, baseAmount: new BN(10_000), slippagePct: 5 });

		expect(mockSellBaseInput).toHaveBeenCalledOnce();
		const call = mockSellBaseInput.mock.calls[0][0];
		expect(call.base.toString()).toBe('10000');
		expect(call.slippage).toBe(5);
		expect(call.baseReserve.toString()).toBe('1000000000');
		expect(call.quoteReserve.toString()).toBe('1000000000');
		expect(call.globalConfig).toEqual({ mock: true });
	});

	// PumpSwap prices against vault + virtual quote reserves. The SDK performs
	// that addition itself, so we must hand it the RAW vault balance alongside
	// the virtual figure — passing a pre-summed reserve double-counts the
	// virtual liquidity and over-values every exit.
	it('passes virtual quote reserves to the SDK without pre-summing them', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ quoteReserve: 1_000_000_000, virtualQuoteReserves: 250_000_000 }),
		);
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(50), minQuote: new BN(45) });

		await quoteAmmSell({ network: 'mainnet', mint: MINT, baseAmount: new BN(10_000), slippagePct: 5 });

		const call = mockSellBaseInput.mock.calls[0][0];
		expect(call.quoteReserve.toString()).toBe('1000000000');
		expect(call.virtualQuoteReserves.toString()).toBe('250000000');
	});

	// `Pool.virtual_quote_reserves` is a signed i128, so a large negative can put
	// effective depth at or below zero. Such a pool cannot absorb a sale, and the
	// impact math would score it 0% (the safest possible trade) — so the quote has
	// to refuse outright rather than hand the breaker a reassuring number.
	it('refuses a pool whose effective quote depth is wiped out by a negative virtual', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ quoteReserve: 1_000_000, virtualQuoteReserves: -1_000_000 }),
		);
		await expect(
			quoteAmmSell({ network: 'mainnet', mint: MINT, baseAmount: new BN(10_000), slippagePct: 5 }),
		).rejects.toMatchObject({ code: 'amm_quote_depth_empty' });
		expect(mockSellBaseInput).not.toHaveBeenCalled();
	});

	// A negative virtual that only reduces depth is still a tradable pool: it must
	// price normally, against the reduced effective reserve.
	it('prices normally when a negative virtual only reduces depth', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ baseReserve: 1_000_000, quoteReserve: 2_000_000, virtualQuoteReserves: -1_000_000 }),
		);
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(90_000), minQuote: new BN(85_000) });

		const r = await quoteAmmSell({
			network: 'mainnet',
			mint: MINT,
			baseAmount: new BN(100_000),
			slippagePct: 5,
		});
		// effective quote = 2e6 - 1e6 = 1e6; spot value of 100k base = 100k.
		// netting 90k is a 10% impact.
		expect(r.priceImpactPct).toBeCloseTo(10, 5);
		// The SDK still receives the RAW vault balance plus the signed virtual.
		const call = mockSellBaseInput.mock.calls[0][0];
		expect(call.quoteReserve.toString()).toBe('2000000');
		expect(call.virtualQuoteReserves.toString()).toBe('-1000000');
	});

	// Impact is measured against the spot price implied by EFFECTIVE reserves.
	// Virtual liquidity deepens the pool, so the same sale moves it less.
	it('measures price impact against effective (vault + virtual) reserves', async () => {
		// base=1e6, vault quote=1e6, virtual=1e6 → effective quote = 2e6.
		// spot value of 100_000 base = 100_000 * (2e6/1e6) = 200_000.
		// Netting 190_000 is a 5% impact, not the 10% the raw vault implies.
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ baseReserve: 1_000_000, quoteReserve: 1_000_000, virtualQuoteReserves: 1_000_000 }),
		);
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(190_000), minQuote: new BN(180_000) });

		const r = await quoteAmmSell({
			network: 'mainnet',
			mint: MINT,
			baseAmount: new BN(100_000),
			slippagePct: 5,
		});
		expect(r.priceImpactPct).toBeCloseTo(5, 5);
	});

	it('computes a non-trivial price impact for a sale that moves the pool', async () => {
		// baseReserve=1e6, quoteReserve=1e6, sell 100_000 base, net 90_000 quote.
		// spot value = 100_000 * (1e6/1e6) = 100_000; impact = (100k-90k)/100k = 10%.
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ baseReserve: 1_000_000, quoteReserve: 1_000_000 }),
		);
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(90_000), minQuote: new BN(85_000) });

		const r = await quoteAmmSell({
			network: 'mainnet',
			mint: MINT,
			baseAmount: new BN(100_000),
			slippagePct: 5,
		});
		expect(r.priceImpactPct).toBeCloseTo(10, 5);
	});

	it('propagates pool_not_found so callers know the coin is still on the curve', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(poolNotFound());
		await expect(
			quoteAmmSell({ network: 'mainnet', mint: MINT, baseAmount: new BN(1), slippagePct: 5 }),
		).rejects.toMatchObject({ code: 'pool_not_found' });
	});

	it('refuses a non-SOL-quoted pool (sniper PnL is lamports-denominated)', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState({ quoteMint: USDC }));
		await expect(
			quoteAmmSell({ network: 'mainnet', mint: MINT, baseAmount: new BN(1), slippagePct: 5 }),
		).rejects.toMatchObject({ code: 'amm_quote_not_sol' });
	});
});

describe('buildAmmSellInstructions — build the on-chain AMM exit', () => {
	beforeEach(() => {
		mockGetAmmPoolState.mockReset();
		mockSellBaseInput.mockReset();
		mockSwapSolanaState.mockReset();
		mockOfflineSellBaseInput.mockReset();
	});

	it('builds instructions via swapSolanaState + offline sellBaseInput and surfaces the quote', async () => {
		mockGetAmmPoolState.mockResolvedValue(poolState());
		mockSellBaseInput.mockReturnValue({ uiQuote: new BN(9_800), minQuote: new BN(9_700) });
		mockSwapSolanaState.mockResolvedValueOnce({ pool: {} });
		const fakeIxs = [{ programId: 'ix1' }, { programId: 'ix2' }];
		mockOfflineSellBaseInput.mockResolvedValueOnce(fakeIxs);

		const r = await buildAmmSellInstructions({
			network: 'mainnet',
			mint: MINT,
			user: { toBase58: () => 'user' },
			baseAmount: new BN(10_000),
			slippagePct: 5,
		});

		expect(r.instructions).toBe(fakeIxs);
		expect(r.expectedQuoteOut).toBe(9_800n);
		expect(r.minQuoteOut).toBe(9_700n);
		expect(r.poolKey).toBe(MOCK_POOL);
		expect(mockOfflineSellBaseInput).toHaveBeenCalledOnce();
		const offCall = mockOfflineSellBaseInput.mock.calls[0];
		expect(offCall[1].toString()).toBe('10000');
		expect(offCall[2]).toBe(5);
	});

	it('propagates pool_not_found (cannot build against a curve that has not graduated)', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(poolNotFound());
		await expect(
			buildAmmSellInstructions({
				network: 'mainnet',
				mint: MINT,
				user: { toBase58: () => 'user' },
				baseAmount: new BN(1),
				slippagePct: 5,
			}),
		).rejects.toMatchObject({ code: 'pool_not_found' });
	});
});

describe('quoteAmmBuy — re-quote a graduated coin buy off the AMM', () => {
	beforeEach(() => {
		mockGetAmmPoolState.mockReset();
		mockBuyQuoteInput.mockReset();
	});

	it('returns expected + min token out, the SOL ceiling, and the pool key', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		// Spend 10_000 lamports; SDK prices 5_000 tokens out and a 10_300 lamport ceiling.
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(5_000), maxQuote: new BN(10_300) });

		const r = await quoteAmmBuy({
			network: 'mainnet',
			mint: MINT,
			quoteAmount: new BN(10_000),
			slippagePct: 5,
		});

		expect(r.expectedBaseOut).toBe(5_000n);
		// 5% slippage → floor = 5000 × (10000−500)/10000 = 4750.
		expect(r.minBaseOut).toBe(4_750n);
		expect(r.maxQuoteIn).toBe(10_300n);
		expect(r.poolKey).toBe(MOCK_POOL);
		expect(typeof r.priceImpactPct).toBe('number');
		expect(r.priceImpactPct).toBeGreaterThanOrEqual(0);
	});

	it('forwards the quote amount, slippage, and live reserves to the SDK', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(50), maxQuote: new BN(105) });

		await quoteAmmBuy({ network: 'mainnet', mint: MINT, quoteAmount: new BN(100), slippagePct: 5 });

		expect(mockBuyQuoteInput).toHaveBeenCalledOnce();
		const call = mockBuyQuoteInput.mock.calls[0][0];
		expect(call.quote.toString()).toBe('100');
		expect(call.slippage).toBe(5);
		expect(call.baseReserve.toString()).toBe('1000000000');
		expect(call.quoteReserve.toString()).toBe('1000000000');
		expect(call.globalConfig).toEqual({ mock: true });
	});

	it('computes a non-trivial price impact for a buy that moves the pool', async () => {
		// baseReserve=1e6, quoteReserve=1e6, spend 100_000 quote, get 90_000 base.
		// spot value = 100_000 × (1e6/1e6) = 100_000; impact = (100k−90k)/100k = 10%.
		mockGetAmmPoolState.mockResolvedValueOnce(
			poolState({ baseReserve: 1_000_000, quoteReserve: 1_000_000 }),
		);
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(90_000), maxQuote: new BN(105_000) });

		const r = await quoteAmmBuy({
			network: 'mainnet',
			mint: MINT,
			quoteAmount: new BN(100_000),
			slippagePct: 5,
		});
		expect(r.priceImpactPct).toBeCloseTo(10, 5);
	});

	it('falls back to the spent amount as the ceiling when the SDK omits maxQuote', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(5_000) });
		const r = await quoteAmmBuy({ network: 'mainnet', mint: MINT, quoteAmount: new BN(10_000), slippagePct: 5 });
		expect(r.maxQuoteIn).toBe(10_000n);
	});

	it('propagates pool_not_found so callers know the coin is still on the curve', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(poolNotFound());
		await expect(
			quoteAmmBuy({ network: 'mainnet', mint: MINT, quoteAmount: new BN(1), slippagePct: 5 }),
		).rejects.toMatchObject({ code: 'pool_not_found' });
	});

	it('refuses a non-SOL-quoted pool (this path trades in lamports)', async () => {
		mockGetAmmPoolState.mockResolvedValueOnce(poolState({ quoteMint: USDC }));
		await expect(
			quoteAmmBuy({ network: 'mainnet', mint: MINT, quoteAmount: new BN(1), slippagePct: 5 }),
		).rejects.toMatchObject({ code: 'amm_quote_not_sol' });
	});
});

describe('buildAmmBuyInstructions — build the on-chain AMM entry', () => {
	beforeEach(() => {
		mockGetAmmPoolState.mockReset();
		mockBuyQuoteInput.mockReset();
		mockSwapSolanaState.mockReset();
		mockOfflineBuyQuoteInput.mockReset();
	});

	it('builds instructions via swapSolanaState + offline buyQuoteInput and surfaces the quote', async () => {
		mockGetAmmPoolState.mockResolvedValue(poolState());
		mockBuyQuoteInput.mockReturnValue({ base: new BN(5_000), maxQuote: new BN(10_300) });
		mockSwapSolanaState.mockResolvedValueOnce({ pool: {} });
		const fakeIxs = [{ programId: 'buy1' }, { programId: 'buy2' }];
		mockOfflineBuyQuoteInput.mockResolvedValueOnce(fakeIxs);

		const r = await buildAmmBuyInstructions({
			network: 'mainnet',
			mint: MINT,
			user: { toBase58: () => 'user' },
			quoteAmount: new BN(10_000),
			slippagePct: 5,
		});

		expect(r.instructions).toBe(fakeIxs);
		expect(r.expectedBaseOut).toBe(5_000n);
		expect(r.minBaseOut).toBe(4_750n);
		expect(r.maxQuoteIn).toBe(10_300n);
		expect(r.poolKey).toBe(MOCK_POOL);
		expect(mockOfflineBuyQuoteInput).toHaveBeenCalledOnce();
		const offCall = mockOfflineBuyQuoteInput.mock.calls[0];
		expect(offCall[1].toString()).toBe('10000');
		expect(offCall[2]).toBe(5);
	});

	it('propagates pool_not_found (cannot build against a curve that has not graduated)', async () => {
		mockGetAmmPoolState.mockRejectedValueOnce(poolNotFound());
		await expect(
			buildAmmBuyInstructions({
				network: 'mainnet',
				mint: MINT,
				user: { toBase58: () => 'user' },
				quoteAmount: new BN(1),
				slippagePct: 5,
			}),
		).rejects.toMatchObject({ code: 'pool_not_found' });
	});
});
