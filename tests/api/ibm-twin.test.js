// Tests for /api/ibm/twin — the IBM Granite Digital Twin.
//
// Covers both handlers without any real network calls:
//   GET  — trending list, full Granite pipeline (projection+fidelity+persona),
//          watsonx-unconfigured degradation, insufficient history, forecast failure,
//          token-mint resolution, back-test skip when history is too short.
//   POST — what-if scenario with watsonx, unconfigured degradation, invalid input.
//   Rate limiting and method guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		watsonxEmbedGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
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
	guardianConfig: vi.fn(() => ({ configured: true, wx: {}, model: 'ibm/granite-guardian-3-8b' })),
	assessRisk: vi.fn(),
}));
vi.mock('../../api/_lib/market/ohlcv.js', () => ({
	fetchOhlcv: vi.fn(),
	topPoolForToken: vi.fn(),
	trendingPools: vi.fn(),
}));

import { limits } from '../../api/_lib/rate-limit.js';
import { watsonxConfig, watsonxChatComplete } from '../../api/_lib/watsonx.js';
import { watsonxForecast, forecastModelFor } from '../../api/_lib/watsonx-forecast.js';
import { assessRisk } from '../../api/_lib/granite-guardian.js';
import { fetchOhlcv, topPoolForToken, trendingPools } from '../../api/_lib/market/ohlcv.js';

const { default: handler } = await import('../../api/ibm/twin.js');

// ── Constants ─────────────────────────────────────────────────────────────────
const POOL = '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z';
const TOKEN = 'So11111111111111111111111111111111111111112';
const HORIZON = 96;

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: null,
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b;
			this.writableEnded = true;
		},
	};
}

async function callGet(url) {
	const res = makeRes();
	await handler({ method: 'GET', url, headers: {} }, res);
	return { res, body: tryJson(res._body) };
}

// `rawBody` sends the exact bytes instead of JSON.stringify(body), so a test can
// post literal `null` or a bare string: valid JSON that is not an object.
async function callPost(body, rawBody) {
	const res = makeRes();
	const buf = Buffer.from(rawBody ?? JSON.stringify(body), 'utf8');
	await handler(
		{
			method: 'POST',
			url: '/api/ibm/twin',
			headers: { 'content-type': 'application/json', 'content-length': String(buf.length) },
			on(ev, cb) {
				if (ev === 'data') cb(buf);
				if (ev === 'end') cb();
			},
		},
		res,
	);
	return { res, body: tryJson(res._body) };
}

function tryJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// Generate n realistic OHLCV candles starting at price `base`, trending up.
function mkCandles(n, base = 100) {
	const t0 = 1_700_000_000;
	return Array.from({ length: n }, (_, i) => {
		const c = base + i * 0.05;
		return { t: t0 + i * 3600, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000 + i };
	});
}

// Generate a Granite TTM forecast result.
function mkForecast(n, start = 101, model = 'ibm/granite-ttm-512-96-r2') {
	const ts = [],
		vs = [];
	const t0 = 1_700_000_000 + 600 * 3600;
	for (let i = 0; i < n; i++) {
		ts.push(new Date((t0 + i * 3600) * 1000).toISOString());
		vs.push(start + (i + 1) * 0.1);
	}
	return { timestamps: ts, values: vs, model, inputWindow: 512 };
}

