// agent-sniper — default SolanaClient: pump.fun bonding-curve trades.
//
// Wraps @three-ws/agent-payments' PumpTradeClient (an Anchor-backed client over
// the official pump.fun program) so quotes + instruction builds use the same
// battle-tested bonding-curve math the three.ws platform runs in production —
// rather than a re-derivation that could be subtly, expensively wrong.
//
// This is the ONLY adapter that knows pump.fun specifics. Implement the
// SolanaClient contract yourself to route through Jupiter, Raydium, a custom
// program, or a mock for tests.
//
// ── Which pump.fun pricing regime this adapter covers ────────────────────────
// PumpTradeClient prices the pump program's BONDING CURVE, pre-graduation coins
// only. Spot price comes from the curve's virtual_quote_reserves /
// virtual_token_reserves. Those quote-side curve fields were renamed upstream
// (virtual_sol_reserves → virtual_quote_reserves, real_sol_reserves →
// real_quote_reserves) when a non-SOL quote asset became possible.
//
// The PumpSwap (pump_amm) POOL account has its own, unrelated field also called
// virtual_quote_reserves. It applies only AFTER graduation, is a signed i128,
// and pool quotes must price against the effective reserve
// (pool_quote_token_account.amount + pool.virtual_quote_reserves) while the base
// side stays the raw pool_base_token_account.amount. This adapter never touches
// a pool; an AMM-routed SolanaClient must handle that itself.
//
// ── Fail closed, never zero ──────────────────────────────────────────────────
// Every number below feeds a spend decision with no human in the loop, so a
// missing field is an error, not a default. `priceImpactPct ?? 0` sails straight
// through the entry circuit breaker as a perfect 0% impact; a `quoteMint`
// guessed as wSOL defeats the require_sol_quote gate; a zero sell quote reads as
// a -100% position and stop-losses a healthy bag. All three now throw.

import { Connection } from '@solana/web3.js';
import BN from 'bn.js';

const RPC = {
	mainnet: () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
	devnet: () => process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
};
const toBN = (v) => new BN(BigInt(v).toString());

// A quote whose price impact did not compute is unusable: the entry breaker
// compares against it, and any non-number silently passes the comparison.
export function requireImpactPct(value, side) {
	// Reject the absent cases before coercing: `Number(null)` is 0, which is the
	// very "healthy quote" reading a failed price computation must never produce.
	const n = value == null || value === '' ? NaN : Number(value);
	if (!Number.isFinite(n)) {
		throw Object.assign(
			new Error(`pump quote for ${side} returned no usable priceImpactPct (${String(value)})`),
			{ code: 'quote_unpriced' },
		);
	}
	return n;
}

// The quote asset must be reported, never assumed. Guessing wSOL here would let
// a USDC-paired coin through a SOL-only strategy and denominate its P&L in the
// wrong unit.
export function requireQuoteMint(value, side) {
	if (!value || typeof value.toBase58 !== 'function') {
		throw Object.assign(new Error(`pump quote for ${side} reported no quoteMint`), {
			code: 'quote_mint_missing',
		});
	}
	return value;
}

// A sell quote of zero (or a missing one) means the curve/pool read failed, not
// that the bag is worthless. Returning 0 to the position sweep would read as a
// -100% position and fire an immediate stop-loss on a perfectly healthy coin.
export function requireQuoteOut(value, side) {
	if (value == null) {
		throw Object.assign(new Error(`pump quote for ${side} returned no expectedQuoteOut`), {
			code: 'quote_unpriced',
		});
	}
	const out = BigInt(value.toString());
	if (out <= 0n) {
		throw Object.assign(new Error(`pump quote for ${side} valued the position at zero`), {
			code: 'quote_unpriced',
		});
	}
	return out;
}

/**
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network]
 * @param {string} [opts.rpcUrl]              overrides the network default
 * @param {Connection} [opts.connection]      bring your own
 * @returns {Promise<import('../../types.js').SolanaClient>}
 */
export async function createPumpClient(opts = {}) {
	const network = opts.network || 'mainnet';
	const { PumpTradeClient } = await import('@three-ws/agent-payments');
	const url = opts.rpcUrl || (network === 'devnet' ? RPC.devnet() : RPC.mainnet());
	const connection = opts.connection || new Connection(url, 'confirmed');
	const client = new PumpTradeClient(connection);

	return {
		connection,

		async quoteForBuy({ mint, quoteLamports, slippagePct }) {
			const q = await client.quoteForBuy({ mint, quoteAmount: toBN(quoteLamports), slippagePct });
			return {
				priceImpactPct: requireImpactPct(q.priceImpactPct, 'buy'),
				quoteMint: requireQuoteMint(q.quoteMint, 'buy'),
			};
		},

		async buildBuyInstructions({ mint, user, quoteLamports, slippagePct }) {
			const built = await client.buildBuyInstructions({ mint, user, quoteAmount: toBN(quoteLamports), slippagePct });
			return {
				instructions: built.instructions,
				expectedBaseTokens: BigInt(built.expectedBaseTokens.toString()),
			};
		},

		async quoteForSell({ mint, baseAmount, slippagePct }) {
			const q = await client.quoteForSell({ mint, baseAmount: toBN(baseAmount), slippagePct });
			return {
				priceImpactPct: requireImpactPct(q.priceImpactPct, 'sell'),
				expectedQuoteOut: requireQuoteOut(q.expectedQuoteOut, 'sell'),
				quoteMint: requireQuoteMint(q.quoteMint, 'sell'),
			};
		},

		async buildSellInstructions({ mint, user, baseAmount, slippagePct }) {
			const built = await client.buildSellInstructions({ mint, user, baseAmount: toBN(baseAmount), slippagePct });
			return {
				instructions: built.instructions,
				expectedQuoteOut: built.expectedQuoteOut != null ? BigInt(built.expectedQuoteOut.toString()) : undefined,
			};
		},
	};
}

export default createPumpClient;
