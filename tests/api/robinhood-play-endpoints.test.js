/**
 * GET /api/robinhood/coin-trades and GET /api/robinhood/play-worlds: the two
 * bridges between the Robinhood Chain firehose worker and the /play surfaces
 * (the in-world trading terminal's 5s trade poll, and the /worlds lobby tab).
 *
 * Pins the boundary behaviour that a degraded firehose must not break:
 *   1. Success path: real event shapes map to the card/chart contract.
 *   2. An event missing its `data` payload is dropped, not 500'd. Both handlers
 *      used to throw a TypeError out of their filter/map, which the terminal
 *      reads as a dead feed every 5s and the lobby swallows into an empty tab.
 *   3. A non-numeric timestamp nulls out instead of throwing a RangeError from
 *      `toISOString()`; the client already treats a falsy timestamp as "now".
 *   4. A launch with no usable contract address is dropped, because its card
 *      would seed a world from `undefined`.
 *   5. Malformed input gets a 400 JSON error, and an unreachable worker gets an
 *      honest empty `configured: false` payload rather than fabricated data.
 *
 * fetch + the rate limiter are stubbed; the handlers themselves run unmodified.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			marketFeedIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.11',
	};
});

// Synthetic addresses with hex letters in them, so the case-insensitivity test
// below is actually exercising something.
const COIN = '0xabcdef0123456789abcdef0123456789abcdef01';
const OTHER_COIN = '0xfedcba9876543210fedcba9876543210fedcba98';

function makeReq(url) {
	return { method: 'GET', url, headers: {}, on() {} };
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(n, v) {
			this.headers[String(n).toLowerCase()] = v;
		},
		getHeader(n) {
			return this.headers[String(n).toLowerCase()];
		},
		end(b) {
			this.body = b ? JSON.parse(b) : null;
		},
	};
}

/** Serve `events` from the worker's /recent snapshot, filtered by ?kind= like the real one. */
function feedReturning(events) {
	global.fetch = vi.fn(async (url) => {
		const kind = new URL(String(url), 'http://x').searchParams.get('kind') || 'all';
		const matching = kind === 'all' ? events : events.filter((ev) => ev?.kind === kind);
		return new Response(JSON.stringify({ events: matching }), { status: 200 });
	});
}

async function loadHandler(path) {
	vi.resetModules();
	return (await import(path)).default;
}

let savedFetch;
beforeEach(() => {
	savedFetch = global.fetch;
});
afterEach(() => {
	global.fetch = savedFetch;
});

