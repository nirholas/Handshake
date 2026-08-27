// Cross-network amount normalization for x402 spending caps (USE-22).
//
// Caps are enforced in micro-USD (6 decimals) so $0.10 cap === 100_000.
// Most x402 transfers today are USDC, which is already pegged 1:1 to USD
// and whose `amount` is already in micro-USD (6 decimals). For tokens
// pegged differently (e.g. USDT-on-BSC is still ~1:1 USD; SOL would not
// be), this module exposes a lightweight price oracle. It walks the shared
// free-source chain (CoinGecko, DefiLlama, Kraken, Coinbase, Bitfinex, the
// keyless CEX tail) for the headline assets and Coinbase spot for anything
// else, caches the result for 5 minutes, and serves the last-known-good price
// (up to a day old) when every source is down: a spend-cap check must not
// fail closed on one exchange's outage. It only throws when no price for the
// symbol has ever been observed.
//
// We deliberately avoid `import { fetch }` — Node 18+ + browsers ship
// global fetch, and this module needs to run unchanged in both.

import { cacheWrapLastGood } from './cache.js';
import { fetchCoinPriceUsd } from './market-fallbacks.js';
import { fetchFirst } from '../../src/shared/failover-fetch.js';

const PRICE_TTL_S = 5 * 60;
const LAST_GOOD_TTL_S = 24 * 3600;
const PRICE_API = 'https://api.coinbase.com/v2/prices';

// Ticker symbols x402 requirements name for non-pegged assets, mapped to the
// CoinGecko ids the shared price chain is keyed by. Wrapped forms price as the
// underlying. An unmapped symbol goes straight to the Coinbase spot rung.
const COINGECKO_IDS = {
	SOL: 'solana',
	WSOL: 'solana',
	ETH: 'ethereum',
	WETH: 'ethereum',
	BTC: 'bitcoin',
	WBTC: 'bitcoin',
	BNB: 'binancecoin',
	POL: 'polygon-ecosystem-token',
	MATIC: 'polygon-ecosystem-token',
	AVAX: 'avalanche-2',
};

// Tokens known to be 1:1 USD pegged. The asset address on the requirement
// + the symbol from `extra.name` are matched against these.
const USD_STABLECOINS = new Set([
	'usdc',
	'usd coin',
	'usdt',
	'tether',
	'binance-peg usd coin',
	'usdcw', // wormhole variants
	'dai',
]);

// Decimals defaults — when accept.extra.decimals isn't present.
const DEFAULT_TOKEN_DECIMALS = 6;

// Trusted asset registry keyed by the on-chain asset (mint/contract) address,
// lowercased. The decimals + peg here are AUTHORITATIVE and override anything the
// payee declares in `requirement.extra`. Without this, a malicious payee could set
// `extra.decimals` higher than reality (so the counted micro-USD is divided down
// and the spending cap under-sees the spend) or set `extra.name:"usdc"` to force
// the stablecoin branch and skip spot pricing — either way slipping a payment past
// the autonomous budget. The dominant x402 assets (USDC/USDT across chains) are
// listed; unknown assets fall back to payee values with a sanity-clamped decimals.
const TRUSTED_ASSETS = new Map([
	// USDC
	['epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', { decimals: 6, stable: true }], // Solana
	['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', { decimals: 6, stable: true }],   // Base
	['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { decimals: 6, stable: true }],   // Ethereum
	['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', { decimals: 6, stable: true }],   // Polygon (native)
	['0x2791bca1f2de4661ed88a30c99a7a9449aa84174', { decimals: 6, stable: true }],   // Polygon (bridged)
	['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', { decimals: 18, stable: true }],  // BSC USDC (18 dec)
	// USDT
	['es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb', { decimals: 6, stable: true }], // Solana
	['0xdac17f958d2ee523a2206206994597c13d831ec7', { decimals: 6, stable: true }],   // Ethereum
	['0x55d398326f99059ff775485246999027b3197955', { decimals: 18, stable: true }],  // BSC USDT (18 dec)
]);

// Clamp a payee-declared decimals value to a sane range so an unknown asset can't
// declare an absurd value that wildly mis-scales the spend.
function safeDecimals(raw) {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 18) return DEFAULT_TOKEN_DECIMALS;
	return n;
}

// Per-process micro-cache to short-circuit the Redis round-trip when the same
// symbol is hit twice in one function invocation (e.g. multi-leg settlement).
const localCache = new Map();

/** Test seam: drop the per-process micro-cache between cases. */
export function __resetLocalCache() {
	localCache.clear();
}

function isStablecoin(name) {
	if (!name) return false;
	return USD_STABLECOINS.has(String(name).trim().toLowerCase());
}

