// agent-sniper — post-graduation AMM entry + exit.
//
// When a coin graduates off the pump.fun bonding curve onto the canonical pump
// AMM pool, the bonding-curve trade path (PumpTradeClient quoteForBuy/quoteForSell
// / build*Instructions) can no longer price or execute against it. This module
// re-quotes and builds trades against the AMM pool instead:
//
//   · SELL (quoteAmmSell / buildAmmSellInstructions) — a graduated position still
//     exits on stop-loss / trailing / take-profit / timeout with a real fill.
//   · BUY  (quoteAmmBuy / buildAmmBuyInstructions)    — a graduated coin is still
//     buyable from an agent's own wallet (the discretionary + circulation trade
//     path), instead of hard-failing with "graduated, not supported".
//
// It reuses the SAME pool resolution + SDK calls the user-driven trade path uses
// (api/pump/[action].js → getAmmPoolState + PumpAmmSdk.{buyQuoteInput,sellBaseInput}),
// so there is one source of truth for AMM pricing across the platform. All amounts
// are quote atomics; these paths trade SOL-quoted curves (require_sol_quote), so the
// quote currency on the resolved pool is wSOL and atomics are lamports.

import { getAmmPoolState, getConnection } from '../../api/_lib/pump.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Resolve the canonical AMM pool for a graduated mint and read everything the
// pricing + instruction builders need. Throws { code:'pool_not_found' } when the
// coin has NOT graduated (no pool yet) so callers can distinguish "still on the
// curve" from a transient RPC error.
async function resolvePool(network, mintStr) {
	const amm = await getAmmPoolState({ network, mint: mintStr });
	const sdk = await import('@pump-fun/pump-swap-sdk');
	return { amm, sdk };
}

/**
 * Has `mint` graduated to the AMM on `network`? Deterministic — a live canonical
 * pool means the coin is off the curve. Returns false for a missing pool (still
 * on the curve); rethrows transient RPC errors so callers don't treat an outage
 * as "not graduated".
 */
export async function isGraduated({ network, mint }) {
	try {
		await getAmmPoolState({ network, mint });
		return true;
	} catch (err) {
		if (err?.code === 'pool_not_found') return false;
		throw err;
	}
}

/**
 * Re-quote a graduated position's current SOL value off the AMM pool. Mirrors
 * the read-side quote in api/pump/[action].js (functional sellBaseInput against
 * live reserves). Returns lamports (atomics) the sale would net, plus the
 * min-out floor and a derived price-impact figure for the circuit breaker.
 *
 * @param {object} p
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.mint
 * @param {import('bn.js')} p.baseAmount   token base units held (BN)
 * @param {number} p.slippagePct
 * @returns {Promise<{ poolKey: string, expectedQuoteOut: bigint, minQuoteOut: bigint, priceImpactPct: number }>}
 * @throws {Error} { code: 'pool_not_found' } when the coin has not graduated.
 */
export async function quoteAmmSell({ network, mint, baseAmount, slippagePct }) {
	const { amm, sdk } = await resolvePool(network, mint);
	const priced = priceSellFromPool(amm, sdk, baseAmount, slippagePct);
	return { poolKey: amm.poolKey.toString(), ...priced };
}

// Price a base-token sell against a resolved AMM pool. Mirrors the read-side
// quote in api/pump/[action].js (functional sellBaseInput against live
// reserves). The sniper only opens SOL-quoted curves (require_sol_quote), so a
// pool that resolved to a non-SOL quote breaks the lamports-denominated PnL math
// — refuse rather than mis-price.
function priceSellFromPool(amm, sdk, baseAmount, slippagePct) {
	const {
		pool,
		baseReserve,
		quoteReserve,
		virtualQuoteReserves,
		effectiveQuoteReserve,
		baseMintAccount,
		globalConfig,
		feeConfig,
	} = amm;

	const resolvedQuoteMint = pool.quoteMint?.toString?.() ?? WSOL_MINT;
	if (resolvedQuoteMint !== WSOL_MINT) {
		const e = new Error(`amm pool quote is ${resolvedQuoteMint}, expected wSOL`);
		e.code = 'amm_quote_not_sol';
		throw e;
	}
	assertTradableQuoteDepth(effectiveQuoteReserve);

	// `virtualQuoteReserves` is added to `quoteReserve` inside the SDK — pass the
	// raw reserve, never the pre-summed effective one, or the sale is priced
	// against double the virtual liquidity and the exit under-fills.
	const r = sdk.sellBaseInput({
		base: baseAmount,
		slippage: slippagePct,
		baseReserve,
		quoteReserve,
		virtualQuoteReserves,
		globalConfig,
		baseMintAccount,
		baseMint: pool.baseMint,
		coinCreator: pool.coinCreator,
		creator: pool.creator,
		feeConfig,
	});
	const expectedQuoteOut = BigInt((r.uiQuote ?? r.minQuote).toString());
	const minQuoteOut = BigInt((r.minQuote ?? r.uiQuote).toString());

	// Price impact: the spot value of the base at current reserves vs. what the
	// constant-product sale actually nets. quote/base spot * base = ideal; the
	// shortfall is impact. Guards a thin post-graduation pool the same way the
	// entry breaker guards a thin curve.
	const priceImpactPct = derivePriceImpact(
		baseReserve,
		effectiveQuoteReserve,
		baseAmount,
		expectedQuoteOut,
	);

	return { expectedQuoteOut, minQuoteOut, priceImpactPct };
}

