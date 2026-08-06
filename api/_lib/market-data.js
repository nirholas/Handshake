// DeFiLlama market-data layer: protocol TVL, yield pools, chain TVL, and DEX
// volumes. Ported from SperaxOS's CryptoMarketDataService (TypeScript) into a
// plain-ESM JS module matching three.ws conventions — see
// _prompts/sperax/ref/crypto-market-data/{service,types}.ts for the source.
//
// three.ws already has a CoinGecko layer (api/_lib/coingecko.js) and
// page-specific DeFiLlama proxies (api/defi/protocols.js, api/defi/chains.js)
// tuned for their own pages' rendering shapes. This module is a separate,
// generic library layer for programmatic consumers (the trading copilot,
// future yield/protocol endpoints) that want the reference's typed shape
// (camelCase, single `chain`, `slug`-addressable protocol lookup) rather than
// a page's bespoke normalization — it does not replace either.
//
// Caching: a per-instance LRU with per-entry TTL, burst-shield only (serverless
// instances are ephemeral). Fetches retry with jittered exponential backoff on
// 429/5xx, max 2 retries, mirroring the reference's fetchWithRetry.

import { createCache } from './mem-cache.js';
import { withRetry } from './resilience.js';
import { getAssetFundamentals, FUNDAMENTALS_ASSETS } from './coinmetrics.js';

/**
 * @typedef {Object} Protocol
 * @property {string} slug
 * @property {string} name
 * @property {number} tvl
 * @property {string} category
 * @property {string} chain
 * @property {number} change1d
 * @property {number} change7d
 * @property {string} logo
 */

/**
 * @typedef {Object} ProtocolTvl
 * @property {string} slug
 * @property {string} name
 * @property {number} tvl
 * @property {string} category
 * @property {string} chain
 * @property {number} change1d
 * @property {number} change7d
 * @property {string[]} chains
 */

/**
 * @typedef {Object} YieldFilter
 * @property {string} [chain]
 * @property {string} [project]
 * @property {boolean} [stablecoin]
 * @property {number} [minTvl]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} YieldPool
 * @property {string} pool
 * @property {string} project
 * @property {string} chain
 * @property {string} symbol
 * @property {number} tvlUsd
 * @property {number} apy
 * @property {number} apyBase
 * @property {number} apyReward
 * @property {boolean} stablecoin
 * @property {string} ilRisk
 */

/**
 * @typedef {Object} ChainTvl
 * @property {string} name
 * @property {number} tvl
 * @property {string} tokenSymbol
 * @property {number} dominance
 * @property {number} change1d
 */

/**
 * @typedef {Object} DexVolume
 * @property {string} name
 * @property {number} volume24h
 * @property {number} change1d
 * @property {string} chain
 */

/**
 * @typedef {Object} FearGreedIndex
 * @property {number} value
 * @property {string} classification
 * @property {string} timestamp
 */

// ---------------------------------------------------------------------------
// Cache TTLs (ms) — per source, mirroring the reference's DEFAULT_CACHE_TTL
// with the values decision 2 calls for.
// ---------------------------------------------------------------------------
export const CACHE_TTL = {
	protocols: 600_000, // 10 min
	yields: 900_000, // 15 min
	fearGreed: 1_800_000, // 30 min
	dexVolumes: 600_000, // 10 min
	fundamentals: 1_800_000, // 30 min (daily-frequency Coin Metrics data)
};

// True LRU with per-entry TTL. The previous Map evicted the oldest INSERTED
// key at the cap, so a continuously-hot series could be dropped while colder
// keys inserted after it survived.
const _cache = createCache({ max: 512 });

function getCached(key) {
	return _cache.get(key);
}

function setCache(key, data, ttlMs) {
	_cache.set(key, data, { ttl: ttlMs });
}

/** Drop every cached entry. Exposed for tests; not used in product code. */
export function clearMarketDataCache() {
	_cache.clear();
}

// ---------------------------------------------------------------------------
// Fetch with retry + jittered exponential backoff on 429/5xx.
// ---------------------------------------------------------------------------

/**
 * A response error is retryable only on 429/5xx. Anything thrown by `fetch`
 * itself (network reset, DNS failure, abort on timeout) carries no status and
 * is always worth another attempt.
 */
function shouldRetryFetch(err) {
	const status = err?.status;
	if (typeof status !== 'number') return true;
	return status === 429 || status >= 500;
}

/**
 * GET a URL as JSON, retrying up to `maxRetries` times with jittered
 * exponential backoff on HTTP 429 or 5xx responses (and on network errors).
 * Throws on a non-retryable error status (4xx other than 429) or once retries
 * are spent.
 *
 * The backoff is decorrelated-jittered (via the shared `withRetry` helper), so
 * a fleet-wide upstream blip no longer re-synchronizes every caller into the
 * same retry wave the way the previous fixed `2 ** attempt` schedule did.
 *
 * @param {string} url
 * @param {{ maxRetries?: number, timeoutMs?: number }} [options]
 */
