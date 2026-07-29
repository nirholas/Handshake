// /api/coin/detail and /api/coin/tickers: a rate-limited primary must not take
// the /coin/:id page down.
//
// Both routes were single-source CoinGecko. Its keyless tier limits per egress
// IP and Cloud Run's is shared, so on 2026-07-28 the profile, the markets table
// and the chart all 502'd together for hours. These tests pin the recovery
// contract: a non-404 upstream failure falls through to CoinPaprika and answers
// 200 with a `source` naming who answered, while a 404 (a real answer about a
// real coin id) never falls back and the contract lookup — which CoinPaprika
// cannot serve, being addressed by coin id rather than by Solana mint — stays a
// clean error.

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
	htmlToText: (s) => String(s || '').replace(/<[^>]+>/g, ''),
}));

const fetchFallbackCoinDetail = vi.fn();
const fetchFallbackTickers = vi.fn();
vi.mock('../../api/_lib/coin-fallbacks.js', () => ({
	fetchFallbackCoinDetail: (...args) => fetchFallbackCoinDetail(...args),
	fetchFallbackTickers: (...args) => fetchFallbackTickers(...args),
}));

const detail = (await import('../../api/coin/detail.js')).default;
const tickers = (await import('../../api/coin/tickers.js')).default;

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(handler, path, query) {
	const res = makeRes();
	await handler({ url: `${path}?${query}`, method: 'GET', headers: {} }, res);
	return { res, body: JSON.parse(res._body) };
}

const throttled = () => {
	const err = new Error('CoinGecko 429');
	err.status = 429;
	return err;
};
const notFound = () => {
	const err = new Error('CoinGecko 404');
	err.status = 404;
	return err;
};

// Minimal upstream profile — only the fields the shaper reads for these cases.
const GECKO_COIN = {
	id: 'solana',
	symbol: 'sol',
	name: 'Solana',
	market_data: { current_price: { usd: 73.28 }, market_cap: { usd: 42_465_636_552 } },
};
const FALLBACK_COIN = { id: 'solana', symbol: 'SOL', name: 'Solana', market: { price: 73.28 } };

describe('/api/coin/detail failover', () => {
	beforeEach(() => {
		geckoFetch.mockReset();
		fetchFallbackCoinDetail.mockReset();
	});

	it('serves the primary and names it on the happy path', async () => {
		geckoFetch.mockResolvedValue(GECKO_COIN);
		const { res, body } = await call(detail, '/api/coin/detail', 'id=solana');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('coingecko');
		expect(body.coin.name).toBe('Solana');
		expect(fetchFallbackCoinDetail).not.toHaveBeenCalled();
	});

	it('answers 200 from the backup when the primary is throttled', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackCoinDetail.mockResolvedValue(FALLBACK_COIN);
		const { res, body } = await call(detail, '/api/coin/detail', 'id=solana');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('coinpaprika');
		expect(body.coin.market.price).toBe(73.28);
	});

	it('keeps the backup answer CDN-cacheable', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackCoinDetail.mockResolvedValue(FALLBACK_COIN);
		const { res } = await call(detail, '/api/coin/detail', 'id=solana');
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=\d+/);
	});

	it('never falls back on a 404 — an unknown id is an answer, not an outage', async () => {
		geckoFetch.mockRejectedValue(notFound());
		const { res, body } = await call(detail, '/api/coin/detail', 'id=no-such-coin');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(fetchFallbackCoinDetail).not.toHaveBeenCalled();
	});

	it('does not attempt a coin-id backup for a Solana mint lookup', async () => {
		geckoFetch.mockRejectedValue(throttled());
		const { res } = await call(
			detail,
			'/api/coin/detail',
			'contract=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		);
		expect(res.statusCode).toBe(502);
		expect(fetchFallbackCoinDetail).not.toHaveBeenCalled();
	});

	it('502s when the backup cannot answer either', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackCoinDetail.mockResolvedValue(null);
		const { res, body } = await call(detail, '/api/coin/detail', 'id=solana');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('/api/coin/tickers failover', () => {
	beforeEach(() => {
		geckoFetch.mockReset();
		fetchFallbackTickers.mockReset();
	});

	const ROW = { exchange: { id: 'binance', name: 'Binance', logo: null }, pair: 'SOL/USDT', price_usd: 73.3 };

	it('serves the primary and names it on the happy path', async () => {
		geckoFetch.mockResolvedValue({ tickers: [{ market: { identifier: 'binance', name: 'Binance' }, base: 'SOL', target: 'USDT' }] });
		const { res, body } = await call(tickers, '/api/coin/tickers', 'id=solana');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('coingecko');
		expect(body.count).toBe(1);
		expect(fetchFallbackTickers).not.toHaveBeenCalled();
	});

	it('answers 200 from the backup when the primary is throttled', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackTickers.mockResolvedValue([ROW]);
		const { res, body } = await call(tickers, '/api/coin/tickers', 'id=solana');
		expect(res.statusCode).toBe(200);
		expect(body.source).toBe('coinpaprika');
		expect(body.count).toBe(1);
		expect(body.tickers[0].exchange.name).toBe('Binance');
	});

	it('passes the requested page through to the backup', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackTickers.mockResolvedValue([]);
		await call(tickers, '/api/coin/tickers', 'id=solana&page=3');
		expect(fetchFallbackTickers).toHaveBeenCalledWith('solana', { page: 3 });
	});

	it('never falls back on a 404', async () => {
		geckoFetch.mockRejectedValue(notFound());
		const { res, body } = await call(tickers, '/api/coin/tickers', 'id=no-such-coin');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(fetchFallbackTickers).not.toHaveBeenCalled();
	});

	it('502s when the backup cannot answer either', async () => {
		geckoFetch.mockRejectedValue(throttled());
		fetchFallbackTickers.mockResolvedValue(null);
		const { res, body } = await call(tickers, '/api/coin/tickers', 'id=solana');
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