// ── Default mock state ────────────────────────────────────────────────────────
function setupWatsonxReady() {
	watsonxConfig.mockReturnValue({
		configured: true,
		projectId: 'p',
		url: 'u',
		apiVersion: 'v',
		tsApiVersion: 'tv',
	});
	watsonxForecast.mockResolvedValue(mkForecast(HORIZON, 101));
	watsonxChatComplete.mockResolvedValue({
		text: `I am the digital twin of three. Granite projects me climbing ${HORIZON} hours ahead.`,
		model: 'ibm/granite-3-8b-instruct',
	});
	assessRisk.mockResolvedValue({
		flagged: false,
		risk: 'harm',
		label: 'No',
		probability: 0.04,
		confidence: 'high',
		model: 'ibm/granite-guardian-3-8b',
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	limits.publicIp.mockResolvedValue({ success: true });
	watsonxConfig.mockReturnValue({ configured: false });
	trendingPools.mockResolvedValue([
		{ pool: POOL, name: 'three / SOL', baseMint: 'm', priceUsd: 0.002, change24h: 3.1 },
	]);
	fetchOhlcv.mockResolvedValue({
		candles: mkCandles(600),
		base: { name: 'three', symbol: 'three', address: 'm' },
		quote: { symbol: 'SOL' },
		freq: '1h',
		timeframe: 'hour',
		aggregate: 1,
	});
	topPoolForToken.mockResolvedValue(POOL);
	forecastModelFor.mockReturnValue('ibm/granite-ttm-512-96-r2');
});

// ── GET: trending list ────────────────────────────────────────────────────────
describe('GET /api/ibm/twin?list=trending', () => {
	it('returns the trending pool list', async () => {
		const { res, body } = await callGet('/api/ibm/twin?list=trending');
		expect(res.statusCode).toBe(200);
		expect(body.pools).toHaveLength(1);
		expect(body.pools[0].name).toBe('three / SOL');
	});

	it('sets a short cache-control header', async () => {
		const { res } = await callGet('/api/ibm/twin?list=trending');
		expect(res._headers['cache-control']).toMatch(/max-age/);
	});
});

// ── GET: watsonx unconfigured ─────────────────────────────────────────────────
describe('GET /api/ibm/twin — watsonx unconfigured', () => {
	it('returns history + vitals but no IBM fields', async () => {
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.history).toHaveLength(600);
		expect(body.vitals).toBeTruthy();
		expect(body.ibm.configured).toBe(false);
		expect(body.projection).toBeNull();
		expect(body.persona).toBeNull();
		expect(watsonxForecast).not.toHaveBeenCalled();
	});

	it('includes the unconfigured reason in the ibm field', async () => {
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.ibm.reason).toMatch(/WATSONX_API_KEY/);
	});
});

// ── GET: vitals ───────────────────────────────────────────────────────────────
describe('GET /api/ibm/twin — vitals shape', () => {
	it('returns well-formed vitals from OHLCV history', async () => {
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		const v = body.vitals;
		expect(v.currentPrice).toBeGreaterThan(0);
		expect(v.heartbeatBpm).toBeGreaterThanOrEqual(28);
		expect(v.heartbeatBpm).toBeLessThanOrEqual(184);
		expect(v.state).toBeTruthy();
		expect(v.state.key).toMatch(/calm|ascending|declining|euphoric|stressed|dormant/);
		expect(v.signals.trend).toBeGreaterThanOrEqual(-1);
		expect(v.signals.trend).toBeLessThanOrEqual(1);
		expect(v.signals.volatility).toBeGreaterThanOrEqual(0);
		expect(v.signals.volatility).toBeLessThanOrEqual(1);
	});
});

// ── GET: full Granite pipeline ─────────────────────────────────────────────────
describe('GET /api/ibm/twin — full Granite pipeline', () => {
	beforeEach(() => setupWatsonxReady());

	it('runs the full pipeline: projection, fidelity, persona, governance', async () => {
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.ibm.configured).toBe(true);
		expect(body.ibm.forecastModel).toBe('ibm/granite-ttm-512-96-r2');
		expect(body.projection).toBeTruthy();
		expect(body.projection.points).toHaveLength(HORIZON);
		expect(body.projection.stats.direction).toBeTruthy();
		expect(body.persona).toBeTruthy();
		expect(body.persona.text).toMatch(/digital twin|three/i);
	});

	it('computes forecast stats (changePct, direction, low/high)', async () => {
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		const s = body.projection.stats;
		expect(Number.isFinite(s.changePct)).toBe(true);
		expect(['up', 'down', 'flat']).toContain(s.direction);
		expect(s.low).toBeLessThanOrEqual(s.high);
		expect(s.horizonHours).toBeGreaterThan(0);
	});

	it('includes a fidelity back-test when history is long enough', async () => {
		// Need 512 context + 96 horizon = 608 candles minimum for back-test
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(640),
			base: { name: 'three', symbol: 'three', address: 'm' },
			quote: { symbol: 'SOL' },
			freq: '1h',
			timeframe: 'hour',
			aggregate: 1,
		});
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.fidelity).toBeTruthy();
		expect(body.fidelity.horizonHours).toBe(HORIZON);
		expect(Number.isFinite(body.fidelity.mapePct)).toBe(true);
		expect(typeof body.fidelity.directionalHit).toBe('boolean');
	});

	// A back-test forecast that answers with no points has nothing to score. Scoring
	// it anyway indexed realized[-1] and threw, and the throw landed in the outer
	// catch that reports a forecast failure: the projection, the ibm block, and the
	// persona were all lost to a back-test that was only ever supplementary.
	it('keeps the projection and persona when the back-test returns no points', async () => {
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(640),
			base: { name: 'three', symbol: 'three', address: 'm' },
			quote: { symbol: 'SOL' },
			freq: '1h',
			timeframe: 'hour',
			aggregate: 1,
		});
		// First call is the live projection, second is the back-test.
		watsonxForecast.mockReset();
		watsonxForecast
			.mockResolvedValueOnce(mkForecast(HORIZON, 101))
			.mockResolvedValueOnce({ timestamps: [], values: [], model: 'ttm', inputWindow: 512 });

		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.fidelity).toBeNull();
		expect(body.projection.points).toHaveLength(HORIZON);
		expect(body.ibm.configured).toBe(true);
		expect(body.ibm.error).toBeUndefined();
		expect(body.persona.text).toBeTruthy();
	});

	it('includes Guardian governance on the persona', async () => {
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.governance).toBeTruthy();
		expect(body.governance.passed).toBe(true);
		expect(body.governance.risk).toBe('harm');
	});

	it('governance shows flagged=true when Guardian flags the persona', async () => {
		assessRisk.mockResolvedValue({
			flagged: true,
			risk: 'harm',
			label: 'Yes',
			probability: 0.88,
		});
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.governance.passed).toBe(false);
	});
});

