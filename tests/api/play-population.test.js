// Unit tests for GET /api/play/population, the same-origin proxy in front of the
// multiplayer server's own /population aggregate.
//
// The contract this handler exists to keep is narrow and easy to break silently:
//
//   1. It NEVER invents a number. A missing upstream, an unreachable upstream, a
//      slow upstream and an upstream that answers `ok:false` all resolve to the
//      same honest `{ ok: false, reason: 'unavailable' }` at 200, because the
//      /event landing page renders its LIVE panel off this call and a landing page
//      must neither break nor make a population up.
//   2. It forwards NOTHING but a count. Session ids, names, wallets and positions
//      exist on the other side of this boundary and must not cross it.
//   3. The `coin` filter is constrained before it is forwarded, since the value
//      lands in another service's query string.
//
// `fetch` is stubbed per test to stand in for the upstream. That is the seam the
// handler owns; the upstream's own /population route is covered separately in
// tests/multiplayer-server-boot.test.js, so nothing here restates its behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rlState = { success: true, limit: 60, remaining: 59, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const envState = { MULTIPLAYER_INTERNAL_URL: 'http://mp.internal:2567' };
vi.mock('../../api/_lib/env.js', () => ({
	env: {
		get MULTIPLAYER_INTERNAL_URL() {
			return envState.MULTIPLAYER_INTERNAL_URL;
		},
	},
}));

const handler = (await import('../../api/play/population.js')).default;

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mockRes() {
	const chunks = [];
	return {
		statusCode: 0,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		end(body) { if (body) chunks.push(body); return this; },
		get parsed() { return JSON.parse(chunks.join('')); },
	};
}

const mockReq = (url = '/api/play/population', method = 'GET') => ({
	method,
	url,
	headers: { host: 'three.ws' },
	socket: { remoteAddress: '127.0.0.1' },
});

async function get(url) {
	const res = mockRes();
	await handler(mockReq(url), res);
	return res;
}

/** Stand in for the upstream, and record the URL it was called with. */
function upstream(reply) {
	const calls = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		calls.push(String(url));
		return reply();
	});
	return calls;
}

const jsonReply = (body, ok = true, status = 200) => () =>
	({ ok, status, json: async () => body });

beforeEach(() => {
	rlState.success = true;
	envState.MULTIPLAYER_INTERNAL_URL = 'http://mp.internal:2567';
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('GET /api/play/population: the live count', () => {
	it('serves the upstream count and caches it no longer than the source does', async () => {
		upstream(jsonReply({ ok: true, players: 7, rooms: 2 }));
		const res = await get('/api/play/population');
		expect(res.statusCode).toBe(200);
		expect(res.parsed).toEqual({ ok: true, coin: null, players: 7, rooms: 2 });
		// The multiplayer server caches its own aggregate for 5s; anything longer
		// here would serve a number staler than its source.
		expect(res.headers['cache-control']).toBe('public, max-age=5, s-maxage=5');
	});

	it('forwards a well-formed coin filter and echoes it back', async () => {
		const calls = upstream(jsonReply({ ok: true, players: 3, rooms: 1 }));
		const res = await get(`/api/play/population?coin=${MINT}`);
		expect(res.parsed).toEqual({ ok: true, coin: MINT, players: 3, rooms: 1 });
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]).searchParams.get('coin')).toBe(MINT);
	});

	it('accepts an EVM coin world as well as a Solana mint', async () => {
		const evm = '0x1234567890abcdef1234567890abcdef12345678';
		const calls = upstream(jsonReply({ ok: true, players: 1, rooms: 1 }));
		const res = await get(`/api/play/population?coin=${evm}`);
		expect(res.parsed.coin).toBe(evm);
		expect(new URL(calls[0]).searchParams.get('coin')).toBe(evm);
	});

	it('drops a coin value that is not an address instead of forwarding it', async () => {
		const calls = upstream(jsonReply({ ok: true, players: 4, rooms: 1 }));
		const res = await get('/api/play/population?coin=../../etc/passwd');
		expect(res.parsed.coin).toBeNull();
		expect(new URL(calls[0]).searchParams.has('coin')).toBe(false);
	});

	it('never forwards anything but a count', async () => {
		upstream(jsonReply({
			ok: true,
			players: 2,
			rooms: 1,
			sessions: ['s1', 's2'],
			names: ['alice', 'bob'],
			wallets: [MINT],
			positions: [{ x: 1, z: 2 }],
		}));
		const res = await get('/api/play/population');
		expect(Object.keys(res.parsed).sort()).toEqual(['coin', 'ok', 'players', 'rooms']);
	});

	it('floors negative or fractional upstream counts to a sane integer', async () => {
		upstream(jsonReply({ ok: true, players: -5, rooms: 2.7 }));
		const res = await get('/api/play/population');
		expect(res.parsed).toMatchObject({ players: 0, rooms: 2 });
	});
});

