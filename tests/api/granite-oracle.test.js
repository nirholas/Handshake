// /api/ibm/oracle — the Granite Oracle orchestration: real candles → Granite
// TimeSeries forecast → Granite narration → Granite Guardian governance. All
// external calls are mocked so the test exercises the endpoint's control flow
// (degrade-without-watsonx, forecast-failure resilience, validation) offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		watsonxEmbedGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/market/ohlcv.js', () => ({
	fetchOhlcv: vi.fn(),
	topPoolForToken: vi.fn(),
	trendingPools: vi.fn(),
}));
vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(),
	watsonxChatComplete: vi.fn(),
}));
vi.mock('../../api/_lib/watsonx-forecast.js', () => ({
	watsonxForecast: vi.fn(),
	forecastModelFor: vi.fn(() => 'ibm/granite-ttm-512-96-r2'),
}));
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: vi.fn(() => ({ configured: true })),
	assessRisk: vi.fn(),
}));

import { fetchOhlcv, topPoolForToken, trendingPools } from '../../api/_lib/market/ohlcv.js';
import { watsonxConfig, watsonxChatComplete } from '../../api/_lib/watsonx.js';
import { watsonxForecast } from '../../api/_lib/watsonx-forecast.js';
import { assessRisk } from '../../api/_lib/granite-guardian.js';

const { default: handler } = await import('../../api/ibm/oracle.js');

const POOL = '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z'; // a real base58 pool addr

function mkCandles(n, base = 100) {
	const out = [];
	const t0 = 1_700_000_000;
	for (let i = 0; i < n; i++) {
		const c = base + i * 0.1;
		out.push({ t: t0 + i * 3600, o: c, h: c + 1, l: c - 1, c, v: 1000 });
	}
	return out;
}
function mkForecast(n, start) {
	const ts = [],
		vs = [];
	const t0 = 1_700_000_000 + 520 * 3600;
	for (let i = 0; i < n; i++) {
		ts.push(new Date((t0 + i * 3600) * 1000).toISOString());
		vs.push(start + (i + 1) * 0.5); // trending up
	}
	return { timestamps: ts, values: vs, model: 'ibm/granite-ttm-512-96-r2', inputWindow: 512 };
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(b) {
			this._body = b;
			this.writableEnded = true;
		},
	};
}
async function call(url) {
	const res = makeRes();
	await handler({ method: 'GET', url, headers: {} }, res);
	let body = null;
	try {
		body = JSON.parse(res._body);
	} catch {
		/* ignore */
	}
	return { res, body };
}

beforeEach(() => {
	vi.clearAllMocks();
	trendingPools.mockResolvedValue([
		{ pool: POOL, name: 'three / SOL', baseMint: 'm', priceUsd: 0.002 },
	]);
	fetchOhlcv.mockResolvedValue({
		candles: mkCandles(520),
		base: { name: 'three', symbol: 'three', address: 'm' },
		quote: { symbol: 'SOL' },
		freq: '1h',
		timeframe: 'hour',
		aggregate: 1,
	});
	topPoolForToken.mockResolvedValue(POOL);
	watsonxConfig.mockReturnValue({
		configured: true,
		projectId: 'p',
		url: 'u',
		apiVersion: 'v',
		tsApiVersion: 't',
	});
	watsonxForecast.mockResolvedValue(mkForecast(96, 151.9));
	watsonxChatComplete.mockResolvedValue({
		text: 'Granite sees three drifting higher.',
		model: 'ibm/granite-3-8b-instruct',
	});
	assessRisk.mockResolvedValue({
		flagged: false,
		risk: 'harm',
		label: 'Safe',
		probability: 0.02,
		confidence: 'high',
		model: 'ibm/granite-guardian-3-8b',
	});
});

describe('/api/ibm/oracle', () => {
	it('lists trending pools', async () => {
		const { res, body } = await call('/api/ibm/oracle?list=trending');
		expect(res.statusCode).toBe(200);
		expect(body.pools[0].name).toBe('three / SOL');
	});

	it('runs the full Granite pipeline for a pool', async () => {
		const { res, body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.token.symbol).toBe('three');
		expect(body.history).toHaveLength(520);
		expect(body.forecast).toHaveLength(96);
		expect(body.ibm.configured).toBe(true);
		expect(body.ibm.forecastModel).toBe('ibm/granite-ttm-512-96-r2');
		expect(body.stats.direction).toBe('up');
		expect(body.stats.changePct).toBeGreaterThan(0);
		expect(body.narration.text).toMatch(/Granite/);
		expect(body.governance.passed).toBe(true);
		expect(body.mood.emotion).toBeTruthy();
		expect(body.mood.sentiment).toBeGreaterThan(0);
	});

	it('resolves a token mint to its top pool', async () => {
		await call('/api/ibm/oracle?token=So11111111111111111111111111111111111111112');
		expect(topPoolForToken).toHaveBeenCalledWith(
			'So11111111111111111111111111111111111111112',
			'solana',
		);
		expect(watsonxForecast).toHaveBeenCalled();
	});

	it('degrades to history-only when watsonx is not configured', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		const { res, body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.history).toHaveLength(520);
		expect(body.forecast).toBeNull();
		expect(body.ibm.configured).toBe(false);
		expect(watsonxForecast).not.toHaveBeenCalled();
	});

	it('still returns history when the forecast call fails', async () => {
		watsonxForecast.mockRejectedValue(new Error('watsonx 403: model not enabled in region'));
		const { res, body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.forecast).toBeNull();
		expect(body.ibm.error).toMatch(/not enabled/);
		expect(body.history.length).toBe(520);
	});

	it('reports insufficient history for the forecaster (<512 candles)', async () => {
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(200),
			base: { symbol: 'tiny' },
			quote: { symbol: 'SOL' },
			freq: '1h',
		});
		const { body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(body.forecast).toBeNull();
		expect(body.ibm.error).toMatch(/≥512|512/);
	});

	it('rejects a request with no pool or token', async () => {
		const { res, body } = await call('/api/ibm/oracle');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
	});
});

// The shared market-upstream contract (api/_lib/market/upstream-error.js), which
// every Granite market handler now answers with. The upstream body is never
// echoed: it carries vendor ref ids and nothing a caller can act on.
describe('market data upstream failures', () => {
	const upstreamFault = (status) =>
		Object.assign(new Error(`GeckoTerminal ${status}: {"meta":{"ref_id":"abc"}}`), { status });

	it('maps a missing pool to 404 pool_not_found', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(404));
		const { res, body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('pool_not_found');
		expect(body.error_description).not.toMatch(/ref_id/);
	});

	it('maps a throttle to a retryable 503', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(429));
		const { res, body } = await call(`/api/ibm/oracle?pool=${POOL}`);
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_rate_limited');
		expect(body.retryable).toBe(true);
	});

	it('maps an upstream outage to 502 upstream_error', async () => {
		trendingPools.mockRejectedValueOnce(upstreamFault(502));
		const { res, body } = await call('/api/ibm/oracle?list=trending');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