// ── GET: token mint resolution ────────────────────────────────────────────────
describe('GET /api/ibm/twin — token mint resolution', () => {
	it('resolves a token mint to its top pool', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		await callGet(`/api/ibm/twin?token=${TOKEN}`);
		expect(topPoolForToken).toHaveBeenCalledWith(TOKEN, 'solana');
		expect(fetchOhlcv).toHaveBeenCalled();
	});

	it('returns 400 for an invalid (non-base58) token mint', async () => {
		const { res, body } = await callGet('/api/ibm/twin?token=not-a-valid-mint!!');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_token');
	});

	it('returns 400 when neither pool nor token is provided', async () => {
		const { res, body } = await callGet('/api/ibm/twin');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
	});
});

// ── GET: insufficient history ─────────────────────────────────────────────────
describe('GET /api/ibm/twin — insufficient history', () => {
	it('skips Granite when <512 candles are available', async () => {
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(200),
			base: { symbol: 'tiny' },
			quote: { symbol: 'SOL' },
			freq: '1h',
			timeframe: 'hour',
			aggregate: 1,
		});
		watsonxConfig.mockReturnValue({
			configured: true,
			projectId: 'p',
			url: 'u',
			apiVersion: 'v',
		});
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.projection).toBeNull();
		expect(body.ibm.error).toMatch(/512/);
		expect(watsonxForecast).not.toHaveBeenCalled();
	});

	it('skips back-test but still runs projection when history is exactly 512 candles', async () => {
		setupWatsonxReady();
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(512),
			base: { name: 'tiny', symbol: 'T' },
			quote: { symbol: 'SOL' },
			freq: '1h',
			timeframe: 'hour',
			aggregate: 1,
		});
		// Back-test needs 512 + 96 = 608. With exactly 512 it should skip fidelity.
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.projection).toBeTruthy();
		expect(body.fidelity).toBeNull();
	});
});

