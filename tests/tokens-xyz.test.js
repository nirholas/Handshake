// api/_lib/tokens-xyz.js: Tokens API v1 client (api.tokens.xyz).
//
// No live network: fetch is stubbed with vi.stubGlobal so these exercise the
// module's real auth gating, chunking, retry matrix, cache behavior, and field
// mapping against payloads shaped exactly like the published v1 contract
// (test doubles, which the no-mocks rule permits; what it bars is fake data in
// the product). Mints are $THREE or clearly synthetic placeholders, never a
// third-party mainnet address.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { cacheStore } = vi.hoisted(() => ({ cacheStore: new Map() }));

vi.mock('../api/_lib/cache.js', () => ({
	cacheWrap: async (key, _ttl, fn) => {
		if (cacheStore.has(key)) return cacheStore.get(key);
		const value = await fn();
		if (value !== null && value !== undefined) cacheStore.set(key, value);
		return value;
	},
}));

const {
	tokensXyzConfigured,
	resolveAsset,
	fetchAssetVariants,
	fetchVariantMarkets,
	fetchMintMarket,
	fetchTrending,
	fetchRiskSummary,
	normalizeVariantMarket,
	VARIANT_MARKETS_MAX_MINTS,
} = await import('../api/_lib/tokens-xyz.js');

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYNTH_MINT = 'THREEsynthetic1111111111111111111111111111';

function jsonResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

let fetchMock;

beforeEach(() => {
	cacheStore.clear();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	process.env.TOKENS_XYZ_API_KEY = 'test-key';
});

afterEach(() => {
	delete process.env.TOKENS_XYZ_API_KEY;
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('auth gating', () => {
	it('reports configured only when the key is present', () => {
		expect(tokensXyzConfigured()).toBe(true);
		delete process.env.TOKENS_XYZ_API_KEY;
		expect(tokensXyzConfigured()).toBe(false);
	});

	it('no-ops every read without a key instead of calling upstream', async () => {
		delete process.env.TOKENS_XYZ_API_KEY;
		expect(await resolveAsset({ mint: THREE_MINT })).toBeNull();
		expect(await fetchAssetVariants('usd')).toEqual([]);
		expect(await fetchVariantMarkets([THREE_MINT])).toEqual(new Map());
		expect(await fetchMintMarket(THREE_MINT)).toBeNull();
		expect(await fetchTrending()).toEqual([]);
		expect(await fetchRiskSummary(THREE_MINT)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends the key as x-api-key, never in the URL', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { variants: [] }));
		await fetchVariantMarkets([THREE_MINT]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(init.headers['x-api-key']).toBe('test-key');
		expect(url).not.toContain('test-key');
	});
});

describe('resolveAsset', () => {
	const PAYLOAD = {
		assetId: 'three',
		resolvedBy: 'mint',
		mint: THREE_MINT,
		asset: { assetId: 'three', name: 'Three', symbol: 'THREE', category: 'crypto', aliases: ['three-ws'] },
		variant: {
			mint: THREE_MINT,
			chain: 'solana',
			kind: 'native',
			liquidityTier: 'tier2',
			trustTier: 'tier2',
			tags: ['spot'],
		},
	};

	it('maps the canonical asset and its variant into snake_case', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, PAYLOAD));
		const out = await resolveAsset({ mint: THREE_MINT });
		expect(out).toMatchObject({
			asset_id: 'three',
			resolved_by: 'mint',
			mint: THREE_MINT,
			symbol: 'THREE',
			category: 'crypto',
			aliases: ['three-ws'],
		});
		expect(out.variant).toMatchObject({ mint: THREE_MINT, chain: 'solana', liquidity_tier: 'tier2' });
	});

	it('prefers mint over ref and serves the second call from cache', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, PAYLOAD));
		await resolveAsset({ mint: THREE_MINT, ref: 'ignored' });
		expect(fetchMock.mock.calls[0][0]).toContain(`mint=${THREE_MINT}`);
		expect(fetchMock.mock.calls[0][0]).not.toContain('ref=');

		await resolveAsset({ mint: THREE_MINT, ref: 'ignored' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns null on an unknown ref without caching the miss', async () => {
		fetchMock.mockResolvedValue(jsonResponse(404, { error: { _tag: 'NotFoundError', message: 'unknown' } }));
		expect(await resolveAsset({ ref: 'nope' })).toBeNull();
		expect(cacheStore.size).toBe(0);
	});
});

