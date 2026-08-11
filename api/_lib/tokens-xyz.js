// Tokens API v1 client (api.tokens.xyz, managed by the Solana Foundation).
//
// What it adds that the existing market stack does not have: a CANONICAL ASSET
// layer for Solana. Every other source in this repo is mint-scoped, so wSOL,
// bridged SOL and an LST look like three unrelated tokens. Tokens API groups
// mints into one canonical asset (`solana`, `usd`, `tesla`) and hands back
// every variant with its own market, liquidity tier and trust tier, so a wallet
// panel can say "you hold $412 of USD across 3 mints" instead of listing three
// rows it cannot relate.
//
// This module is deliberately coin-agnostic: every mint and every asset ref is
// supplied by the caller at runtime. Nothing here pins a specific token.
//
// Auth: TOKENS_XYZ_API_KEY, sent as `x-api-key`, server-side only. Every entry
// point returns null (or an empty result) when the key is absent, so an
// unconfigured deployment behaves exactly as it did before this module landed
// rather than surfacing a dead code path.
//
// Quota: limits AND monthly quotas are enforced per key, and both answer 429.
// The reads whose answers are stable (resolve, variants, trending, risk) go
// through the shared cache so repeated page loads cost one upstream call per
// window. The market read is left uncached on purpose: its only caller is the
// failover cascade in api/_lib/market/token-market.js, which already owns an
// L1 + L2 + single-flight cache and would otherwise cache the same value twice.
//
// Contract reference: docs/tokens-xyz.md

import { cacheWrap } from './cache.js';

const BASE = 'https://api.tokens.xyz/v1';
const DEFAULT_TIMEOUT_MS = 6000;

// Batch cap from the upstream contract: /assets/variant-markets accepts at most
// 50 mints per call. Callers pass any number; requests are chunked to this.
export const VARIANT_MARKETS_MAX_MINTS = 50;

// Cache windows, sized to how fast each answer actually moves. Mint-to-asset
// mappings change when the registry does (rarely); markets move constantly and
// are not cached here at all.
const TTL_RESOLVE_S = 6 * 3600;
const TTL_VARIANTS_S = 600;
const TTL_TRENDING_S = 60;
const TTL_RISK_S = 300;

/** Is the Tokens API key present? Every read no-ops when this is false. */
export function tokensXyzConfigured() {
	return !!process.env.TOKENS_XYZ_API_KEY;
}

// Nearly every numeric field in the v1 contract is `number | null`, where null
// means "not cached yet", not zero. Number(null) is 0, so guard the nullish and
// empty cases explicitly: rendering an unknown liquidity as $0 would be a lie.
const num = (v) => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Read the upstream error envelope: { error: { _tag, message, details? } }.
 * Falls back to the raw body so a proxy error (HTML, empty) is still legible.
 */