// ── GET: forecast failure resilience ─────────────────────────────────────────
describe('GET /api/ibm/twin — forecast failure', () => {
	it('still returns history + vitals when watsonxForecast throws', async () => {
		setupWatsonxReady();
		watsonxForecast.mockRejectedValue(new Error('model gating error'));
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(200);
		expect(body.history).toHaveLength(600);
		expect(body.projection).toBeNull();
		expect(body.ibm.error).toMatch(/model gating/);
	});

	it('still returns a persona even when Guardian governance fails', async () => {
		setupWatsonxReady();
		assessRisk.mockRejectedValue(new Error('guardian timeout'));
		const { body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(body.persona.text).toBeTruthy();
		// governance should be null or have an error field — not crash the response
		expect(body.governance === null || body.governance?.error).toBeTruthy();
	});
});

// ── POST: scenario simulation ─────────────────────────────────────────────────
describe('POST /api/ibm/twin — scenario simulation', () => {
	beforeEach(() => setupWatsonxReady());

	it('runs baseline and simulated forecasts in parallel', async () => {
		const { res, body } = await callPost({
			pool: POOL,
			scenario: { priceShockPct: 20, volatilityScale: 1.5, momentumFlip: false },
		});
		expect(res.statusCode).toBe(200);
		expect(body.ibm.configured).toBe(true);
		expect(body.baseline).toBeTruthy();
		expect(body.simulated).toBeTruthy();
		expect(body.divergence).toBeTruthy();
		expect(Number.isFinite(body.divergence.changePctDelta)).toBe(true);
		// two watsonxForecast calls: baseline + simulated
		expect(watsonxForecast).toHaveBeenCalledTimes(2);
	});

	it('includes a scenario label describing the perturbation', async () => {
		const { body } = await callPost({
			pool: POOL,
			scenario: { priceShockPct: -30, volatilityScale: 2, momentumFlip: true },
		});
		expect(body.scenario.label).toMatch(/-30%|demand shock/);
	});

	// `null` and `"hi"` parse as valid JSON, so readJson hands them straight back on
	// the raw-stream path. Reading params off a non-object used to throw a TypeError
	// that wrap() sanitized into a 500 internal_error; malformed input belongs in
	// the documented 400 contract.
	it.each([
		['null', 'null'],
		['a bare string', '"hi"'],
		['a number', '42'],
	])('rejects a JSON body that is %s with 400 bad_request', async (_label, rawBody) => {
		const { res, body } = await callPost(undefined, rawBody);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(body.error_description).toMatch(/provide \?pool=/);
	});

	it('uses "baseline (no perturbation)" label when scenario is empty', async () => {
		const { body } = await callPost({ pool: POOL, scenario: {} });
		expect(body.scenario.label).toMatch(/baseline/i);
	});

	it('generates a persona narrating the scenario shift', async () => {
		const { body } = await callPost({
			pool: POOL,
			scenario: { priceShockPct: 50 },
		});
		expect(body.persona).toBeTruthy();
		expect(body.persona.text).toBeTruthy();
	});

	it('clamps extreme scenario values to safe ranges', async () => {
		const { res, body } = await callPost({
			pool: POOL,
			scenario: { priceShockPct: 99999, volatilityScale: 999 },
		});
		// Should succeed — clamping prevents bad inputs from propagating
		expect(res.statusCode).toBe(200);
		expect(body.scenario.priceShockPct).toBeLessThanOrEqual(300);
		expect(body.scenario.volatilityScale).toBeLessThanOrEqual(5);
	});

	it('degrades gracefully when watsonx is not configured', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		const { res, body } = await callPost({ pool: POOL, scenario: {} });
		expect(res.statusCode).toBe(200);
		expect(body.ibm.configured).toBe(false);
		expect(body.baseline).toBeNull();
		expect(watsonxForecast).not.toHaveBeenCalled();
	});

	it('degrades when history is insufficient for the forecaster', async () => {
		fetchOhlcv.mockResolvedValue({
			candles: mkCandles(200),
			base: { symbol: 'T' },
			quote: { symbol: 'SOL' },
			freq: '1h',
			timeframe: 'hour',
			aggregate: 1,
		});
		const { body } = await callPost({ pool: POOL, scenario: {} });
		expect(body.ibm.error).toMatch(/512/);
		expect(watsonxForecast).not.toHaveBeenCalled();
	});
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
describe('rate limiting', () => {
	it('GET returns 429 when rate limit exceeded', async () => {
		limits.publicIp.mockResolvedValue({ success: false });
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('POST returns 429 when rate limit exceeded', async () => {
		limits.publicIp.mockResolvedValue({ success: false });
		const { res, body } = await callPost({ pool: POOL, scenario: {} });
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── Market data upstream failures ─────────────────────────────────────────────
// GeckoTerminal throttles and outages are a third party's problem. They must map
// to a real client contract rather than bubbling into wrap()'s unhandled-5xx
// path, which logs, captures to Sentry, and pages ops once per request.
describe('market data upstream failures', () => {
	const upstreamFault = (status) =>
		Object.assign(new Error(`GeckoTerminal ${status}`), { status });

	it('maps a missing pool to 404 pool_not_found', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(404));
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('pool_not_found');
		expect(body.error_description).not.toMatch(/GeckoTerminal/);
	});

	it('maps a throttle to a retryable 503', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(429));
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_rate_limited');
		expect(body.retryable).toBe(true);
	});

	it('maps an upstream outage to 502 upstream_error', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(502));
		const { res, body } = await callGet(`/api/ibm/twin?pool=${POOL}`);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('maps a trending-list failure the same way', async () => {
		trendingPools.mockRejectedValueOnce(upstreamFault(429));
		const { res, body } = await callGet('/api/ibm/twin?list=trending');
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_rate_limited');
	});

	it('maps a POST what-if upstream failure the same way', async () => {
		fetchOhlcv.mockRejectedValueOnce(upstreamFault(502));
		const { res, body } = await callPost({ pool: POOL, scenario: {} });
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('keeps the handler own validation errors intact', async () => {
		const { res, body } = await callGet('/api/ibm/twin?token=not-base58');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_token');
	});
});

// ── Method guard ──────────────────────────────────────────────────────────────
describe('method guard', () => {
	it('returns 405 for unsupported methods', async () => {
		const res = makeRes();
		await handler({ method: 'DELETE', url: '/api/ibm/twin', headers: {} }, res);
		expect(res.statusCode).toBe(405);
	});
});
