import { describe, it, expect, vi, beforeEach } from 'vitest';
import BN from 'bn.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSwapSolanaState = vi.fn();
const mockBuyQuoteInput = vi.fn();
const mockSellBaseInput = vi.fn();
const MOCK_POOL = '9WZDXbs5da3XuBTOBiGHqKkqFGC4j2HJvBQKzXAMsRg';

vi.mock('@pump-fun/pump-swap-sdk', () => ({
	OnlinePumpAmmSdk: class {
		swapSolanaState(...a) {
			return mockSwapSolanaState(...a);
		}
	},
	canonicalPumpPoolPda: () => ({ toBase58: () => MOCK_POOL }),
	buyQuoteInput: (...a) => mockBuyQuoteInput(...a),
	sellBaseInput: (...a) => mockSellBaseInput(...a),
}));

vi.mock('../src/erc8004/solana-deploy.js', () => ({
	SOLANA_RPC: { mainnet: 'https://api.mainnet-beta.solana.com' },
}));

// Import AFTER mocks are registered.
const { quoteSwap } = await import('../src/pump/pump-swap-quote.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const WSOL = 'So11111111111111111111111111111111111111112';
// USDC on mainnet — a valid 32-byte base58 public key used as stand-in token mint.
const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function fakeState(overrides = {}) {
	return {
		globalConfig: { mock: true },
		feeConfig: null,
		pool: {
			baseMint: { toBase58: () => TOKEN },
			coinCreator: { toBase58: () => '11111111111111111111111111111111' },
			creator: { toBase58: () => '11111111111111111111111111111111' },
		},
		poolBaseAmount: new BN(1_000_000),
		poolQuoteAmount: new BN(1_000_000),
		baseMintAccount: { decimals: 6 },
		...overrides,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('quoteSwap', () => {
	beforeEach(() => {
		mockSwapSolanaState.mockReset();
		mockBuyQuoteInput.mockReset();
		mockSellBaseInput.mockReset();
	});

	it('buy direction: forwards args and normalizes output shape', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(9_900), maxQuote: new BN(10_200) });

		const result = await quoteSwap({
			inputMint: WSOL,
			outputMint: TOKEN,
			amountIn: 10_000,
			slippageBps: 100,
		});

		expect(result.amountOut).toBe('9900');
		expect(typeof result.priceImpactBps).toBe('number');
		expect(result.priceImpactBps).toBeGreaterThanOrEqual(0);
		expect(result.route).toBe(MOCK_POOL);
		expect(result.expiresAtMs).toBeGreaterThan(Date.now() - 1000);
		expect(result.expiresAtMs).toBeLessThanOrEqual(Date.now() + 11_000);
	});

	it('buy direction: passes quote and slippage through to buyQuoteInput', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(9_900) });

		await quoteSwap({ inputMint: WSOL, outputMint: TOKEN, amountIn: 10_000, slippageBps: 100 });

		expect(mockBuyQuoteInput).toHaveBeenCalledOnce();
		const call = mockBuyQuoteInput.mock.calls[0][0];
		expect(call.quote.toString()).toBe('10000');
		// pump-swap-sdk slippage is a PERCENT (1 = 1%): 100 bps -> 1.
		expect(call.slippage).toBeCloseTo(1);
		expect(call.globalConfig).toEqual({ mock: true });
	});

	it('buy direction: computes priceImpactBps correctly', async () => {
		// poolBase=1_000_000, poolQuote=1_000_000, amountIn=10_000, amountOut=9_900
		// impact = (10000*1000000)/(9900*1000000) * 10000 - 10000 = 10101 - 10000 = 101
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(9_900) });

		const result = await quoteSwap({ inputMint: WSOL, outputMint: TOKEN, amountIn: 10_000 });

		expect(result.priceImpactBps).toBe(101);
	});

	it('sell direction: forwards args and normalizes output shape', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(9_800), minQuote: new BN(9_700) });

		const result = await quoteSwap({
			inputMint: TOKEN,
			outputMint: WSOL,
			amountIn: 10_000,
			slippageBps: 50,
		});

		expect(result.amountOut).toBe('9800');
		expect(result.priceImpactBps).toBeGreaterThanOrEqual(0);
		expect(result.route).toBe(MOCK_POOL);
	});

	it('sell direction: passes base and slippage through to sellBaseInput', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(9_800) });

		await quoteSwap({ inputMint: TOKEN, outputMint: WSOL, amountIn: 10_000, slippageBps: 50 });

		expect(mockSellBaseInput).toHaveBeenCalledOnce();
		const call = mockSellBaseInput.mock.calls[0][0];
		expect(call.base.toString()).toBe('10000');
		// 50 bps -> 0.5 percent (the SDK's unit).
		expect(call.slippage).toBeCloseTo(0.5);
	});

	it('sell direction: computes priceImpactBps correctly', async () => {
		// poolBase=1_000_000, poolQuote=1_000_000, amountIn=10_000, amountOut=9_800
		// spot = 1_000_000*10_000=10_000_000_000; exec = 9_800*1_000_000=9_800_000_000
		// impact = (10B - 9.8B)*10000 / 10B = 200
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(9_800) });

		const result = await quoteSwap({ inputMint: TOKEN, outputMint: WSOL, amountIn: 10_000 });

		expect(result.priceImpactBps).toBe(200);
	});

	// `Pool.virtual_quote_reserves` is a signed i128. A negative large enough to
	// wipe out effective depth means the pool cannot absorb a trade, and the
	// impact math clamps with Math.max(0, …) — so an unrefused quote would come
	// back as 0 bps, the most attractive number the endpoint can return.
	it('refuses a pool whose effective quote depth is wiped out by a negative virtual', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(
			fakeState({
				poolQuoteAmount: new BN(1_000_000),
				pool: {
					...fakeState().pool,
					virtualQuoteReserves: new BN(-1_000_000),
				},
			}),
		);

		await expect(
			quoteSwap({ inputMint: TOKEN, outputMint: WSOL, amountIn: 10_000 }),
		).rejects.toThrow(/no tradable quote depth/);
		expect(mockSellBaseInput).not.toHaveBeenCalled();
	});

	// A negative virtual that only reduces depth is still tradable: it must price
	// against the reduced effective reserve, while the SDK still receives the raw
	// vault balance and the signed virtual as separate arguments.
	it('prices against reduced depth when a negative virtual does not exhaust the pool', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(
			fakeState({
				poolBaseAmount: new BN(1_000_000),
				poolQuoteAmount: new BN(2_000_000),
				pool: {
					...fakeState().pool,
					virtualQuoteReserves: new BN(-1_000_000),
				},
			}),
		);
		mockSellBaseInput.mockReturnValueOnce({ uiQuote: new BN(9_800) });

		const result = await quoteSwap({ inputMint: TOKEN, outputMint: WSOL, amountIn: 10_000 });

		// effective quote = 2e6 - 1e6 = 1e6, so the impact matches the baseline case.
		expect(result.priceImpactBps).toBe(200);
		const call = mockSellBaseInput.mock.calls[0][0];
		expect(call.quoteReserve.toString()).toBe('2000000');
		expect(call.virtualQuoteReserves.toString()).toBe('-1000000');
	});

	it('uses default slippageBps of 100 when not provided', async () => {
		mockSwapSolanaState.mockResolvedValueOnce(fakeState());
		mockBuyQuoteInput.mockReturnValueOnce({ base: new BN(5_000) });

		await quoteSwap({ inputMint: WSOL, outputMint: TOKEN, amountIn: 5_000 });

		const call = mockBuyQuoteInput.mock.calls[0][0];
		// Default 100 bps -> 1 percent.
		expect(call.slippage).toBeCloseTo(1);
	});

	it('throws with clean message on invalid inputMint', async () => {
		await expect(
			quoteSwap({ inputMint: 'not-a-valid-mint', outputMint: WSOL, amountIn: 1000 }),
		).rejects.toThrow('Invalid inputMint');
	});

	it('throws with clean message on invalid outputMint', async () => {
		await expect(
			quoteSwap({ inputMint: WSOL, outputMint: 'not-a-valid-mint', amountIn: 1000 }),
		).rejects.toThrow('Invalid outputMint');
	});

	it('throws when neither mint is wSOL', async () => {
		// SystemProgram (11111...1) is a valid pubkey but not wSOL.
		const OTHER = '11111111111111111111111111111111';
		await expect(
			quoteSwap({ inputMint: TOKEN, outputMint: OTHER, amountIn: 1000 }),
		).rejects.toThrow(/wSOL/);
	});

	it('wraps RPC errors with clean pool-unavailable message', async () => {
		mockSwapSolanaState.mockRejectedValueOnce(new Error('Connection refused'));

		await expect(
			quoteSwap({ inputMint: WSOL, outputMint: TOKEN, amountIn: 1000 }),
		).rejects.toThrow('Pool unavailable');
	});
});