describe('fetchAssetVariants', () => {
	it('maps variant rows including execution quality and redeemability tier', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				assetId: 'three',
				variants: [
					{
						variantId: 'three:native',
						mint: THREE_MINT,
						kind: 'native',
						label: 'Native',
						symbol: 'THREE',
						liquidityTier: 'tier2',
						trustTier: 'tier2',
						tags: ['spot'],
						stockVariantTier: 'not_redeemable',
						market: { price: 0.004, liquidity: 120_000, volume24hUSD: 33_000, marketCap: 4_000_000, priceChange24hPercent: -1.5, decimals: 6, logoURI: 'https://x/three.png', metricsSource: 'clickhouse_trades' },
						executionQuality: { executionScore: 72.16, isEligibleForPrimary: true, volume24hUSD: 113_501.87, trade24h: 1009, botVolumeRatio: 0.959, feeBps: 0, flowSourceCount: 9, markoutBps: -2.35, asOf: 1786319999 },
					},
				],
			}),
		);

		const [v] = await fetchAssetVariants('three', { sortBy: 'execution_quality' });
		expect(fetchMock.mock.calls[0][0]).toContain('sortBy=execution_quality');
		expect(v).toMatchObject({
			variant_id: 'three:native',
			mint: THREE_MINT,
			kind: 'native',
			stock_variant_tier: 'not_redeemable',
			liquidity_tier: 'tier2',
		});
		expect(v.market).toMatchObject({ price_usd: 0.004, liquidity: 120_000, metrics_source: 'clickhouse_trades' });
		expect(v.execution).toMatchObject({ score: 72.16, eligible_for_primary: true, flow_sources: 9 });
	});

	it('does not pin an upstream outage as an empty variant list', async () => {
		fetchMock.mockResolvedValue(jsonResponse(500, { error: { _tag: 'InternalError', message: 'boom' } }));
		expect(await fetchAssetVariants('three', { sortBy: 'liquidity' })).toEqual([]);
		expect(cacheStore.size).toBe(0);
	});
});

describe('fetchVariantMarkets', () => {
	it('chunks the mint list to the documented per-call cap', async () => {
		const mints = Array.from({ length: 120 }, (_, i) => `${SYNTH_MINT.slice(0, 38)}${String(i).padStart(4, '0')}`);
		fetchMock.mockResolvedValue(jsonResponse(200, { variants: [] }));

		await fetchVariantMarkets(mints);

		expect(VARIANT_MARKETS_MAX_MINTS).toBe(50);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const counts = fetchMock.mock.calls.map(([url]) => url.split('mints=')[1].split(',').length);
		expect(counts).toEqual([50, 50, 20]);
	});

	it('de-dupes mints before batching', async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { variants: [] }));
		await fetchVariantMarkets([THREE_MINT, THREE_MINT, SYNTH_MINT]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0].split('mints=')[1].split(',')).toHaveLength(2);
	});

	it('keys results by mint and keeps an uncached mint as an explicit null market', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				variants: [
					{ mint: THREE_MINT, assetId: 'three', chain: 'solana', market: { price: 0.004, liquidity: 120_000, volume24hUSD: 33_000, marketCap: 4_000_000, priceChange24hPercent: -1.5, decimals: 6 }, executionQuality: null },
					{ mint: SYNTH_MINT, assetId: null, chain: 'solana', market: null, executionQuality: null },
				],
			}),
		);

		const map = await fetchVariantMarkets([THREE_MINT, SYNTH_MINT]);
		expect(map.get(THREE_MINT)).toMatchObject({ asset_id: 'three', execution: null });
		expect(map.get(THREE_MINT).market.price_usd).toBe(0.004);
		expect(map.get(SYNTH_MINT)).toEqual({ asset_id: null, market: null, execution: null });
	});

	it('returns a partial map when one chunk fails and strict is off', async () => {
		const mints = Array.from({ length: 60 }, (_, i) => `${SYNTH_MINT.slice(0, 38)}${String(i).padStart(4, '0')}`);
		fetchMock
			.mockResolvedValueOnce(jsonResponse(200, { variants: [{ mint: mints[0], assetId: 'x', market: { price: 1 }, executionQuality: null }] }))
			.mockResolvedValueOnce(jsonResponse(400, { error: { _tag: 'BadRequestError', message: 'bad mint' } }));

		const map = await fetchVariantMarkets(mints);
		expect(map.size).toBe(1);
	});
});