describe('GET /api/play/population: the per-coin breakdown', () => {
	it('asks the upstream for the breakdown and republishes it', async () => {
		const calls = upstream(jsonReply({ ok: true, players: 5, rooms: 2, byCoin: { [MINT]: 5 } }));
		const res = await get('/api/play/population?by=coin');
		expect(new URL(calls[0]).searchParams.get('by')).toBe('coin');
		expect(res.parsed).toEqual({ ok: true, coin: null, players: 5, rooms: 2, byCoin: { [MINT]: 5 } });
	});

	it('omits the breakdown entirely when the caller did not ask for it', async () => {
		const calls = upstream(jsonReply({ ok: true, players: 5, rooms: 2, byCoin: { [MINT]: 5 } }));
		const res = await get('/api/play/population');
		expect(new URL(calls[0]).searchParams.has('by')).toBe(false);
		expect(res.parsed.byCoin).toBeUndefined();
	});

	it('answers without a breakdown when the upstream is older than the parameter', async () => {
		// An upstream that has not shipped `?by=coin` yet answers its normal
		// aggregate. The field is then absent, which the lobby reads as "unknown"
		// and renders as no per-card counts at all. An upstream that DOES support
		// it while every world is empty answers `{}` instead, a real measurement of
		// zero, so the two cases stay distinguishable.
		upstream(jsonReply({ ok: true, players: 5, rooms: 2 }));
		const res = await get('/api/play/population?by=coin');
		expect(res.parsed).toMatchObject({ ok: true, players: 5 });
		expect(res.parsed.byCoin).toBeUndefined();
	});

	it('publishes an empty breakdown when the upstream measured zero worlds', async () => {
		upstream(jsonReply({ ok: true, players: 0, rooms: 0, byCoin: {} }));
		const res = await get('/api/play/population?by=coin');
		expect(res.parsed.byCoin).toEqual({});
	});

	it('re-validates every key in the breakdown before republishing it', async () => {
		// The keys are whatever clients passed as their `coin` join option, so a
		// non-address key, a negative count and an empty world are all dropped
		// rather than forwarded to the browser.
		upstream(jsonReply({
			ok: true, players: 4, rooms: 3,
			byCoin: { [MINT]: 4, '../../etc/passwd': 9, ['A'.repeat(60)]: 2, So11111111111111111111111111111111111111112: 0 },
		}));
		const res = await get('/api/play/population?by=coin');
		expect(res.parsed.byCoin).toEqual({ [MINT]: 4 });
	});

	it('ignores a breakdown that is not an object', async () => {
		upstream(jsonReply({ ok: true, players: 1, rooms: 1, byCoin: [['a', 1]] }));
		const res = await get('/api/play/population?by=coin');
		expect(res.parsed.byCoin).toBeUndefined();
	});
});

describe('GET /api/play/population: degrading without inventing a number', () => {
	it('answers unavailable, not an error, when no upstream is configured', async () => {
		envState.MULTIPLAYER_INTERNAL_URL = '';
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await get(`/api/play/population?coin=${MINT}`);
		expect(res.statusCode).toBe(200);
		expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: MINT });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('answers unavailable when the upstream connection fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
		const res = await get('/api/play/population');
		expect(res.statusCode).toBe(200);
		expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: null });
	});

	it('answers unavailable on an upstream 5xx', async () => {
		upstream(jsonReply({ error: 'boom' }, false, 502));
		const res = await get('/api/play/population');
		expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: null });
	});

	it('answers unavailable when the upstream body is not an ok aggregate', async () => {
		upstream(jsonReply({ ok: false }));
		const res = await get('/api/play/population');
		expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: null });
	});

	it('answers unavailable when the upstream body is not JSON at all', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => { throw new SyntaxError('Unexpected token <'); },
		});
		const res = await get('/api/play/population');
		expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: null });
	});

	it('does not cache an unavailable answer, so the next request retries', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
		const res = await get('/api/play/population');
		expect(res.headers['cache-control']).not.toMatch(/max-age=[1-9]/);
	});

	it('aborts a hanging upstream rather than holding the request open', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) =>
			new Promise((_resolve, reject) => {
				opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
			}));
		vi.useFakeTimers();
		try {
			const res = mockRes();
			const pending = handler(mockReq('/api/play/population'), res);
			await vi.advanceTimersByTimeAsync(3000);
			await pending;
			expect(res.parsed).toEqual({ ok: false, reason: 'unavailable', coin: null });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('GET /api/play/population: HTTP posture', () => {
	it('is a public GET-only endpoint', async () => {
		const res = mockRes();
		await handler(mockReq('/api/play/population', 'POST'), res);
		expect(res.statusCode).toBe(405);
		expect(res.parsed.error).toBe('method_not_allowed');
	});

	it('answers a preflight without running the proxy', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = mockRes();
		await handler({ ...mockReq(), method: 'OPTIONS', headers: { host: 'three.ws', origin: 'https://three.ws' } }, res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('refuses a rate-limited caller before touching the upstream', async () => {
		rlState.success = false;
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await get('/api/play/population');
		expect(res.statusCode).toBe(429);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