/**
 * Build the AMM sell instructions for a graduated position. Mirrors the
 * user-driven sell builder (api/pump/[action].js): swapSolanaState for the
 * pool + the offline SDK's sellBaseInput, which embeds the slippage-derived
 * min-out floor on-chain. Returns the instructions plus the expected/min SOL out.
 *
 * @param {object} p
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.mint
 * @param {import('@solana/web3.js').PublicKey} p.user
 * @param {import('bn.js')} p.baseAmount   token base units held (BN)
 * @param {number} p.slippagePct
 * @returns {Promise<{ instructions: import('@solana/web3.js').TransactionInstruction[], poolKey: string, expectedQuoteOut: bigint, minQuoteOut: bigint, priceImpactPct: number }>}
 * @throws {Error} { code: 'pool_not_found' } when the coin has not graduated.
 */
export async function buildAmmSellInstructions({ network, mint, user, baseAmount, slippagePct }) {
	const { amm, sdk } = await resolvePool(network, mint);
	const priced = priceSellFromPool(amm, sdk, baseAmount, slippagePct);

	const offline = new sdk.PumpAmmSdk();
	const online = new sdk.OnlinePumpAmmSdk(getConnection({ network }));
	const swapState = await online.swapSolanaState(amm.poolKey, user);
	const instructions = await offline.sellBaseInput(swapState, baseAmount, slippagePct);

	return { instructions, poolKey: amm.poolKey.toString(), ...priced };
}

/**
 * Re-quote a graduated coin's buy off the AMM pool. Mirrors quoteAmmSell but for
 * an exact-SOL-in entry (buyQuoteInput): given `quoteAmount` lamports to spend,
 * returns the expected token base units out, a base-unit min-out floor derived
 * from slippage, the on-chain SOL ceiling (maxQuote), and a price-impact figure.
 *
 * @param {object} p
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.mint
 * @param {import('bn.js')} p.quoteAmount   lamports (SOL) to spend (BN)
 * @param {number} p.slippagePct
 * @returns {Promise<{ poolKey: string, expectedBaseOut: bigint, minBaseOut: bigint, maxQuoteIn: bigint, priceImpactPct: number }>}
 * @throws {Error} { code: 'pool_not_found' } when the coin has not graduated.
 */
export async function quoteAmmBuy({ network, mint, quoteAmount, slippagePct }) {
	const { amm, sdk } = await resolvePool(network, mint);
	const priced = priceBuyFromPool(amm, sdk, quoteAmount, slippagePct);
	return { poolKey: amm.poolKey.toString(), ...priced };
}

// Price a SOL-in buy against a resolved AMM pool. Mirrors priceSellFromPool: the
// SDK's slippage protection for a quote-in buy is expressed on the INPUT side as
// `maxQuote` (the most SOL you'll pay), so the base-unit floor is derived from the
// slippage percentage for the ledger/guards while the on-chain bound stays maxQuote.
function priceBuyFromPool(amm, sdk, quoteAmount, slippagePct) {
	const {
		pool,
		baseReserve,
		quoteReserve,
		virtualQuoteReserves,
		effectiveQuoteReserve,
		baseMintAccount,
		globalConfig,
		feeConfig,
	} = amm;

	const resolvedQuoteMint = pool.quoteMint?.toString?.() ?? WSOL_MINT;
	if (resolvedQuoteMint !== WSOL_MINT) {
		const e = new Error(`amm pool quote is ${resolvedQuoteMint}, expected wSOL`);
		e.code = 'amm_quote_not_sol';
		throw e;
	}
	assertTradableQuoteDepth(effectiveQuoteReserve);

	// See priceSellFromPool: raw `quoteReserve` here, virtual passed separately.
	const r = sdk.buyQuoteInput({
		quote: quoteAmount,
		slippage: slippagePct,
		baseReserve,
		quoteReserve,
		virtualQuoteReserves,
		globalConfig,
		baseMintAccount,
		baseMint: pool.baseMint,
		coinCreator: pool.coinCreator,
		creator: pool.creator,
		feeConfig,
	});
	const expectedBaseOut = BigInt((r.base ?? 0).toString());
	const maxQuoteIn = BigInt((r.maxQuote ?? quoteAmount).toString());
	// Base-unit floor from the slippage tolerance (bps): expected × (1 − slippage).
	const slippageBps = Math.max(0, Math.min(10000, Math.round(slippagePct * 100)));
	const minBaseOut = (expectedBaseOut * BigInt(10000 - slippageBps)) / 10000n;

	// SOL in, tokens out → input reserve is quote, output reserve is base.
	const priceImpactPct = derivePriceImpact(
		effectiveQuoteReserve,
		baseReserve,
		quoteAmount,
		expectedBaseOut,
	);

	return { expectedBaseOut, minBaseOut, maxQuoteIn, priceImpactPct };
}

