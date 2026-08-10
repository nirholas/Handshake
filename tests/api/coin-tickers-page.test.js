// /api/coin/tickers: the `page` contract must be one rule, not two.
//
// The handler advertises "page must be an integer between 1 and 10" and returns
// 400 bad_page for anything outside it. But it derived the value with
// `parseInt(v, 10) || 1`, which rewrites every falsy parse to 1 BEFORE the range
// check runs. So `page=11` was rejected while `page=0`, `page=abc`, and
// `page=2.9` quietly answered 200 with a page the caller never asked for, and
// the `page < 1` half of the guard was unreachable for 0. These tests pin the
// single rule: absent means page 1, anything else is an integer in 1..10 or a
// 400. The upstream-failover contract is pinned alongside it so tightening the
// parse can't silently cost the CoinPaprika fallback.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.1',
}));

const geckoFetch = vi.fn();
vi.mock('../../api/_lib/coingecko.js', () => ({
	geckoFetch: (...a) => geckoFetch(...a),
	isPlausibleCoinId: (id) => /^[a-z0-9][a-z0-9-]*$/.test(id),
}));

const fetchFallbackTickers = vi.fn();
vi.mock('../../api/_lib/coin-fallbacks.js', () => ({
	fetchFallbackTickers: (...a) => fetchFallbackTickers(...a),
}));

const tickers = (await import('../../api/coin/tickers.js')).default;

const upstreamTicker = {
	base: 'BTC',
	target: 'USDT',
	market: { identifier: 'binance', name: 'Binance', logo: 'https://example.com/l.png' },
	converted_last: { usd: 64000 },
	converted_volume: { usd: 1_000_000 },
	trust_score: 'green',
	trade_url: 'https://example.com/trade',
};

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
	await tickers({ url: `/api/coin/tickers?${query}`, method: 'GET', headers: {} }, res);
	return { res, body: JSON.parse(res._body) };
}

describe('/api/coin/tickers page contract', () => {
	beforeEach(() => {
		geckoFetch.mockReset();
		fetchFallbackTickers.mockReset();
		geckoFetch.mockResolvedValue({ tickers: [upstreamTicker] });
	});

	it('defaults an absent page to 1 and asks upstream for it', async () => {
		const { res, body } = await call('id=bitcoin');
		expect(res.statusCode).toBe(200);
		expect(body.page).toBe(1);
		expect(body.source).toBe('coingecko');
		expect(geckoFetch.mock.calls[0][0]).toContain('page=1');
	});

	it('passes a valid in-range page straight through', async () => {
		const { res, body } = await call('id=bitcoin&page=7');
		expect(res.statusCode).toBe(200);
		expect(body.page).toBe(7);
		expect(geckoFetch.mock.calls[0][0]).toContain('page=7');
	});

	for (const [label, query] of [
		['zero', 'id=bitcoin&page=0'],
		['negative zero', 'id=bitcoin&page=-0'],
		['negative', 'id=bitcoin&page=-3'],
		['above the ceiling', 'id=bitcoin&page=11'],
		['non-numeric', 'id=bitcoin&page=abc'],
		['fractional', 'id=bitcoin&page=2.9'],
	]) {
		it(`rejects a ${label} page with 400 bad_page and never calls upstream`, async () => {
			const { res, body } = await call(query);
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('bad_page');
			expect(geckoFetch).not.toHaveBeenCalled();
		});
	}

	it('shapes the row the Markets table renders', async () => {
		const { body } = await call('id=bitcoin&page=1');
		expect(body.tickers[0]).toMatchObject({
			exchange: { id: 'binance', name: 'Binance' },
			pair: 'BTC/USDT',
			price_usd: 64000,
			trust: 'green',
			trade_url: 'https://example.com/trade',
		});
		expect(body.count).toBe(1);
	});

	it('truncates a contract-address pair symbol so the table stays legible', async () => {
		geckoFetch.mockResolvedValue({
			tickers: [{ ...upstreamTicker, base: '0xdeadbeefcafebabe1234', target: 'SOL' }],
		});
		const { body } = await call('id=bitcoin&page=1');
		expect(body.tickers[0].base).toBe('0xdead…');
	});

	it('drops a non-http trade_url rather than handing it to the client', async () => {
		geckoFetch.mockResolvedValue({
			tickers: [{ ...upstreamTicker, trade_url: 'javascript:alert(1)' }],
		});
		const { body } = await call('id=bitcoin&page=1');
		expect(body.tickers[0].trade_url).toBeNull();
	});

	it('rejects an implausible coin id before any upstream call', async () => {
		const { res, body } = await call('id=NOT%20AN%20ID&page=1');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_id');
		expect(geckoFetch).not.toHaveBeenCalled();
	});

	it('404s an unknown coin without reaching for the fallback', async () => {
		const err = new Error('not found');
		err.status = 404;
		geckoFetch.mockRejectedValue(err);
		const { res, body } = await call('id=no-such-coin-anywhere&page=1');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(fetchFallbackTickers).not.toHaveBeenCalled();
	});

	it('serves CoinPaprika for the validated page when CoinGecko is throttled', async () => {
		const err = new Error('CoinGecko 429');
		err.status = 429;
		geckoFetch.mockRejectedValue(err);
		fetchFallbackTickers.mockResolvedValue([{ pair: 'BTC/USD', price_usd: 64000 }]);
		const { res, body } = await call('id=bitcoin&page=3');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('coinpaprika');
		expect(body.page).toBe(3);
		expect(fetchFallbackTickers).toHaveBeenCalledWith('bitcoin', { page: 3 });
	});

	it('502s when both sources are down', async () => {
		geckoFetch.mockRejectedValue(new Error('gateway timeout'));
		fetchFallbackTickers.mockResolvedValue(null);
		const { res, body } = await call('id=bitcoin&page=1');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
