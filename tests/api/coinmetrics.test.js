// api/_lib/coinmetrics.js: Coin Metrics Community API layer, plus the
// fail-soft fundamentals wiring in api/_lib/market-data.js.
//
// No live network: fetch is mocked with vi.stubGlobal so these exercise the
// module's real caching, retry, coalescing, and shape-mapping logic against
// payloads captured from the real community API on 2026-08-05 (allowed under
// the no-mocks rule, which bars fake data in the product, not test doubles).
// Live-network verification was run separately with real `node -e` calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getAssetMetrics,
	getAssetFundamentals,
	cmFetch,
	clearCoinMetricsCache,
	FUNDAMENTALS_METRICS,
	COINMETRICS_BASE,
} from '../../api/_lib/coinmetrics.js';
import { getFundamentals, clearMarketDataCache } from '../../api/_lib/market-data.js';

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body };
}

let fetchMock;

beforeEach(() => {
	clearCoinMetricsCache();
	clearMarketDataCache();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// Captured from the live community API (values as returned: numbers as
// strings, the current UTC day carrying nulls until end-of-day completion).
const BTC_ROWS = {
	data: [
		{
			asset: 'btc',
			time: '2026-08-03T00:00:00.000000000Z',
			AdrActCnt: '741819',
			BlkCnt: '150',
			CapMVRVCur: '1.202801204686642675',
			CapMrktCurUSD: '1273346363617.167523590440547882',
			FeeTotNtv: '3.9421898',
			HashRate: '941250341.229388156826514248312551951404',
			IssTotUSD: '29746897.55232684375',
			PriceUSD: '63460.0481116306',
			ReferenceRateUSD: '63445.6829658095',
			SplyCur: '20065323.01042797',
			TxCnt: '702879',
			TxTfrCnt: '1058121',
		},
		{
			asset: 'btc',
			time: '2026-08-04T00:00:00.000000000Z',
			AdrActCnt: '684692',
			BlkCnt: '141',
			CapMVRVCur: '1.21621443137356142',
			CapMrktCurUSD: '1287448909177.39337035991202835',
			FeeTotNtv: '3.26374575',
			HashRate: '884775320.936344932354661711723726951404',
			IssTotUSD: '28271148.106582396875',
			PriceUSD: '64161.470880187',
			ReferenceRateUSD: '63460.0481116306',
			SplyCur: '20065763.63533705',
			TxCnt: '619401',
			TxTfrCnt: '959665',
		},
		{
			asset: 'btc',
			time: '2026-08-05T00:00:00.000000000Z',
			AdrActCnt: null,
			BlkCnt: null,
			CapMVRVCur: null,
			CapMrktCurUSD: null,
			FeeTotNtv: null,
			HashRate: null,
			IssTotUSD: null,
			PriceUSD: null,
			ReferenceRateUSD: '64161.470880187',
			SplyCur: null,
			TxCnt: null,
			TxTfrCnt: null,
		},
	],
};

// SOL has no on-chain metrics on the community tier: only reference
// rate/market metrics come back, the rest are absent from the rows entirely.
const SOL_ROWS = {
	data: [
		{
			asset: 'sol',
			time: '2026-08-04T00:00:00.000000000Z',
			CapMrktEstUSD: '42908375875.99746630027953975162',
			ReferenceRateUSD: '73.4220010898139',
			volume_reported_spot_usd_1d: '437308247.245655',
		},
		{
			asset: 'sol',
			time: '2026-08-05T00:00:00.000000000Z',
			CapMrktEstUSD: null,
			ReferenceRateUSD: '73.8281576996287',
			volume_reported_spot_usd_1d: null,
		},
	],
};

function routeByAsset(url) {
	const u = String(url);
	if (u.includes('assets=btc')) return jsonResponse(200, BTC_ROWS);
	if (u.includes('assets=sol')) return jsonResponse(200, SOL_ROWS);
	return jsonResponse(403, { error: { type: 'forbidden', message: 'not available with supplied credentials' } });
}

describe('cmFetch', () => {
	it('builds the query and parses JSON on 200', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
		await cmFetch('/timeseries/asset-metrics', { assets: 'btc', page_size: 4 });
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url.startsWith(`${COINMETRICS_BASE}/timeseries/asset-metrics?`)).toBe(true);
		expect(url).toContain('assets=btc');
		expect(url).toContain('page_size=4');
	});

	it('retries on 429 then succeeds', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, {}))
			.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
		const promise = cmFetch('/timeseries/asset-metrics', { assets: 'btc' });
		await vi.advanceTimersByTimeAsync(2100);
		await expect(promise).resolves.toEqual({ data: [] });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('surfaces the upstream error message on a non-retryable 403', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(403, { error: { type: 'forbidden', message: 'metric not available' } }),
		);
		await expect(cmFetch('/timeseries/asset-metrics', { assets: 'btc' })).rejects.toThrow(
			/metric not available/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('getAssetMetrics', () => {
	it('numbers the string values, keeps nulls, and requests ignore_forbidden_errors', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const rows = await getAssetMetrics('btc', ['AdrActCnt', 'PriceUSD'], { limit: 3 });
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ asset: 'btc', time: '2026-08-03T00:00:00.000000000Z', AdrActCnt: 741819 });
		expect(rows[2].AdrActCnt).toBeNull();
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain('ignore_forbidden_errors=true');
		expect(url).toContain('paging_from=end');
	});

	it('caches per (asset, frequency, limit, metrics)', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		await getAssetMetrics('btc', ['AdrActCnt']);
		await getAssetMetrics('btc', ['AdrActCnt']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a missing asset without hitting the network', async () => {
		await expect(getAssetMetrics('', ['AdrActCnt'])).rejects.toThrow(/asset/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('getAssetFundamentals', () => {
	it('coalesces the latest non-null value per metric past the incomplete current day', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const [btc] = await getAssetFundamentals(['btc']);
		expect(btc.asset).toBe('btc');
		// On-chain metrics come from 08-04 (the 08-05 row is null), while the
		// reference rate is current through 08-05.
		expect(btc.activeAddresses).toBe(684692);
		expect(btc.txCount).toBe(619401);
		expect(btc.marketCapUsd).toBeCloseTo(1287448909177.39, 0);
		expect(btc.priceUsd).toBeCloseTo(64161.470880187, 6);
		expect(btc.asOf).toBe('2026-08-05T00:00:00.000000000Z');
	});

	it('derives feesUsd from the newest day carrying BOTH fee and price', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const [btc] = await getAssetFundamentals(['btc']);
		expect(btc.feesNative).toBeCloseTo(3.26374575, 8);
		expect(btc.feesUsd).toBeCloseTo(3.26374575 * 64161.470880187, 4);
	});

	it('maps a market-metrics-only asset (SOL) to nulls plus estimated cap and reference rate', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const [sol] = await getAssetFundamentals(['sol']);
		expect(sol.activeAddresses).toBeNull();
		expect(sol.txCount).toBeNull();
		expect(sol.feesUsd).toBeNull();
		expect(sol.marketCapUsd).toBeCloseTo(42908375875.997, 2);
		expect(sol.priceUsd).toBeCloseTo(73.8281576996287, 8);
		expect(sol.volumeReportedUsd).toBeCloseTo(437308247.245655, 4);
	});

	it('drops a failing asset but keeps the others', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const result = await getAssetFundamentals(['btc', 'eth']); // eth routes to 403 here
		expect(result.map((r) => r.asset)).toEqual(['btc']);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('rejects when every asset failed', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(403, { error: { type: 'forbidden', message: 'nope' } }),
		);
		await expect(getAssetFundamentals(['btc', 'eth'])).rejects.toThrow(/nope/);
	});

	it('requests the full community fundamentals metric roster', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		await getAssetFundamentals(['btc']);
		const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
		for (const metric of FUNDAMENTALS_METRICS) {
			expect(url).toContain(metric);
		}
	});
});

describe('market-data getFundamentals wiring', () => {
	it('passes through Coin Metrics fundamentals on success', async () => {
		fetchMock.mockImplementation((url) => Promise.resolve(routeByAsset(url)));
		const result = await getFundamentals(['btc', 'sol']);
		expect(result.map((r) => r.asset)).toEqual(['btc', 'sol']);
	});

	it('fails soft to an empty array when Coin Metrics is down', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValue(
			jsonResponse(403, { error: { type: 'forbidden', message: 'down' } }),
		);
		await expect(getFundamentals(['btc'])).resolves.toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('fundamentals unavailable'));
		warn.mockRestore();
	});
});