/**
 * Build the AMM buy instructions for a graduated coin. Mirrors
 * buildAmmSellInstructions (swapSolanaState + offline buyQuoteInput, which embeds
 * the slippage-derived maxQuote SOL ceiling on-chain). Returns the instructions
 * plus the expected/min token out and the SOL ceiling.
 *
 * @param {object} p
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.mint
 * @param {import('@solana/web3.js').PublicKey} p.user
 * @param {import('bn.js')} p.quoteAmount   lamports (SOL) to spend (BN)
 * @param {number} p.slippagePct
 * @returns {Promise<{ instructions: import('@solana/web3.js').TransactionInstruction[], poolKey: string, expectedBaseOut: bigint, minBaseOut: bigint, maxQuoteIn: bigint, priceImpactPct: number }>}
 * @throws {Error} { code: 'pool_not_found' } when the coin has not graduated.
 */
export async function buildAmmBuyInstructions({ network, mint, user, quoteAmount, slippagePct }) {
	const { amm, sdk } = await resolvePool(network, mint);
	const priced = priceBuyFromPool(amm, sdk, quoteAmount, slippagePct);

	const offline = new sdk.PumpAmmSdk();
	const online = new sdk.OnlinePumpAmmSdk(getConnection({ network }));
	const swapState = await online.swapSolanaState(amm.poolKey, user);
	const instructions = await offline.buyQuoteInput(swapState, quoteAmount, slippagePct);

	return { instructions, poolKey: amm.poolKey.toString(), ...priced };
}

// Refuse a pool whose EFFECTIVE quote depth is non-positive.
//
// `Pool.virtual_quote_reserves` is a SIGNED i128, so effective depth
// (vault + virtual) can legitimately land at or below zero. Such a pool cannot
// absorb a trade. This has to be an explicit refusal because the downstream
// price-impact math reports a non-positive reserve as 0% impact — i.e. as the
// safest possible trade — which would wave the circuit breaker through on
// exactly the pool it exists to stop.
function assertTradableQuoteDepth(effectiveQuoteReserve) {
	const eff = BigInt(effectiveQuoteReserve?.toString?.() ?? effectiveQuoteReserve ?? 0);
	if (eff <= 0n) {
		const e = new Error(`amm pool has no effective quote depth (${eff.toString()})`);
		e.code = 'amm_quote_depth_empty';
		throw e;
	}
}

// Constant-product price impact for selling `baseIn` into a pool, as a percent
// of the no-impact (spot) value. Clamped to [0, 100]; returns 0 if reserves are
// missing so a quote can't be falsely rejected by the breaker. Callers must have
// already rejected a non-positive effective quote reserve via
// `assertTradableQuoteDepth` — a 0 here means "unknown", never "safe".
function derivePriceImpact(baseReserve, quoteReserve, baseIn, quoteOut) {
	const b = Number(baseReserve?.toString?.() ?? baseReserve ?? 0);
	const q = Number(quoteReserve?.toString?.() ?? quoteReserve ?? 0);
	const inAmt = Number(baseIn?.toString?.() ?? baseIn ?? 0);
	const out = Number(quoteOut ?? 0);
	if (!(b > 0) || !(q > 0) || !(inAmt > 0)) return 0;
	const spotOut = (inAmt * q) / b; // quote per base at current spot * baseIn
	if (!(spotOut > 0)) return 0;
	const impact = ((spotOut - out) / spotOut) * 100;
	if (!Number.isFinite(impact)) return 0;
	return Math.max(0, Math.min(100, impact));
}
