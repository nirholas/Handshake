// Boundary tests for GET /api/pump/trades-stream (api/pump/trades-stream.js).
//
// Covers the two paths the live tape depends on:
//   - a malformed mint is rejected with a 4xx JSON error before any upstream
//     socket is opened (it can never match a trade, so opening one is waste)
//   - an upstream subscription refusal reaches the browser as an SSE `notice`
//     event, so a viewer is never shown a lit "live" lamp over a dead tape
//
// connectPumpFunFeed is stubbed so the test drives the handler's own contract
// and never touches PumpPortal.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const feed = vi.hoisted(() => ({ calls: [], stop: vi.fn() }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../api/_lib/pumpfun-ws-feed.js', () => ({
	connectPumpFunFeed: vi.fn((opts) => {
		feed.calls.push(opts);
		return feed.stop;
	}),
}));

const { default: handler } = await import('../api/pump/trades-stream.js');

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mockReq(search = '') {
	const listeners = {};
	return {
		method: 'GET',
		url: `/api/pump/trades-stream${search}`,
		headers: { host: 'localhost' },
		on: (ev, cb) => { listeners[ev] = cb; },
		_listeners: listeners,
	};
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		chunks: [],
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); return this; },
		write(chunk) { this.chunks.push(String(chunk)); return true; },
		end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.ended = true; },
		get body() { return this.chunks.join(''); },
	};
}

describe('GET /api/pump/trades-stream', () => {
	beforeEach(() => { feed.calls.length = 0; });

	it('rejects a malformed mint with a 400 and opens no upstream feed', async () => {
		const res = mockRes();
		await handler(mockReq('?mint=not-a-mint'), res);
		expect(res.statusCode).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('invalid_mint');
		expect(body.error_description).toContain('not-a-mint');
		expect(feed.calls).toHaveLength(0);
	});

	it('rejects the batch when any mint in a comma list is malformed', async () => {
		const res = mockRes();
		await handler(mockReq(`?mint=${MINT},bogus`), res);
		expect(res.statusCode).toBe(400);
		expect(feed.calls).toHaveLength(0);
	});

	it('streams a valid mint and forwards an upstream refusal as an SSE notice', async () => {
		const req = mockReq(`?mint=${MINT}`);
		const res = mockRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['Content-Type']).toContain('text/event-stream');
		expect(res.body).toContain('event: open');
		expect(feed.calls).toHaveLength(1);
		expect(feed.calls[0].kind).toBe('trades');
		expect(feed.calls[0].mints).toEqual([MINT]);

		feed.calls[0].onNotice({
			code: 'upstream_subscription_refused',
			message: 'only available when connecting with an API key',
			detail: 'PUMPPORTAL_API_KEY is not configured on this deployment.',
		});

		const notice = res.body.split('\n\n').find((f) => f.startsWith('event: notice'));
		expect(notice).toBeTruthy();
		const payload = JSON.parse(notice.split('data: ')[1]);
		expect(payload.code).toBe('upstream_subscription_refused');
		expect(payload.mints).toEqual([MINT]);

		req._listeners.close?.();
		expect(feed.stop).toHaveBeenCalled();
	});

	it('falls back to the global feed when no mint is given', async () => {
		const req = mockReq();
		const res = mockRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(feed.calls[0].kind).toBe('all');
		expect(feed.calls[0].mints).toEqual([]);
		req._listeners.close?.();
	});
});
