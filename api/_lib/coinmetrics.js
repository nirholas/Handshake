// Coin Metrics Community API layer: on-chain fundamentals for the majors
// (BTC, ETH, SOL). Keyless: https://community-api.coinmetrics.io/v4 serves a
// community subset of Coin Metrics' network data with no API key, within light
// rate limits.
//
// Sits alongside the DeFiLlama layer (api/_lib/market-data.js), which imports
// `getAssetFundamentals` from here and exposes it as its fundamentals section
// (failing soft there). Same conventions as market-data.js: per-instance LRU
// cache as a burst shield, jittered retry on 429/5xx via the shared resilience
// helper, camelCase normalized shapes.
//
// Community-tier reality (verified against /catalog-v2/asset-metrics on
// 2026-08-05): CapRealUSD and FeeTotUSD are NOT served keyless; the tier
// carries FeeTotNtv (fees in native units) plus PriceUSD, so the USD fee figure
// is derived here as FeeTotNtv * PriceUSD for the same day. SOL has no on-chain
// metrics on the community tier at all, only reference-rate/market metrics, so
// its fundamentals row carries priceUsd/marketCapUsd/volume and nulls for the
// chain-activity fields. The full keyless roster per asset differs; requests go
// out with `ignore_forbidden_errors=true` so an unavailable metric degrades to
// absent instead of failing the whole call with a 403.

import { createCache } from './mem-cache.js';
import { withRetry } from './resilience.js';

export const COINMETRICS_BASE = 'https://community-api.coinmetrics.io/v4';

/** Default assets for the fundamentals snapshot. */
export const FUNDAMENTALS_ASSETS = ['btc', 'eth', 'sol'];

/**
 * Community-available metrics requested for the fundamentals snapshot.
 * Every name here is served keyless for at least one of the default assets;
 * `ignore_forbidden_errors=true` drops the rest per asset instead of erroring.
 */
export const FUNDAMENTALS_METRICS = [
	'AdrActCnt', // active addresses (24h)
	'TxCnt', // transaction count (24h)
	'TxTfrCnt', // transfer count (24h)
	'BlkCnt', // blocks mined (24h)
	'FeeTotNtv', // total fees, native units (24h)
	'HashRate', // mean hash rate
	'SplyCur', // current supply
	'IssTotUSD', // total issuance, USD (24h)
	'CapMrktCurUSD', // market cap (current supply)
	'CapMrktEstUSD', // market cap (estimated supply; SOL only has this one)
	'CapMVRVCur', // MVRV ratio
	'PriceUSD',
	'ReferenceRateUSD',
	'volume_reported_spot_usd_1d',
];

export const COINMETRICS_CACHE_TTL = {
	// Daily-frequency data; a new point lands once a day, 30 min is generous.
	fundamentals: 1_800_000,
	timeseries: 900_000,
};

const _cache = createCache({ max: 128 });

/** Drop every cached entry. Exposed for tests; not used in product code. */
export function clearCoinMetricsCache() {
	_cache.clear();
}

/** Retry only on 429/5xx or errors with no HTTP status (network/timeout). */
function shouldRetryFetch(err) {
	const status = err?.status;
	if (typeof status !== 'number') return true;
	return status === 429 || status >= 500;
}

/**
 * GET a Coin Metrics v4 path as JSON with query params, retrying with jittered
 * exponential backoff on 429/5xx. Throws an Error carrying `.status` (and the
 * upstream error message when the body has one) on a non-retryable failure.
 *
 * @param {string} path        must start with '/'
 * @param {Record<string, string|number|boolean|undefined>} [params]
 * @param {{ maxRetries?: number, timeoutMs?: number }} [options]
 */
