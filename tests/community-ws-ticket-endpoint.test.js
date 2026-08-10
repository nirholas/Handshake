/**
 * POST /api/community/ws-ticket endpoint tests.
 *
 * The ticket is what lets the browser open a realtime socket to
 * CoinCommunities without ever seeing the server's API key, so the contract
 * that matters is: a valid coin gets a ticket plus the origin to use it
 * against, the ticket is never cacheable, and every upstream failure mode
 * answers with its own code instead of leaking the key path or a stack trace.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const upstream = { configured: true, ticket: 'tkt_live_abc123', error: null, calledWith: null };
vi.mock('../api/_lib/coin-communities.js', async () => {
	const actual = await vi.importActual('../api/_lib/coin-communities.js');
	return {
		...actual,
		cc: vi.fn(() => {
			if (!upstream.configured) throw new actual.UnconfiguredError();
			return {
				getWsTicket: async (args) => {
					upstream.calledWith = args;
					return upstream.error
						? { data: null, error: upstream.error }
						: { data: upstream.ticket ? { ticket: upstream.ticket } : {}, error: null };
				},
			};
		}),
	};
});

const { default: handler } = await import('../api/community/ws-ticket.js');
const { ccBaseUrl } = await import('../api/_lib/coin-communities.js');

// Synthetic base58 mint of the right shape: no real mainnet coin.
const MINT = 'THREEsynthetic1111111111111111111111111pump';

function makeReq(httpMethod = 'POST', token = MINT) {
	return {
		method: httpMethod,
		url: `/api/community/ws-ticket${token === null ? '' : `?token=${encodeURIComponent(token)}`}`,
		headers: { origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	r.json = () => JSON.parse(r._b);
	return r;
}
async function call(httpMethod, token) {
	const res = makeRes();
	await handler(makeReq(httpMethod, token), res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	upstream.configured = true;
	upstream.ticket = 'tkt_live_abc123';
	upstream.error = null;
	upstream.calledWith = null;
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('POST ws-ticket', () => {
	it('mints a ticket and names the socket origin', async () => {
		const res = await call('POST');
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ ticket: 'tkt_live_abc123', baseUrl: ccBaseUrl() });
		expect(upstream.calledWith).toEqual({ path: { token_address: MINT } });
	});

	it('never lets a ticket be cached', async () => {
		const res = await call('POST');
		expect(res._h['cache-control']).toBe('no-store');
	});

	it('rejects a malformed token before any upstream call', async () => {
		const res = await call('POST', 'not-a-mint');
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
		expect(upstream.calledWith).toBeNull();
	});

	it('rejects a missing token', async () => {
		const res = await call('POST', null);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
	});

	it('503s when CoinCommunities is unconfigured', async () => {
		upstream.configured = false;
		const res = await call('POST');
		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('cc_unconfigured');
	});

	it('502s on an upstream error, surfacing its message', async () => {
		upstream.error = { message: 'ticket service down' };
		const res = await call('POST');
		expect(res.statusCode).toBe(502);
		expect(res.json()).toMatchObject({
			error: 'upstream_error',
			error_description: 'ticket service down',
		});
	});

	it('502s when upstream answers without a ticket', async () => {
		upstream.ticket = '';
		const res = await call('POST');
		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('upstream_error');
	});
});

describe('transport', () => {
	it('405s a GET', async () => {
		const res = await call('GET');
		expect(res.statusCode).toBe(405);
		expect(res.json().error).toBe('method_not_allowed');
	});

	it('429s when rate limited', async () => {
		rl.ok = false;
		const res = await call('POST');
		expect(res.statusCode).toBe(429);
		expect(res.json().error).toBe('rate_limited');
	});

	it('answers a preflight with the POST-only CORS contract', async () => {
		const res = makeRes();
		await handler(makeReq('OPTIONS'), res);
		expect(res.statusCode).toBe(204);
		expect(res._h['access-control-allow-methods']).toBe('POST,OPTIONS');
		expect(res._h['access-control-allow-origin']).toBe('https://three.ws');
	});
});
