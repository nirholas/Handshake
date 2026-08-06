// Blockchair multichain explorer layer: https://api.blockchair.com (keyless
// within light limits: no API key needed for the stats endpoints used here).
//
// One normalized `getChainStats(chain)` per supported chain plus a fail-soft
// multi-chain aggregate. Same conventions as the DeFiLlama layer
// (api/_lib/market-data.js): per-instance LRU cache as a burst shield,
// jittered retry on 429/5xx via the shared resilience helper, camelCase
// normalized shapes. Blockchair wraps every payload as { data, context };
// `context.code` mirrors the HTTP status, so the HTTP status is authoritative.

import { createCache } from './mem-cache.js';
import { withRetry } from './resilience.js';

export const BLOCKCHAIR_BASE = 'https://api.blockchair.com';

/**
 * Chains this layer serves. Blockchair supports more; extend this allowlist
 * when a consumer needs another one (it exists so an arbitrary string can
 * never become a request path).
 */
export const BLOCKCHAIR_CHAINS = ['bitcoin', 'ethereum', 'litecoin', 'dogecoin', 'bitcoin-cash'];

export const BLOCKCHAIR_CACHE_TTL = {
	stats: 300_000, // 5 min; Blockchair itself caches stats for about a minute
};

const _cache = createCache({ max: 64 });

/** Drop every cached entry. Exposed for tests; not used in product code. */
export function clearBlockchairCache() {
	_cache.clear();
}

/** Retry only on 429/5xx or errors with no HTTP status (network/timeout). */
function shouldRetryFetch(err) {
	const status = err?.status;
	if (typeof status !== 'number') return true;
	return status === 429 || status >= 500;
}

/**
 * GET a Blockchair path as JSON, retrying with jittered exponential backoff on
 * 429/5xx. Throws an Error carrying `.status` on a non-retryable failure.
 *
 * @param {string} path  must start with '/'
 * @param {{ maxRetries?: number, timeoutMs?: number }} [options]
 */
export function blockchairFetch(path, options = {}) {
	const { maxRetries = 2, timeoutMs = 10_000 } = options;
	return withRetry(
		async () => {
			const res = await fetch(`${BLOCKCHAIR_BASE}${path}`, {
				headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				const err = new Error(`Blockchair HTTP ${res.status} for ${path}`);
				err.status = res.status;
				throw err;
			}
			return res.json();
		},
		{
			attempts: maxRetries + 1,
			initialDelayMs: 1_000,
			maxDelayMs: 30_000,
			shouldRetry: shouldRetryFetch,
		},
	);
}

/** Number or null; Blockchair mixes numbers with big-number strings. */
function toNum(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {Object} ChainStats
 * @property {string} chain
 * @property {number|null} blocks                 total blocks
 * @property {number|null} bestBlockHeight
 * @property {string|null} bestBlockHash
 * @property {string|null} bestBlockTime          UTC "YYYY-MM-DD HH:MM:SS"
 * @property {number|null} transactions           total transactions
 * @property {number|null} transactions24h
 * @property {number|null} blocks24h
 * @property {number|null} difficulty
 * @property {number|null} hashRate24h            hashes/s (approximate above 2^53)
 * @property {number|null} mempoolTransactions
 * @property {number|null} mempoolTps
 * @property {number|null} circulation            native base units (sats/wei; approximate above 2^53)
 * @property {number|null} marketPriceUsd
 * @property {number|null} marketPriceChange24hPct
 * @property {number|null} marketCapUsd
 * @property {number|null} marketDominancePct
 * @property {number|null} averageTransactionFeeUsd24h
 * @property {number|null} medianTransactionFeeUsd24h
 * @property {number|null} suggestedFeePerByteSat   UTXO chains only
 * @property {Object<string, number>|null} suggestedFeeGweiOptions  Ethereum only
 */

/**
 * Normalized explorer stats for one chain from Blockchair's
 * `/{chain}/stats` endpoint.
 *
 * @param {string} chain  one of BLOCKCHAIR_CHAINS
 * @returns {Promise<ChainStats>}
 */
export async function getChainStats(chain) {
	const id = String(chain ?? '').trim().toLowerCase();
	if (!BLOCKCHAIR_CHAINS.includes(id)) {
		throw Object.assign(
			new Error(`unsupported chain "${chain}"; supported: ${BLOCKCHAIR_CHAINS.join(', ')}`),
			{ status: 400 },
		);
	}
	const cacheKey = `bc:stats:${id}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const payload = await blockchairFetch(`/${id}/stats`);
	const d = payload?.data;
	if (!d || typeof d !== 'object') throw new Error(`unexpected Blockchair stats payload for ${id}`);

	const fees = d.suggested_transaction_fee_gwei_options;
	const result = {
		chain: id,
		blocks: toNum(d.blocks),
		bestBlockHeight: toNum(d.best_block_height),
		bestBlockHash: typeof d.best_block_hash === 'string' ? d.best_block_hash : null,
		bestBlockTime: typeof d.best_block_time === 'string' ? d.best_block_time : null,
		transactions: toNum(d.transactions),
		transactions24h: toNum(d.transactions_24h),
		blocks24h: toNum(d.blocks_24h),
		difficulty: toNum(d.difficulty),
		hashRate24h: toNum(d.hashrate_24h),
		mempoolTransactions: toNum(d.mempool_transactions),
		mempoolTps: toNum(d.mempool_tps),
		circulation: toNum(d.circulation ?? d.circulation_approximate),
		marketPriceUsd: toNum(d.market_price_usd),
		marketPriceChange24hPct: toNum(d.market_price_usd_change_24h_percentage),
		marketCapUsd: toNum(d.market_cap_usd),
		marketDominancePct: toNum(d.market_dominance_percentage),
		averageTransactionFeeUsd24h: toNum(d.average_transaction_fee_usd_24h),
		medianTransactionFeeUsd24h: toNum(d.median_transaction_fee_usd_24h),
		suggestedFeePerByteSat: toNum(d.suggested_transaction_fee_per_byte_sat),
		suggestedFeeGweiOptions:
			fees && typeof fees === 'object'
				? Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, toNum(v)]))
				: null,
	};

	_cache.set(cacheKey, result, { ttl: BLOCKCHAIR_CACHE_TTL.stats });
	return result;
}

/**
 * Stats for several chains in parallel. A failing chain is dropped with a
 * warning so one sick upstream shard never blanks the rest; throws only when
 * every requested chain failed.
 *
 * @param {string[]} [chains]
 * @returns {Promise<ChainStats[]>}
 */
export async function getMultiChainStats(chains = ['bitcoin', 'ethereum']) {
	const ids = [...new Set(chains.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
	if (ids.length === 0) {
		throw Object.assign(new Error('at least one chain is required'), { status: 400 });
	}

	const settled = await Promise.allSettled(ids.map((id) => getChainStats(id)));
	const result = [];
	settled.forEach((outcome, i) => {
		if (outcome.status === 'fulfilled') {
			result.push(outcome.value);
		} else {
			console.warn(`[blockchair] stats for ${ids[i]} failed: ${outcome.reason?.message || outcome.reason}`);
		}
	});

	if (result.length === 0) {
		const firstError = settled.find((s) => s.status === 'rejected');
		throw firstError?.reason ?? new Error('Blockchair returned no chain stats');
	}
	return result;
}
