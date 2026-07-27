// /api/coin/ohlc: a coin with no market history is an ANSWER, not an outage.
//
// Dead or unlisted markets return an empty price series upstream. Reporting
// that as 502 made the route look like a broken dependency: it polluted the
// 5xx monitors, defeated CDN caching, and told the user to "retry shortly" for
// something no retry can fix. These tests pin the contract: empty series → 200
// with normal cache headers, a genuinely unknown coin → 404, a real upstream
// outage → 502.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.1',
}));

const geckoFetch = vi.fn();
vi.mock('../../api/_lib/coingecko.js', () => ({
	geckoFetch: (...args) => geckoFetch(...args),
	isPlausibleCoinId: (id) => /^[a-z0-9][a-z0-9-]*$/.test(id),
}));

const fetchExchangeChart = vi.fn();
vi.mock('../../api/_lib/market-fallbacks.js', () => ({
	fetchExchangeChart: (...args) => fetchExchangeChart(...args),
}));

const ohlc = (await import('../../api/coin/ohlc.js')).default;

function makeReq(query) { return { url: `/api/coin/ohlc?${query}`, method: 'GET', headers: {} }; }
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(query) {
	const res = makeRes();
	await ohlc(makeReq(query), res);
	return { res, body: JSON.parse(res._body) };
}

describe('/api/coin/ohlc empty-series contract', () => {
	beforeEach(() => {
		geckoFetch.mockReset();
		fetchExchangeChart.mockReset();
	});

	it('answers 200 with an empty series when the coin has no price history', async () => {
		geckoFetch.mockResolvedValue({ prices: [] });
		const { res, body } = await call('id=hedera-guild-game&days=30');
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual([]);
		expect(body.days).toBe(30);
	});

	it('keeps the empty answer CDN-cacheable', async () => {
		geckoFetch.mockResolvedValue({ prices: [] });
		const { res } = await call('id=hedera-guild-game&days=30');
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=\d+/);
	});

	it('still serves a real series unchanged', async () => {
		geckoFetch.mockResolvedValue({ prices: [[1_700_000_000_000, 42.5], [1_700_003_600_000, 43]] });
		const { res, body } = await call('id=bitcoin&days=30');
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual([[1_700_000_000_000, 42.5], [1_700_003_600_000, 43]]);
	});

	it('still 404s an unknown coin id', async () => {
		const err = new Error('not found');
		err.status = 404;
		geckoFetch.mockRejectedValue(err);
		const { res, body } = await call('id=no-such-coin-anywhere&days=30');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('still 502s a genuine upstream outage with no fallback', async () => {
		geckoFetch.mockRejectedValue(new Error('gateway timeout'));
		fetchExchangeChart.mockResolvedValue(null);
		const { res, body } = await call('id=bitcoin&days=30');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