export function fetchWithRetry(url, options = {}) {
	const { maxRetries = 2, timeoutMs = 10_000 } = options;

	return withRetry(
		async () => {
			const res = await fetch(url, {
				headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				const err = new Error(`HTTP ${res.status} for ${url}`);
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

// ---------------------------------------------------------------------------
// DeFiLlama — https://api.llama.fi/ and https://yields.llama.fi/
// ---------------------------------------------------------------------------

const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/**
 * Top DeFi protocols by TVL, optionally filtered to one chain.
 * @param {{ chain?: string, limit?: number }} [options]
 * @returns {Promise<Protocol[]>}
 */
export async function getProtocols(options = {}) {
	const { chain, limit = 20 } = options;
	const cacheKey = `dl:protocols:${chain ?? 'all'}:${limit}`;
	const cached = getCached(cacheKey);
	if (cached) return cached;

	const data = await fetchWithRetry('https://api.llama.fi/protocols');
	if (!Array.isArray(data)) throw new Error('unexpected protocols payload');

	let protocols = data;
	if (chain) {
		const lc = chain.toLowerCase();
		protocols = protocols.filter(
			(p) =>
				(p.chain ?? '').toLowerCase() === lc ||
				(Array.isArray(p.chains) ? p.chains : []).some((c) => String(c).toLowerCase() === lc),
		);
	}

	const result = protocols
		.slice()
		.sort((a, b) => finite(Number(b.tvl)) - finite(Number(a.tvl)))
		.slice(0, limit)
		.map((p) => ({
			slug: p.slug ?? '',
			name: p.name ?? '',
			tvl: finite(Number(p.tvl)),
			category: p.category ?? 'Unknown',
			chain: p.chain ?? 'Multi-chain',
			change1d: finite(Number(p.change_1d)),
			change7d: finite(Number(p.change_7d)),
			logo: p.logo ?? '',
		}));

	setCache(cacheKey, result, CACHE_TTL.protocols);
	return result;
}

/**
 * Single protocol's TVL detail by DeFiLlama slug.
 * @param {string} slug
 * @returns {Promise<ProtocolTvl>}
 */
export async function getProtocol(slug) {
	if (!slug || typeof slug !== 'string') {
		throw Object.assign(new Error('slug is required'), { status: 400 });
	}
	const cacheKey = `dl:protocol:${slug}`;
	const cached = getCached(cacheKey);
	if (cached) return cached;

	const data = await fetchWithRetry(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`);

	const result = {
		slug: data?.slug ?? slug,
		name: data?.name ?? slug,
		tvl: finite(Number(data?.tvl)),
		category: data?.category ?? 'Unknown',
		chain: data?.chain ?? 'Multi-chain',
		change1d: finite(Number(data?.change_1d)),
		change7d: finite(Number(data?.change_7d)),
		chains: Array.isArray(data?.chains) ? data.chains.filter((c) => typeof c === 'string') : [],
	};

	setCache(cacheKey, result, CACHE_TTL.protocols);
	return result;
}

/**
 * Yield pools from DeFiLlama's yields API, filtered server-side.
 * @param {YieldFilter} [filter]
 * @returns {Promise<YieldPool[]>}
 */
export async function getYieldPools(filter = {}) {
	const { chain, project, stablecoin, minTvl = 0, limit = 15 } = filter;
	const cacheKey = `dl:yields:${chain ?? ''}:${project ?? ''}:${stablecoin ?? ''}:${minTvl}`;
	let pools = getCached(cacheKey);
	if (!pools) {
		const data = await fetchWithRetry('https://yields.llama.fi/pools');
		const raw = Array.isArray(data?.data) ? data.data : [];

		let filtered = raw;
		if (chain) {
			const lc = chain.toLowerCase();
			filtered = filtered.filter((p) => (p.chain ?? '').toLowerCase() === lc);
		}
		if (project) {
			const lp = project.toLowerCase();
			filtered = filtered.filter((p) => (p.project ?? '').toLowerCase() === lp);
		}
		if (stablecoin !== undefined) {
			filtered = filtered.filter((p) => Boolean(p.stablecoin) === Boolean(stablecoin));
		}
		filtered = filtered.filter((p) => finite(Number(p.tvlUsd)) >= minTvl);

		pools = filtered
			.sort((a, b) => finite(Number(b.tvlUsd)) - finite(Number(a.tvlUsd)))
			.map((p) => ({
				pool: p.pool ?? '',
				project: p.project ?? '',
				chain: p.chain ?? '',
				symbol: p.symbol ?? '',
				tvlUsd: finite(Number(p.tvlUsd)),
				apy: finite(Number(p.apy)),
				apyBase: finite(Number(p.apyBase)),
				apyReward: finite(Number(p.apyReward)),
				stablecoin: Boolean(p.stablecoin),
				ilRisk: p.ilRisk ?? 'unknown',
			}));

		setCache(cacheKey, pools, CACHE_TTL.yields);
	}

	return pools.slice(0, limit);
}

/**
 * Cross-chain TVL breakdown, sorted by TVL desc, with each chain's dominance
 * (% of total TVL across all chains).
 * @returns {Promise<ChainTvl[]>}
 */
export async function getChainTvls() {
	const cacheKey = 'dl:chains';
	const cached = getCached(cacheKey);
	if (cached) return cached;

	const data = await fetchWithRetry('https://api.llama.fi/v2/chains');
	if (!Array.isArray(data)) throw new Error('unexpected chains payload');

	const totalTvl = data.reduce((sum, c) => sum + finite(Number(c?.tvl)), 0);

	const result = data
		.slice()
		.sort((a, b) => finite(Number(b.tvl)) - finite(Number(a.tvl)))
		.slice(0, 20)
		.map((c) => ({
			name: c.name ?? '',
			tvl: finite(Number(c.tvl)),
			tokenSymbol: c.tokenSymbol ?? '',
			dominance: totalTvl > 0 ? (finite(Number(c.tvl)) / totalTvl) * 100 : 0,
			change1d: finite(Number(c.change_1d)),
		}));

	setCache(cacheKey, result, CACHE_TTL.protocols);
	return result;
}

/**
 * Top DEX protocols by 24h trading volume, optionally filtered to one chain.
 * @param {{ chain?: string }} [options]
 * @returns {Promise<DexVolume[]>}
 */
export async function getDexVolumes(options = {}) {
	const { chain } = options;
	const cacheKey = `dl:dex:${chain ?? 'all'}`;
	const cached = getCached(cacheKey);
	if (cached) return cached;

	const data = await fetchWithRetry('https://api.llama.fi/overview/dexs');
	let dexes = Array.isArray(data?.protocols) ? data.protocols : [];
	if (chain) {
		const lc = chain.toLowerCase();
		dexes = dexes.filter((d) => (Array.isArray(d.chains) ? d.chains : []).some((c) => String(c).toLowerCase() === lc));
	}

	const result = dexes
		.slice()
		.sort((a, b) => finite(Number(b.total24h)) - finite(Number(a.total24h)))
		.slice(0, 15)
		.map((d) => ({
			name: d.name ?? '',
			volume24h: finite(Number(d.total24h)),
			change1d: finite(Number(d.change_1d)),
			chain: (Array.isArray(d.chains) ? d.chains : []).join(', '),
		}));

	setCache(cacheKey, result, CACHE_TTL.dexVolumes);
	return result;
}

// ---------------------------------------------------------------------------
// Fear & Greed Index — https://api.alternative.me/
//
// three.ws already has a fully-featured fear/greed endpoint at
// api/coin/fear-greed.js (history + week-over-week delta, its own cache).
// getFearGreed() here is the reference's minimal single-reading shape, kept
// as a library function only so a future internal consumer (e.g. the trading
// copilot scoring a market snapshot) can pull one lightweight reading without
// depending on the page endpoint's richer/history-shaped response. It is not
// wired to any endpoint in this task.
// ---------------------------------------------------------------------------

/**
 * Latest Fear & Greed reading (single data point, no history).
 * @returns {Promise<FearGreedIndex>}
 */
export async function getFearGreed() {
	const cacheKey = 'fng:latest';
	const cached = getCached(cacheKey);
	if (cached) return cached;

	const data = await fetchWithRetry('https://api.alternative.me/fng/?limit=1');
	const entry = Array.isArray(data?.data) ? data.data[0] : undefined;

	const result = {
		value: finite(Number(entry?.value), 50),
		classification: String(entry?.value_classification ?? 'Neutral'),
		timestamp: String(entry?.timestamp ?? Math.floor(Date.now() / 1000).toString()),
	};

	setCache(cacheKey, result, CACHE_TTL.fearGreed);
	return result;
}

// ---------------------------------------------------------------------------
// On-chain fundamentals: Coin Metrics Community API (keyless), via
// api/_lib/coinmetrics.js. Daily network metrics for the majors: active
// addresses, tx/transfer counts, fees, hash rate, supply, market cap, MVRV.
// FAILS SOFT by design: fundamentals enrich a market snapshot, they never
// gate one, so a Coin Metrics outage degrades to an empty array here instead
// of rejecting the caller the way the DeFiLlama getters above do.
// ---------------------------------------------------------------------------

/**
 * Latest on-chain fundamentals per asset (default BTC, ETH, SOL). Each entry
 * is an AssetFundamentals shape (see api/_lib/coinmetrics.js): camelCase
 * metric values coalesced to the newest completed data day, with nulls for
 * metrics the community tier does not serve for that asset (SOL only has
 * market metrics keyless).
 *
 * @param {string[]} [assets]
 * @returns {Promise<import('./coinmetrics.js').AssetFundamentals[]>}
 */
export async function getFundamentals(assets = FUNDAMENTALS_ASSETS) {
	const cacheKey = `cm:market-data:fundamentals:${assets.join(',')}`;
	const cached = getCached(cacheKey);
	if (cached) return cached;

	let result;
	try {
		result = await getAssetFundamentals(assets);
	} catch (err) {
		console.warn(`[market-data] fundamentals unavailable: ${err?.message || err}`);
		return [];
	}

	setCache(cacheKey, result, CACHE_TTL.fundamentals);
	return result;
}
