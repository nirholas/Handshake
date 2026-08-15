// Tests for GET/POST /api/pump/autopilot: the per-coin policy that gates the
// run-buyback and run-distribute-payments crons.
//
// The DB, auth, and rate limiter are mocked: no network, no chain. The focus is
// the CSRF gate on the write path. A POST here rewrites money-moving automation
// (pause a buyback, flip it to full-swap), so a cross-site form riding the
// session cookie must never reach the policy write, while bearer callers (agent
// keys, workers) stay exempt because the token itself proves intent.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const authState = { session: null, bearer: null };
vi.mock('../../api/_lib/auth.js', async () => {
	const actual = await vi.importActual('../../api/_lib/auth.js');
	return {
		...actual,
		getSessionUser: vi.fn(async () => authState.session),
		authenticateBearer: vi.fn(async () => authState.bearer),
		extractBearer: vi.fn(() => null),
	};
});

const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => vi.fn(async () => ({ success: true })) }),
	clientIp: vi.fn(() => '127.0.0.1'),
}));

function makeReq({ method = 'GET', url = '/api/pump/autopilot', headers = {}, body = null } = {}) {
	const req = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = {
		host: 'localhost',
		origin: 'https://three.ws',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return req;
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: '', writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke(opts) {
	const { default: handler } = await import('../../api/pump/autopilot.js');
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

const MINT = 'MintPubkey1111111111111111111111111111';

describe('/api/pump/autopilot', () => {
	beforeEach(() => {
		authState.session = null;
		authState.bearer = null;
		sqlState.queue = [];
		sqlState.calls = [];
	});

	it('401s an unauthenticated read', async () => {
		const { res, json } = await invoke({ method: 'GET' });
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('serves the caller their own coins on a session read', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [[]];
		const { res, json } = await invoke({ method: 'GET' });
		expect(res.statusCode).toBe(200);
		expect(json).toEqual({ coins: [], activity: [] });
	});

	it('rejects a cross-site POST riding the session cookie, before any write', async () => {
		authState.session = { id: 'user-1' };
		const { res, json } = await invoke({
			method: 'POST',
			headers: { origin: 'https://evil.example' },
			body: { mint: MINT, buyback_full_swap: true },
		});
		expect(res.statusCode).toBe(403);
		expect(json.error).toBe('forbidden');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a cookie-authed POST carrying neither Origin nor Referer', async () => {
		authState.session = { id: 'user-1' };
		const { res } = await invoke({
			method: 'POST',
			headers: { origin: undefined },
			body: { mint: MINT },
		});
		expect(res.statusCode).toBe(403);
	});

	it('does not gate bearer-authed writes', async () => {
		authState.bearer = { userId: 'user-1' };
		const { res } = await invoke({
			method: 'POST',
			headers: { origin: 'https://evil.example' },
			body: { mint: MINT },
		});
		// Past the gate: the coin lookup returns nothing, so this 404s on data,
		// never on the CSRF gate.
		expect(res.statusCode).toBe(404);
	});

	it('leaves reads open to a cookie session with no Origin', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [[]];
		const { res } = await invoke({ method: 'GET', headers: { origin: undefined } });
		expect(res.statusCode).toBe(200);
	});

	it('404s a same-site write for a coin the caller does not own', async () => {
		authState.session = { id: 'user-1' };
		sqlState.queue = [[]];
		const { res, json } = await invoke({ method: 'POST', body: { mint: MINT } });
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});

	it('400s a write whose mint is too short to be a pubkey', async () => {
		authState.session = { id: 'user-1' };
		const { res, json } = await invoke({ method: 'POST', body: { mint: 'short' } });
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('bad_request');
	});
});
