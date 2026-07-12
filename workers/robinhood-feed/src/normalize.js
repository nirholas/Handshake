// Normalize Robinhood Chain events into the shape three.ws pump.fun consumers
// already understand. Fields map 1:1 to the pump feed where semantics align;
// divergences (documented inline and in the README) exist because this is an
// EVM, ETH-gas chain rather than Solana.
//
// These functions are PURE — no chain reads — so they unit-test directly
// against captured on-chain logs. The orchestrator resolves token metadata and
// the ETH price and passes them in.

import { formatUnits } from 'viem';
import { CHAIN_ID, EXPLORER_BASE } from './config.js';
import { quoteToUsd } from './eth-price.js';

const CHAIN = 'robinhood-chain';

const nowUnix = (ms) => Math.floor((ms ?? Date.now()) / 1000);
const txUrl = (hash) => `${EXPLORER_BASE}/tx/${hash}`;
const tokenUrl = (addr) => `${EXPLORER_BASE}/address/${addr}`;
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * A token launch (NOXA instant list or Odyssey curve open).
 * pump `mint` → `mint` (the coin address; this is the world seed).
 *
 * `launch.initialBuyAmount` is best-effort: the hoodchain SDK's high-level
 * `watchLaunches`/`getRecentLaunches` return the decoded `Launch` shape,
 * which does not carry it (it's a NOXA-only raw log field). When absent this
 * resolves to `null`, never a fabricated value.
 */
export function normalizeLaunch({ launch, name = null, symbol = null, ethUsd = 0, atMs }) {
	const initialNative = launch.initialBuyAmount != null
		? Number(formatUnits(launch.initialBuyAmount, 18)) // NOXA reports ETH (18-dec)
		: null;
	return {
		chain: CHAIN,
		chain_id: CHAIN_ID,
		launchpad: launch.launchpad,
		// pump-compatible identity fields
		mint: launch.token,
		address: launch.token,
		name,
		symbol,
		creator: launch.creator,
		signature: launch.transactionHash,
		tx_signature: launch.transactionHash,
		// EVM specifics (documented divergence — no Solana bonding_curve key)
		pool: launch.pool ?? null,
		quote_symbol: 'ETH',
		initial_buy_native: num(initialNative),
		initial_buy_usd: initialNative != null ? quoteToUsd(initialNative, 'ETH', ethUsd) : null,
		// pump cards read these; we have no off-chain metadata service on RH yet
		image_uri: null,
		description: null,
		market_cap_usd: null, // best-effort; filled by later trades on the coin
		block_number: Number(launch.blockNumber),
		created_at: nowUnix(atMs),
		timestamp: nowUnix(atMs),
		explorer_url: tokenUrl(launch.token),
		explorer_tx_url: txUrl(launch.transactionHash),
	};
}

/**
 * An Odyssey bonding-curve trade (`Traded` event). Native quote is ETH.
 */
export function normalizeCurveTrade({ trade, name = null, symbol = null, ethUsd = 0, atMs }) {
	const native = Number(formatUnits(trade.quoteAmount, 18)); // ETH
	const tokenAmount = Number(formatUnits(trade.tokenAmount, 18));
	const valueUsd = quoteToUsd(native, 'ETH', ethUsd);
	const priceUsd = valueUsd != null && tokenAmount > 0 ? valueUsd / tokenAmount : null;
	return {
		chain: CHAIN,
		chain_id: CHAIN_ID,
		source: 'odyssey-curve',
		mint: trade.token,
		address: trade.token,
		name,
		symbol,
		trader: trade.trader,
		user: trade.trader, // chart-screen reads `user`
		txType: trade.isBuy ? 'buy' : 'sell',
		tx_type: trade.isBuy ? 'buy' : 'sell',
		is_buy: trade.isBuy === true,
		token_amount: num(tokenAmount),
		// `amount`/`sol_amount` carry the native magnitude the reactor animates by.
		// This chain is ETH, not SOL — `sol_amount` is the legacy field name the
		// existing consumers read; the value is native ETH. See README divergences.
		amount: num(native),
		sol_amount: num(native),
		quote_symbol: 'ETH',
		value_usd: num(valueUsd),
		usd_amount: num(valueUsd), // chart-screen reads `usd_amount`
		sol_value_usd: num(valueUsd), // pump WS consumers read `sol_value_usd`
		price_usd: num(priceUsd),
		market_cap_usd: null,
		pool: null,
		signature: trade.transactionHash,
		tx: trade.transactionHash, // chart-screen dedupe key
		tx_signature: trade.transactionHash,
		block_number: Number(trade.blockNumber),
		timestamp: nowUnix(atMs),
		explorer_tx_url: txUrl(trade.transactionHash),
	};
}

/**
 * A Uniswap v3 `Swap` on a tracked pool (NOXA pools from block one; Odyssey
 * pools post-graduation). `coinIsToken0` + `quoteDecimals` come from a one-time
 * pool inspection in the orchestrator.
 */
export function normalizeUniswapSwap({
	swap, token, pool, coinIsToken0, quoteSymbol = 'ETH', quoteDecimals = 18,
	name = null, symbol = null, ethUsd = 0, atMs,
}) {
	// amountX is the pool's delta: positive = asset flowed INTO the pool.
	const coinDelta = coinIsToken0 ? swap.amount0 : swap.amount1;
	const quoteDelta = coinIsToken0 ? swap.amount1 : swap.amount0;
	// Coin leaving the pool (negative delta) ⇒ trader received coin ⇒ BUY.
	const isBuy = coinDelta < 0n;
	const tokenAmount = Number(formatUnits(coinDelta < 0n ? -coinDelta : coinDelta, 18));
	const native = Number(formatUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, quoteDecimals));
	const valueUsd = quoteToUsd(native, quoteSymbol, ethUsd);
	const priceUsd = valueUsd != null && tokenAmount > 0 ? valueUsd / tokenAmount : null;
	return {
		chain: CHAIN,
		chain_id: CHAIN_ID,
		source: 'uniswap-v3',
		mint: token,
		address: token,
		name,
		symbol,
		trader: swap.recipient,
		user: swap.recipient,
		txType: isBuy ? 'buy' : 'sell',
		tx_type: isBuy ? 'buy' : 'sell',
		is_buy: isBuy,
		token_amount: num(tokenAmount),
		amount: num(native),
		sol_amount: num(native),
		quote_symbol: quoteSymbol,
		value_usd: num(valueUsd),
		usd_amount: num(valueUsd),
		sol_value_usd: num(valueUsd),
		price_usd: num(priceUsd),
		market_cap_usd: null,
		pool,
		signature: swap.transactionHash,
		tx: swap.transactionHash,
		tx_signature: swap.transactionHash,
		block_number: Number(swap.blockNumber),
		timestamp: nowUnix(atMs),
		explorer_tx_url: txUrl(swap.transactionHash),
	};
}

/**
 * An Odyssey graduation (`PoolMigrated`): curve fills, liquidity migrates to a
 * locked Uniswap v3 pool. pump `graduation` shape.
 */
export function normalizeGraduation({ grad, name = null, symbol = null, atMs }) {
	return {
		chain: CHAIN,
		chain_id: CHAIN_ID,
		mint: grad.token,
		address: grad.token,
		name,
		symbol,
		pool: grad.pool,
		signature: grad.transactionHash,
		tx_signature: grad.transactionHash,
		block_number: Number(grad.blockNumber),
		timestamp: nowUnix(atMs),
		explorer_url: tokenUrl(grad.token),
		explorer_tx_url: txUrl(grad.transactionHash),
	};
}