function asPositive(raw) {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

// One live read for a symbol: the shared multi-source chain when the symbol
// maps to a CoinGecko id, then Coinbase spot (no key, ~30 req/sec) as the
// direct rung for every symbol. Throws only when every source is down.
async function loadSpotUsd(key) {
	const id = COINGECKO_IDS[key];
	let chainErr = null;
	if (id) {
		try {
			return await fetchCoinPriceUsd(id);
		} catch (err) {
			chainErr = err;
		}
	}
	try {
		const { value } = await fetchFirst(
			[{
				name: `spending-price:coinbase:${key}`,
				url: `${PRICE_API}/${key}-USD/spot`,
				parse: async (r) => asPositive((await r.json())?.data?.amount),
			}],
			{ timeoutMs: 5_000, label: `spending-price:${key}` },
		);
		return value;
	} catch (err) {
		throw new Error(`spending-price: every price source for ${key}-USD failed (${chainErr?.message ? `${chainErr.message}; ` : ''}${err.message})`);
	}
}

// Spot price (in USD) for a symbol like 'SOL' or 'ETH': the per-process
// micro-cache, then the shared cache, then a live read, then the last-known-good
// value from the shared store when every live source fails. Cached for PRICE_TTL_S.
async function fetchSpotUsd(symbol) {
	const key = symbol.toUpperCase();
	const local = localCache.get(key);
	if (local && local.expiresAt > Date.now()) return local.value;
	const cacheKey = `spot-usd:${key}`;
	const value = await cacheWrapLastGood(cacheKey, PRICE_TTL_S, () => loadSpotUsd(key), {
		staleTtlSeconds: LAST_GOOD_TTL_S,
	});
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`spending-price: ${key}-USD invalid price: ${value}`);
	}
	localCache.set(key, { value, expiresAt: Date.now() + PRICE_TTL_S * 1000 });
	return value;
}

// Resolve `(amountAtomics, requirement)` → BigInt micro-USD. For stablecoins
// the amount is already in micro-USD (USDC, USDT, DAI all have 6 decimals);
// we just rescale to 6 if the token uses different decimals. For non-pegged
// tokens we multiply by the spot price.
//
// The function NEVER throws on a missing price for a stablecoin path —
// that's the dominant flow. It only reaches out to the price chain when the
// requirement explicitly declares a non-pegged token.
export async function toMicroUsd(amount, requirement) {
	const atomic = BigInt(amount);
	// Prefer the trusted registry (authoritative decimals + peg) over anything the
	// payee declared in `extra`. Only fall back to payee values for unknown assets,
	// and clamp the decimals so a hostile payee can't mis-scale the cap.
	const assetKey = String(requirement?.asset || '').trim().toLowerCase();
	const trusted = TRUSTED_ASSETS.get(assetKey);
	const decimals = trusted ? trusted.decimals : safeDecimals(requirement?.extra?.decimals);
	const isStable = trusted ? trusted.stable : isStablecoin(requirement?.extra?.name || '');
	if (isStable) {
		return rescaleAtomics(atomic, decimals, 6);
	}
	// Non-stable: rescale to whole-token units then multiply by USD spot.
	// Use a 1e9 fixed-point intermediate to preserve precision when
	// the spot price has decimals (e.g. SOL at $147.83).
	const symbol = inferSymbol(requirement);
	const spot = await fetchSpotUsd(symbol);
	const spotMicro = BigInt(Math.round(spot * 1_000_000));
	const denom = 10n ** BigInt(decimals);
	return (atomic * spotMicro) / denom;
}

function rescaleAtomics(atomic, fromDec, toDec) {
	if (fromDec === toDec) return atomic;
	if (fromDec > toDec) return atomic / 10n ** BigInt(fromDec - toDec);
	return atomic * 10n ** BigInt(toDec - fromDec);
}

// Best-effort symbol inference from the requirement when callers don't
// hand us one. Looks at `extra.name` first, then the network namespace.
function inferSymbol(requirement) {
	const name = requirement?.extra?.symbol || requirement?.extra?.name || '';
	if (name) {
		const up = String(name).toUpperCase();
		const match = up.match(/\b(SOL|ETH|BTC|MATIC|POL|BNB)\b/);
		if (match) return match[1];
	}
	if (typeof requirement?.network === 'string') {
		if (requirement.network.startsWith('solana:')) return 'SOL';
		if (requirement.network.startsWith('eip155:1')) return 'ETH';
		if (requirement.network.startsWith('eip155:56')) return 'BNB';
		if (requirement.network.startsWith('eip155:137')) return 'POL';
	}
	throw new Error(
		`spending-price: cannot infer symbol for ${JSON.stringify(requirement?.extra || {})}`,
	);
}

export const _internal = {
	isStablecoin,
	rescaleAtomics,
	inferSymbol,
	resetCache() {
		localCache.clear();
	},
};