export function cmFetch(path, params = {}, options = {}) {
	const { maxRetries = 2, timeoutMs = 10_000 } = options;
	const url = new URL(`${COINMETRICS_BASE}${path}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}

	return withRetry(
		async () => {
			const res = await fetch(url.toString(), {
				headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				// The v4 API wraps failures as { error: { type, message } }.
				let message = `Coin Metrics HTTP ${res.status} for ${path}`;
				try {
					const body = await res.json();
					if (body?.error?.message) message = `Coin Metrics: ${body.error.message}`;
				} catch {
					// Non-JSON error body; the status-line message stands.
				}
				const err = new Error(message);
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

/** Coin Metrics returns numbers as strings; null/absent stays null. */
function toNum(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * Raw daily timeseries for one asset. Returns rows ascending by time, each
 * `{ asset, time, <metric>: number|null }`. Metrics the community tier does
 * not serve for the asset are simply absent from the rows.
 *
 * @param {string} asset             Coin Metrics asset id, e.g. 'btc'
 * @param {string[]} metrics
 * @param {{ frequency?: string, limit?: number }} [options]
 */
export async function getAssetMetrics(asset, metrics, options = {}) {
	if (!asset || typeof asset !== 'string') {
		throw Object.assign(new Error('asset is required'), { status: 400 });
	}
	if (!Array.isArray(metrics) || metrics.length === 0) {
		throw Object.assign(new Error('metrics are required'), { status: 400 });
	}
	const { frequency = '1d', limit = 4 } = options;
	const id = asset.trim().toLowerCase();
	const cacheKey = `cm:ts:${id}:${frequency}:${limit}:${metrics.join(',')}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const data = await cmFetch('/timeseries/asset-metrics', {
		assets: id,
		metrics: metrics.join(','),
		frequency,
		page_size: limit,
		paging_from: 'end',
		// An unavailable asset/metric combo degrades to absent instead of a 403
		// failing the whole call (SOL has no on-chain metrics keyless).
		ignore_forbidden_errors: true,
	});

	const rows = (Array.isArray(data?.data) ? data.data : []).map((row) => {
		const out = { asset: row.asset ?? id, time: String(row.time ?? '') };
		for (const metric of metrics) {
			if (metric in row) out[metric] = toNum(row[metric]);
		}
		return out;
	});

	_cache.set(cacheKey, rows, { ttl: COINMETRICS_CACHE_TTL.timeseries });
	return rows;
}

/**
 * @typedef {Object} AssetFundamentals
 * @property {string} asset               Coin Metrics asset id ('btc')
 * @property {string|null} asOf           ISO time of the newest data day used
 * @property {number|null} activeAddresses  AdrActCnt
 * @property {number|null} txCount          TxCnt
 * @property {number|null} transferCount    TxTfrCnt
 * @property {number|null} blockCount       BlkCnt
 * @property {number|null} feesNative       FeeTotNtv
 * @property {number|null} feesUsd          FeeTotNtv * PriceUSD (derived; the community tier has no FeeTotUSD)
 * @property {number|null} hashRate         HashRate
 * @property {number|null} supply           SplyCur
 * @property {number|null} issuanceUsd      IssTotUSD
 * @property {number|null} marketCapUsd     CapMrktCurUSD, falling back to CapMrktEstUSD
 * @property {number|null} mvrv             CapMVRVCur
 * @property {number|null} priceUsd         PriceUSD, falling back to ReferenceRateUSD
 * @property {number|null} volumeReportedUsd volume_reported_spot_usd_1d
 */

/**
 * Coalesce the latest non-null value for a metric across rows (newest last).
 * The current UTC day's row often carries nulls until end-of-day completion,
 * so a small lookback window is fetched and walked backwards.
 */
function latest(rows, metric) {
	for (let i = rows.length - 1; i >= 0; i--) {
		const v = rows[i]?.[metric];
		if (v !== null && v !== undefined) return { value: v, time: rows[i].time };
	}
	return { value: null, time: null };
}

/**
 * Latest on-chain fundamentals snapshot per asset, one request per asset
 * (the v4 API pages multi-asset responses asset-major, so per-asset requests
 * are the reliable way to get each asset's newest rows). A failing asset is
 * dropped with a warning; the call throws only when every asset failed, so a
 * partial upstream outage still yields partial data.
 *
 * @param {string[]} [assets]
 * @returns {Promise<AssetFundamentals[]>}
 */
export async function getAssetFundamentals(assets = FUNDAMENTALS_ASSETS) {
	const ids = [...new Set(assets.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
	if (ids.length === 0) {
		throw Object.assign(new Error('at least one asset is required'), { status: 400 });
	}
	const cacheKey = `cm:fundamentals:${ids.join(',')}`;
	const cached = _cache.get(cacheKey);
	if (cached) return cached;

	const settled = await Promise.allSettled(
		ids.map((id) => getAssetMetrics(id, FUNDAMENTALS_METRICS, { frequency: '1d', limit: 4 })),
	);

	const result = [];
	settled.forEach((outcome, i) => {
		if (outcome.status === 'rejected') {
			console.warn(`[coinmetrics] fundamentals for ${ids[i]} failed: ${outcome.reason?.message || outcome.reason}`);
			return;
		}
		const rows = outcome.value;
		if (!rows.length) return;

		const pick = (metric) => latest(rows, metric);
		const activeAddresses = pick('AdrActCnt');
		const txCount = pick('TxCnt');
		const transferCount = pick('TxTfrCnt');
		const blockCount = pick('BlkCnt');
		const feesNative = pick('FeeTotNtv');
		const hashRate = pick('HashRate');
		const supply = pick('SplyCur');
		const issuanceUsd = pick('IssTotUSD');
		const capCur = pick('CapMrktCurUSD');
		const capEst = pick('CapMrktEstUSD');
		const mvrv = pick('CapMVRVCur');
		const priceUsd = pick('PriceUSD');
		const refRateUsd = pick('ReferenceRateUSD');
		const volume = pick('volume_reported_spot_usd_1d');

		// Derive the USD fee total the community tier does not serve directly.
		// Pair fee and price from the SAME data day (metrics complete at
		// different times, so each latest-non-null can land on different days;
		// pricing one day's fees with another day's price would be fabricated).
		let feesUsd = null;
		for (let i = rows.length - 1; i >= 0; i--) {
			const fee = rows[i]?.FeeTotNtv;
			const price = rows[i]?.PriceUSD;
			if (fee !== null && fee !== undefined && price !== null && price !== undefined) {
				feesUsd = fee * price;
				break;
			}
		}

		const times = [
			activeAddresses, txCount, transferCount, blockCount, feesNative, hashRate,
			supply, issuanceUsd, capCur, capEst, mvrv, priceUsd, refRateUsd, volume,
		]
			.map((p) => p.time)
			.filter(Boolean)
			.sort();

		result.push({
			asset: ids[i],
			asOf: times.length ? times[times.length - 1] : null,
			activeAddresses: activeAddresses.value,
			txCount: txCount.value,
			transferCount: transferCount.value,
			blockCount: blockCount.value,
			feesNative: feesNative.value,
			feesUsd,
			hashRate: hashRate.value,
			supply: supply.value,
			issuanceUsd: issuanceUsd.value,
			marketCapUsd: capCur.value ?? capEst.value,
			mvrv: mvrv.value,
			priceUsd: priceUsd.value ?? refRateUsd.value,
			volumeReportedUsd: volume.value,
		});
	});

	if (result.length === 0) {
		const firstError = settled.find((s) => s.status === 'rejected');
		throw firstError?.reason ?? new Error('Coin Metrics returned no fundamentals data');
	}

	_cache.set(cacheKey, result, { ttl: COINMETRICS_CACHE_TTL.fundamentals });
	return result;
}