function errorMessage(body) {
	try {
		const parsed = JSON.parse(body);
		const e = parsed?.error;
		if (e?.message) return e._tag ? `${e._tag}: ${e.message}` : e.message;
	} catch {
		/* not JSON, fall through to the raw body */
	}
	return body.slice(0, 200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated request against the Tokens API.
 *
 * Retries only what the upstream retry matrix marks retryable (429 and
 * transient 5xx) with exponential backoff plus jitter. 400/401/403/404 throw
 * immediately: retrying them burns quota and cannot succeed.
 *
 * Thrown errors carry `.status` and lead with the numeric status in the
 * message, which is what the market cascade's circuit breaker matches on to
 * bench a rate-limited source (api/_lib/market/token-market.js `cooldownFor`).
 *
 * @param {string} path path under /v1, e.g. `/assets/resolve?ref=usd`
 * @param {{ method?: string, body?: object, retries?: number,
 *           timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
async function request(path, opts = {}) {
	const key = process.env.TOKENS_XYZ_API_KEY;
	if (!key) throw Object.assign(new Error('TOKENS_XYZ_API_KEY is not configured'), { status: 503 });

	const { method = 'GET', body, retries = 2, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
	const headers = { 'x-api-key': key, accept: 'application/json' };
	if (body) headers['content-type'] = 'application/json';

	for (let attempt = 0; ; attempt++) {
		let res;
		try {
			res = await fetch(`${BASE}${path}`, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: signal ?? AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			// Network error or timeout. Treated like a transient 5xx.
			if (attempt >= retries) throw Object.assign(new Error(`tokens.xyz unreachable: ${e.message}`), { status: 502 });
			await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 150));
			continue;
		}

		if (res.ok) return res.json();

		const raw = await res.text().catch(() => '');
		const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
		if (!retryable || attempt >= retries) {
			throw Object.assign(new Error(`${res.status} ${errorMessage(raw)}`.trim()), { status: res.status });
		}
		await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 150));
	}
}

/**
 * Normalize a variant market row. Tokens API camelCases its fields; the rest of
 * this repo's market layer is snake_case, so translate once here instead of at
 * every call site. Missing fields stay null rather than being inferred.
 *
 * @param {object|null|undefined} m raw `market` object from a variant row
 */
export function normalizeVariantMarket(m) {
	if (!m || typeof m !== 'object') return null;
	return {
		price_usd: num(m.price),
		price_change_1h: num(m.priceChange1hPercent),
		price_change_24h: num(m.priceChange24hPercent),
		market_cap: num(m.marketCap),
		liquidity: num(m.liquidity),
		volume_1h: num(m.volume1hUSD),
		volume_24h: num(m.volume24hUSD),
		volume_30d: num(m.volume30dUSD),
		trades_1h: num(m.trade1h),
		trades_24h: num(m.trade24h),
		wallets_1h: num(m.uniqueWallet1h),
		wallets_24h: num(m.uniqueWallet24h),
		decimals: num(m.decimals),
		logo_url: str(m.logoURI),
		symbol: str(m.symbol),
		name: str(m.name),
		last_trade_at: num(m.lastTradeAt),
		// Which upstream produced the numbers: birdeye, rwa_xyz, or the Solana
		// trades rollup. Worth surfacing because a clickhouse_trades row is
		// direct on-chain fill data rather than an aggregator estimate.
		metrics_source: str(m.metricsSource) || str(m.source),
		fetched_at: num(m.lastFetchedAt),
	};
}

/**
 * Normalize a variant row (a single mint inside a canonical asset).
 * @param {object} v
 */
export function normalizeVariant(v) {
	if (!v || typeof v !== 'object') return null;
	const q = v.executionQuality;
	return {
		variant_id: str(v.variantId),
		mint: str(v.mint),
		chain: str(v.chain) || 'solana',
		kind: str(v.kind),
		label: str(v.label),
		symbol: str(v.symbol),
		name: str(v.name),
		issuer: str(v.issuer),
		issuer_url: str(v.issuerUrl),
		tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [],
		liquidity_tier: str(v.liquidityTier),
		trust_tier: str(v.trustTier),
		// Redeemability tier for tokenized equities. Provider metadata for
		// routing and display only, never advice.
		stock_variant_tier: str(v.stockVariantTier),
		market: normalizeVariantMarket(v.market),
		// Cached fill-quality window (24h / 5s horizon, USDC quote). Null for
		// mints with no coverage, which is most of them.
		execution: q
			? {
					score: num(q.executionScore),
					eligible_for_primary: q.isEligibleForPrimary === true,
					volume_24h: num(q.volume24hUSD),
					trades_24h: num(q.trade24h),
					bot_volume_ratio: num(q.botVolumeRatio),
					fee_bps: num(q.feeBps),
					flow_sources: num(q.flowSourceCount),
					markout_bps: num(q.markoutBps),
					as_of: num(q.asOf),
				}
			: null,
	};
}

/**
 * Resolve any asset reference to its canonical asset plus the matching variant.
 *
 * `ref` accepts an assetId (`usd`), an alias, a raw Solana mint, or the
 * `solana-<mint>` singleton form. A mint that belongs to no canonical group
 * comes back as its own singleton asset, so the result is never empty for a
 * real mint that the registry has seen.
 *
 * @param {{ mint?: string, ref?: string, signal?: AbortSignal }} params
 * @returns {Promise<null | {
 *   asset_id: string, resolved_by: string|null, mint: string|null,
 *   name: string|null, symbol: string|null, category: string|null,
 *   aliases: string[], variant: object|null,
 * }>} null when unconfigured, unknown, or upstream is unavailable.
 */
export async function resolveAsset({ mint, ref, signal } = {}) {
	if (!tokensXyzConfigured()) return null;
	const q = mint ? `mint=${encodeURIComponent(mint)}` : ref ? `ref=${encodeURIComponent(ref)}` : null;
	if (!q) return null;

	return cacheWrap(`tokensxyz:resolve:v1:${q}`, TTL_RESOLVE_S, async () => {
		let data;
		try {
			data = await request(`/assets/resolve?${q}`, { signal });
		} catch (e) {
			// A 404 is a real answer (this mint maps to nothing); anything else is
			// an outage. Both degrade to null so callers keep their existing path.
			if (e.status !== 404) console.warn(`[tokens.xyz] resolve failed: ${e.message}`);
			return null;
		}
		const a = data?.asset;
		if (!a?.assetId) return null;
		return {
			asset_id: a.assetId,
			resolved_by: str(data.resolvedBy),
			mint: str(data.mint),
			name: str(a.name),
			symbol: str(a.symbol),
			category: str(a.category),
			aliases: Array.isArray(a.aliases) ? a.aliases.filter((x) => typeof x === 'string') : [],
			variant: normalizeVariant(data.variant),
		};
	});
}

/**
 * Every known variant of a canonical asset, richest market first.
 *
 * @param {string} assetId canonical id from resolveAsset(), e.g. `usd`
 * @param {{ kind?: string, liquidityTier?: string, stockVariantTier?: string,
 *           sortBy?: 'liquidity'|'execution_quality'|'stock_redeemability',
 *           signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<object>>} empty when unconfigured or unavailable.
 */
export async function fetchAssetVariants(assetId, opts = {}) {
	if (!tokensXyzConfigured() || !assetId) return [];
	const params = new URLSearchParams();
	if (opts.kind) params.set('kind', opts.kind);
	if (opts.liquidityTier) params.set('liquidityTier', opts.liquidityTier);
	if (opts.stockVariantTier) params.set('stockVariantTier', opts.stockVariantTier);
	if (opts.sortBy) params.set('sortBy', opts.sortBy);
	const qs = params.toString();
	const path = `/assets/${encodeURIComponent(assetId)}/variants${qs ? `?${qs}` : ''}`;

	// The failure return is null, not [], so cacheWrap does not pin a transient
	// outage as "this asset has no variants" for the whole TTL.
	const rows = await cacheWrap(`tokensxyz:variants:v1:${path}`, TTL_VARIANTS_S, async () => {
		let data;
		try {
			data = await request(path, { signal: opts.signal });
		} catch (e) {
			if (e.status !== 404) console.warn(`[tokens.xyz] variants failed for ${assetId}: ${e.message}`);
			return null;
		}
		const variants = Array.isArray(data?.variants) ? data.variants : [];
		return variants.map(normalizeVariant).filter(Boolean);
	});
	return rows || [];
}

/** Split an array into fixed-size chunks. */
function chunk(items, size) {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Batch market snapshot for a list of mints, in one upstream call per 50 mints.
 *
 * This is the read the per-mint sources in this repo cannot do: a portfolio of
 * 40 tokens costs 40 DexScreener calls but one Tokens API call. Mints with no
 * cached snapshot come back with `market: null` rather than being dropped, so
 * the caller can tell "no data" apart from "not requested".
 *
 * The sibling POST /assets/market-snapshots endpoint takes 250 mints but its
 * row shape is explicitly documented as unstable, so this uses the typed
 * variant-markets endpoint and chunks instead.
 *
 * @param {string[]} mints
 * @param {{ signal?: AbortSignal, retries?: number, strict?: boolean }} [opts]
 *   `strict` rethrows an upstream failure instead of logging it and returning a
 *   partial map. The market cascade wants that (its circuit breaker benches a
 *   source by reading the thrown status); UI callers do not.
 * @returns {Promise<Map<string, { asset_id: string|null, market: object|null,
 *   execution: object|null }>>} empty map when unconfigured or unavailable.
 */
export async function fetchVariantMarkets(mints, opts = {}) {
	const out = new Map();
	if (!tokensXyzConfigured()) return out;
	const unique = [...new Set((mints || []).filter((m) => typeof m === 'string' && m))];
	if (!unique.length) return out;

	const batches = await Promise.all(
		chunk(unique, VARIANT_MARKETS_MAX_MINTS).map(async (group) => {
			const path = `/assets/variant-markets?mints=${group.map(encodeURIComponent).join(',')}`;
			try {
				return await request(path, { signal: opts.signal, retries: opts.retries ?? 2 });
			} catch (e) {
				if (opts.strict) throw e;
				console.warn(`[tokens.xyz] variant-markets failed for ${group.length} mints: ${e.message}`);
				return null;
			}
		}),
	);

	for (const data of batches) {
		for (const row of Array.isArray(data?.variants) ? data.variants : []) {
			if (!row?.mint) continue;
			const v = normalizeVariant(row);
			out.set(row.mint, {
				asset_id: str(row.assetId),
				market: v.market,
				execution: v.execution,
			});
		}
	}
	return out;
}

/**
 * Market snapshot for exactly one mint. Thin wrapper over the batch read so the
 * market-data cascade has a single-mint entry point.
 *
 * `retries` defaults to 0 and `strict` to true: the caller is a failover chain
 * that would rather see the error and move to the next source than sit through
 * a backoff, and its circuit breaker needs the status to bench a throttled key.
 *
 * @param {string} mint
 * @param {{ signal?: AbortSignal, retries?: number, strict?: boolean }} [opts]
 * @throws when strict (the default) and the upstream call fails.
 */
export async function fetchMintMarket(mint, opts = {}) {
	const map = await fetchVariantMarkets([mint], { retries: 0, strict: true, ...opts });
	return map.get(mint) || null;
}

/**
 * Trending Solana mints, ranked by short-window momentum from direct
 * USD-stable trades. Native/wrapped SOL and stablecoins are excluded upstream
 * because they dominate routing volume.
 *
 * @param {{ category?: string, limit?: number, offset?: number,
 *           signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<object>>} empty when unconfigured or unavailable.
 */
export async function fetchTrending(opts = {}) {
	if (!tokensXyzConfigured()) return [];
	const params = new URLSearchParams();
	if (opts.category) params.set('category', opts.category);
	if (opts.limit) params.set('limit', String(Math.min(50, Math.max(1, Math.trunc(opts.limit)))));
	if (opts.offset) params.set('offset', String(Math.max(0, Math.trunc(opts.offset))));
	const qs = params.toString();
	const path = `/assets/trending${qs ? `?${qs}` : ''}`;

	// Null (not []) on failure for the same reason as fetchAssetVariants: a dead
	// upstream must not be cached as an empty trending board.
	const ranked = await cacheWrap(`tokensxyz:trending:v1:${path}`, TTL_TRENDING_S, async () => {
		let data;
		try {
			data = await request(path, { signal: opts.signal });
		} catch (e) {
			console.warn(`[tokens.xyz] trending failed: ${e.message}`);
			return null;
		}
		const rows = Array.isArray(data?.trending) ? data.trending : [];
		return rows.map((r) => ({
			rank: num(r.rank),
			asset_id: str(r.assetId),
			mint: str(r.mint),
			symbol: str(r.symbol),
			name: str(r.name),
			category: str(r.category),
			image_url: str(r.imageUrl),
			decimals: num(r.decimals),
			score: num(r.trending?.score),
			scoring_version: str(r.trending?.scoringVersion),
			market: {
				price_usd: num(r.market?.price),
				price_change_1h: num(r.market?.priceChange1hPercent),
				price_change_24h: num(r.market?.priceChange24hPercent),
				volume_5m: num(r.market?.volume5mUSD),
				volume_1h: num(r.market?.volume1hUSD),
				volume_24h: num(r.market?.volume24hUSD),
				trades_1h: num(r.market?.trade1h),
				trades_24h: num(r.market?.trade24h),
				wallets_1h: num(r.market?.uniqueWallet1h),
				wallets_24h: num(r.market?.uniqueWallet24h),
				last_trade_at: num(r.market?.lastTradeAt),
			},
		}));
	});
	return ranked || [];
}

/**
 * Market-based risk summary for a mint. Upstream needs a cached market snapshot
 * to score at all; without one it answers with `hasInsufficientData: true`,
 * which is passed through honestly rather than being scored as a pass.
 *
 * @param {string} mint
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<null | { score: number|null, grade: string|null,
 *   label: string|null, tone: string|null, trusted_launch: boolean,
 *   insufficient_data: boolean, insufficient_data_reason: string|null }>}
 */
export async function fetchRiskSummary(mint, opts = {}) {
	if (!tokensXyzConfigured() || !mint) return null;
	const path = `/assets/risk-summary?mint=${encodeURIComponent(mint)}`;

	return cacheWrap(`tokensxyz:risk:v1:${mint}`, TTL_RISK_S, async () => {
		let data;
		try {
			data = await request(path, { signal: opts.signal });
		} catch (e) {
			if (e.status !== 404) console.warn(`[tokens.xyz] risk-summary failed for ${mint.slice(0, 6)}: ${e.message}`);
			return null;
		}
		if (!data || typeof data !== 'object') return null;
		return {
			score: num(data.score),
			grade: str(data.grade),
			label: str(data.label),
			tone: str(data.tone),
			trusted_launch: data.isTrustedLaunch === true,
			insufficient_data: data.hasInsufficientData === true,
			insufficient_data_reason: str(data.insufficientDataReason),
		};
	});
}
