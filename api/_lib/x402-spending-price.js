// Cross-network amount normalization for x402 spending caps (USE-22).
//
// Caps are enforced in micro-USD (6 decimals) so $0.10 cap === 100_000.
// Most x402 transfers today are USDC, which is already pegged 1:1 to USD
// and whose `amount` is already in micro-USD (6 decimals). For tokens
// pegged differently (e.g. USDT-on-BSC is still ~1:1 USD; SOL would not
// be), this module exposes a lightweight price oracle that pulls from
// Coinbase's spot API. Results are cached for 5 minutes so we don't
// hammer the API in tight loops.
//
// We deliberately avoid `import { fetch }` — Node 18+ + browsers ship
// global fetch, and this module needs to run unchanged in both.

import { cacheGet, cacheSet } from './cache.js';

const PRICE_TTL_S = 5 * 60;
const PRICE_API = 'https://api.coinbase.com/v2/prices';

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

// Per-process micro-cache to short-circuit the Redis round-trip when the same
// symbol is hit twice in one function invocation (e.g. multi-leg settlement).
const localCache = new Map();

function isStablecoin(name) {
	if (!name) return false;
	return USD_STABLECOINS.has(String(name).trim().toLowerCase());
}

// Pull a fresh spot price (in USD) for a symbol like 'SOL' or 'ETH'. Uses
// Coinbase's public spot endpoint — no API key, ~30 req/sec rate limit.
// Cached for PRICE_TTL_MS.
async function fetchSpotUsd(symbol) {
	const key = symbol.toUpperCase();
	const local = localCache.get(key);
	if (local && local.expiresAt > Date.now()) return local.value;
	const cacheKey = `spot-usd:${key}`;
	const shared = await cacheGet(cacheKey);
	if (typeof shared === 'number' && Number.isFinite(shared) && shared > 0) {
		localCache.set(key, { value: shared, expiresAt: Date.now() + PRICE_TTL_S * 1000 });
		return shared;
	}
	let res;
	try {
		res = await fetch(`${PRICE_API}/${key}-USD/spot`, {
			signal: AbortSignal.timeout(5_000),
		});
	} catch (err) {
		throw new Error(`spending-price: spot fetch for ${key}-USD failed: ${err.message}`);
	}
	if (!res.ok) {
		throw new Error(`spending-price: ${key}-USD returned ${res.status}`);
	}
	const json = await res.json();
	const raw = json?.data?.amount;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`spending-price: ${key}-USD invalid response: ${raw}`);
	}
	localCache.set(key, { value, expiresAt: Date.now() + PRICE_TTL_S * 1000 });
	await cacheSet(cacheKey, value, PRICE_TTL_S);
	return value;
}

// Resolve `(amountAtomics, requirement)` → BigInt micro-USD. For stablecoins
// the amount is already in micro-USD (USDC, USDT, DAI all have 6 decimals);
// we just rescale to 6 if the token uses different decimals. For non-pegged
// tokens we multiply by the spot price.
//
// The function NEVER throws on a missing price for a stablecoin path —
// that's the dominant flow. It only reaches out to Coinbase when the
// requirement explicitly declares a non-pegged token.
export async function toMicroUsd(amount, requirement) {
	const atomic = BigInt(amount);
	const decimals = Number(requirement?.extra?.decimals ?? DEFAULT_TOKEN_DECIMALS);
	const name = requirement?.extra?.name || '';
	if (isStablecoin(name)) {
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