describe('GET /api/robinhood/coin-trades', () => {
	it('maps the firehose trade events for one coin onto the chart contract', async () => {
		feedReturning([
			{
				kind: 'trade',
				data: {
					mint: COIN, tx: '0xaaa', timestamp: 1786860580, is_buy: true,
					price_usd: 1.5, sol_amount: 2, usd_amount: 3, user: '0xcafe',
				},
			},
			{ kind: 'trade', data: { mint: OTHER_COIN, tx: '0xbbb', timestamp: 1786860581, is_buy: false } },
			{ kind: 'launch', data: { mint: COIN } },
		]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.configured).toBe(true);
		expect(res.body.trades).toEqual([{
			tx: '0xaaa',
			timestamp: '2026-08-16T06:09:40.000Z',
			price_usd: 1.5,
			is_buy: true,
			sol_amount: 2,
			usd_amount: 3,
			user: '0xcafe',
		}]);
	});

	it('matches the coin case-insensitively, so a checksummed address still finds its tape', async () => {
		const checksummed = `0x${COIN.slice(2).toUpperCase()}`;
		feedReturning([{ kind: 'trade', data: { mint: checksummed, tx: '0xaaa', timestamp: 1786860580, is_buy: true } }]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.body.trades).toHaveLength(1);
	});

	it('drops an event with no data payload instead of 500ing the whole poll', async () => {
		feedReturning([
			{ kind: 'trade' },
			{ kind: 'trade', data: null },
			{ kind: 'trade', data: { mint: COIN, tx: '0xok', timestamp: 1786860580, is_buy: true } },
		]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.trades.map((t) => t.tx)).toEqual(['0xok']);
	});

	it('nulls an unparseable timestamp rather than throwing out of toISOString()', async () => {
		feedReturning([{ kind: 'trade', data: { mint: COIN, tx: '0xaaa', timestamp: 'not-a-number', is_buy: true } }]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.trades[0].timestamp).toBeNull();
	});

	it('keeps a missing price null instead of printing a real $0 trade', async () => {
		feedReturning([{ kind: 'trade', data: { mint: COIN, tx: '0xaaa', timestamp: 1786860580, is_buy: true, price_usd: null, usd_amount: null } }]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.body.trades[0].price_usd).toBeNull();
		expect(res.body.trades[0].usd_amount).toBeNull();
		expect(res.body.trades[0].sol_amount).toBe(0);
	});

	it('rejects a mint that is not an EVM address with a 400', async () => {
		feedReturning([]);
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		for (const url of ['/api/robinhood/coin-trades', '/api/robinhood/coin-trades?mint=notanaddress']) {
			const res = makeRes();
			await handler(makeReq(url), res);
			expect(res.statusCode).toBe(400);
			expect(res.body.error).toBe('invalid_mint');
		}
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('reports an unreachable worker as configured:false, never as fabricated trades', async () => {
		global.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		});
		const handler = await loadHandler('../../api/robinhood/coin-trades.js');
		const res = makeRes();
		await handler(makeReq(`/api/robinhood/coin-trades?mint=${COIN}`), res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ trades: [], configured: false });
	});
});

describe('GET /api/robinhood/play-worlds', () => {
	it('maps launch events onto the lobby card contract', async () => {
		feedReturning([{
			kind: 'launch',
			data: { mint: COIN, symbol: 'AAA', launchpad: 'test-pad', explorer_url: 'https://example.com/tx/1' },
		}]);
		const handler = await loadHandler('../../api/robinhood/play-worlds.js');
		const res = makeRes();
		await handler(makeReq('/api/robinhood/play-worlds'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data.worlds).toEqual([{
			token: COIN,
			symbol: 'AAA',
			image: null,
			members: 0,
			posts: 0,
			chain: 'robinhood-chain',
			launchpad: 'test-pad',
			explorer_url: 'https://example.com/tx/1',
		}]);
	});

	it('drops a payload-less event and an addressless launch instead of 500ing the lobby tab', async () => {
		feedReturning([
			{ kind: 'launch' },
			{ kind: 'launch', data: null },
			{ kind: 'launch', data: {} },
			{ kind: 'launch', data: { mint: 'not-an-address', symbol: 'BAD' } },
			{ kind: 'launch', data: { mint: COIN, symbol: 'GOOD' } },
		]);
		const handler = await loadHandler('../../api/robinhood/play-worlds.js');
		const res = makeRes();
		await handler(makeReq('/api/robinhood/play-worlds'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data.worlds.map((w) => w.symbol)).toEqual(['GOOD']);
	});

	it('honours the limit even when upstream ignores it', async () => {
		feedReturning(Array.from({ length: 12 }, (_, i) => ({
			kind: 'launch',
			data: { mint: `0x${String(i).padStart(40, '0')}`, symbol: `S${i}` },
		})));
		const handler = await loadHandler('../../api/robinhood/play-worlds.js');
		const res = makeRes();
		await handler(makeReq('/api/robinhood/play-worlds?limit=3'), res);

		expect(res.body.data.worlds).toHaveLength(3);
	});

	it('reports an unreachable worker as configured:false with an empty list', async () => {
		global.fetch = vi.fn(async () => new Response('nope', { status: 502 }));
		const handler = await loadHandler('../../api/robinhood/play-worlds.js');
		const res = makeRes();
		await handler(makeReq('/api/robinhood/play-worlds'), res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ data: { worlds: [] }, configured: false });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});
