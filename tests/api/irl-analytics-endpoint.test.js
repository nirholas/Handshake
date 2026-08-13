// GET /api/irl/analytics: the ops-gated /irl usage rollup.
//
// tests/irl-analytics.test.js covers the rollup queries themselves; this file
// covers the endpoint around them: the CORS decision, the ops authorization gate,
// the method gate, and the degrade contract when the summary can't be read.
//
// The CORS case is the regression fence. cors() takes `origins` as null (the
// first-party allow-list), '*', or an array of patterns. This handler passed the
// string 'same', which reached `allowed.some(...)` and threw a TypeError, so every
// request that carried an Origin header - the browser preflight included - came
// back as a 500 instead of a CORS decision.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let summaryImpl = async () => ({
	windows: { '24h': { pins_placed: 3 } },
	placement_modes_30d: { 'gyro-gps': 3 },
	daily_series_30d: [{ day: '2026-08-13', pins_placed: 3, nearby_fetches: 1 }],
	generated_at: '2026-08-13T00:00:00.000Z',
});
vi.mock('../../api/_lib/irl-analytics.js', () => ({
	getIrlAnalyticsSummary: () => summaryImpl(),
}));

let authOk = true;
vi.mock('../../api/_lib/ops-auth.js', () => ({
	authorizeOps: vi.fn(async () => (authOk ? { ok: true, actor: 'ops-secret' } : { ok: false, actor: '' })),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/irl/analytics.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}

async function call(method = 'GET', headers = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/analytics', method, headers: { host: 'x', ...headers }, query: {} }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch { /* non-JSON body */ }
	return { res, body: parsed };
}

beforeEach(() => {
	authOk = true;
	summaryImpl = async () => ({
		windows: { '24h': { pins_placed: 3 } },
		placement_modes_30d: { 'gyro-gps': 3 },
		daily_series_30d: [{ day: '2026-08-13', pins_placed: 3, nearby_fetches: 1 }],
		generated_at: '2026-08-13T00:00:00.000Z',
	});
});

describe('CORS', () => {
	it('answers a preflight that carries an Origin with 204, never a 500', async () => {
		const { res } = await call('OPTIONS', { origin: 'https://evil.example.com' });
		expect(res.statusCode).toBe(204);
	});

	it('does not hand a cross-origin caller an allow-origin header', async () => {
		const { res } = await call('GET', { origin: 'https://evil.example.com' });
		expect(res.getHeader('access-control-allow-origin')).toBeUndefined();
		expect(res.statusCode).toBe(200); // authorized in this suite; the CORS header is the assertion
	});
});

describe('gates', () => {
	it('401s an unauthorized caller', async () => {
		authOk = false;
		const { res, body } = await call('GET');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('405s a non-GET method', async () => {
		const { res, body } = await call('POST');
		expect(res.statusCode).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});

	it('serves the real rollup to an authorized caller', async () => {
		const { res, body } = await call('GET');
		expect(res.statusCode).toBe(200);
		expect(body.windows['24h'].pins_placed).toBe(3);
		expect(body.daily_series_30d).toHaveLength(1);
	});
});

describe('degrade contract', () => {
	it('serves an empty rollup with a note, and LOGS the reason', async () => {
		summaryImpl = async () => { throw new Error('relation "irl_events" does not exist'); };
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { res, body } = await call('GET');
		expect(res.statusCode).toBe(200);
		expect(body.windows).toEqual({});
		expect(body.note).toMatch(/analytics_unavailable/);
		// An unlogged degrade is indistinguishable from "no usage yet". That is how a
		// broken query survived unnoticed behind a wall of zeros.
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