describe('fetchMintMarket', () => {
	it('rethrows upstream failures so a failover caller can bench the source', async () => {
		fetchMock.mockResolvedValue(jsonResponse(429, { error: { _tag: 'RateLimitedError', message: 'quota exceeded' } }));
		await expect(fetchMintMarket(THREE_MINT)).rejects.toThrow(/^429 /);
	});

	it('leads the error message with the numeric status', async () => {
		fetchMock.mockResolvedValue(jsonResponse(403, { error: { _tag: 'ForbiddenError', message: 'missing scope' } }));
		await expect(fetchMintMarket(THREE_MINT)).rejects.toThrow('403 ForbiddenError: missing scope');
	});
});

describe('retry matrix', () => {
	it('retries a 429 and returns the eventual success', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, { error: { _tag: 'RateLimitedError', message: 'slow down' } }))
			.mockResolvedValueOnce(jsonResponse(200, { variants: [{ mint: THREE_MINT, assetId: 'three', market: { price: 2 }, executionQuality: null }] }));

		const map = await fetchVariantMarkets([THREE_MINT], { retries: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(map.get(THREE_MINT).market.price_usd).toBe(2);
	});

	it('never retries a 400', async () => {
		fetchMock.mockResolvedValue(jsonResponse(400, { error: { _tag: 'BadRequestError', message: 'Invalid mint' } }));
		await fetchVariantMarkets([THREE_MINT], { retries: 2 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('fetchTrending', () => {
	it('clamps limit to the documented range and maps the ranked rows', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				trending: [
					{ rank: 1, assetId: 'three', mint: THREE_MINT, symbol: 'THREE', name: 'Three', decimals: 6, category: 'crypto', imageUrl: 'https://x/three.png', market: { price: 0.004, volume1hUSD: 900, volume24hUSD: 33_000, trade24h: 500, uniqueWallet24h: 120, priceChange1hPercent: 0.4, priceChange24hPercent: -1.5, lastTradeAt: 1786419489 }, trending: { score: 72.14, scoringVersion: 'solana-direct-stable-v1' } },
				],
				meta: { limit: 50, offset: 0, total: 50 },
			}),
		);

		const [row] = await fetchTrending({ limit: 500 });
		expect(fetchMock.mock.calls[0][0]).toContain('limit=50');
		expect(row).toMatchObject({ rank: 1, asset_id: 'three', mint: THREE_MINT, score: 72.14 });
		expect(row.market).toMatchObject({ price_usd: 0.004, volume_24h: 33_000, wallets_24h: 120 });
	});
});

describe('fetchRiskSummary', () => {
	it('passes an insufficient-data verdict through instead of scoring it as a pass', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, { score: 0, grade: 'C', label: 'Insufficient Data', tone: 'info', isTrustedLaunch: false, caps: [], hasInsufficientData: true, insufficientDataReason: 'Market snapshot not available in cache' }),
		);
		const out = await fetchRiskSummary(THREE_MINT);
		expect(out).toMatchObject({
			score: 0,
			grade: 'C',
			trusted_launch: false,
			insufficient_data: true,
			insufficient_data_reason: 'Market snapshot not available in cache',
		});
	});
});

describe('normalizeVariantMarket', () => {
	it('returns null for a missing market rather than a hollow object', () => {
		expect(normalizeVariantMarket(null)).toBeNull();
		expect(normalizeVariantMarket(undefined)).toBeNull();
	});

	it('nulls unparseable numbers instead of emitting NaN', () => {
		const m = normalizeVariantMarket({ price: 'not-a-number', liquidity: null, volume24hUSD: '1200' });
		expect(m.price_usd).toBeNull();
		expect(m.liquidity).toBeNull();
		expect(m.volume_24h).toBe(1200);
	});

	it('falls back to source when metricsSource is absent', () => {
		expect(normalizeVariantMarket({ price: 1, source: 'birdeye' }).metrics_source).toBe('birdeye');
	});

	// Undocumented in the published v1 type but present live on birdeye-sourced
	// rows (verified 2026-08-11). Dropping them cost the cascade its holder count
	// on exactly the reads where Birdeye's own quota is exhausted.
	it('carries the holder count and supply that live rows include', () => {
		const m = normalizeVariantMarket({
			price: 76.08,
			holder: 7_709_323,
			circulatingSupply: 582_481_767.41,
			totalSupply: 632_009_825.03,
			fdv: 48_082_911_165.48,
		});
		expect(m).toMatchObject({
			holders: 7_709_323,
			supply: 582_481_767.41,
			total_supply: 632_009_825.03,
			fdv: 48_082_911_165.48,
		});
	});

	it('leaves holders and supply null on a row that omits them', () => {
		const m = normalizeVariantMarket({ price: 1, metricsSource: 'clickhouse_trades' });
		expect(m.holders).toBeNull();
		expect(m.supply).toBeNull();
		expect(m.total_supply).toBeNull();
	});
});
