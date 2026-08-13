// GET/POST /api/irl/drops: the request boundary of the IRL Money Drops endpoint.
//
// tests/irl-drops.test.js covers the custody primitive itself (public projection,
// atomics math, quiz hashing, presence proof). This file covers the HTTP edge the
// handler owns: path parsing, id validation, method handling, and the auth /
// presence refusals that must happen BEFORE anything touches an escrow. Nothing
// here signs, funds, or releases: every custody call is mocked, so a probe of the
// claim path exercises its validation, never a settlement.
//
// The id guard is the regression fence. `irl_drops.id` is a UUID column, so
// `/api/irl/drops/not-a-uuid` used to reach getDropRow(), where Postgres refused
// the cast (`invalid input syntax for type uuid`) and a malformed URL came back as
// a 500 instead of a 4xx.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Custody + chain modules are mocked wholesale; this suite never moves value.
const getDropRowMock = vi.fn(async () => null);
const nearbyDropsMock = vi.fn(async () => []);
const myDropsMock = vi.fn(async () => []);
const myClaimsMock = vi.fn(async () => []);
const createDropMock = vi.fn(async () => { throw Object.assign(new Error('not reached'), { status: 400 }); });

vi.mock('../../api/_lib/irl-drops.js', () => ({
	getDropRow: (...a) => getDropRowMock(...a),
	nearbyDrops: (...a) => nearbyDropsMock(...a),
	myDrops: (...a) => myDropsMock(...a),
	myClaims: (...a) => myClaimsMock(...a),
	createDrop: (...a) => createDropMock(...a),
	confirmFunding: vi.fn(),
	reserveClaim: vi.fn(),
	failClaim: vi.fn(),
	confirmClaim: vi.fn(),
	releaseFromEscrow: vi.fn(),
	markRefunding: vi.fn(),
	sweepRefund: vi.fn(),
	recordRefundTx: vi.fn(),
	hasChatSignal: vi.fn(async () => false),
	verifyQuiz: vi.fn(async () => false),
	haversineM: () => 0,
	atomicsToAmount: (v) => String(v),
	toPublicDrop: (row) => ({ ...row }),
	BASE58_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(),
	loadAgentForSigning: vi.fn(async () => ({ error: { status: 403, code: 'forbidden', msg: 'no' } })),
}));
vi.mock('../../api/_lib/execution-engine.js', () => ({ submitProtected: vi.fn() }));
vi.mock('../../api/_lib/agent-trade-guards.js', () => ({
	enforceSpendLimit: vi.fn(),
	lamportsToUsd: vi.fn(async () => 0),
	SpendLimitError: class SpendLimitError extends Error {},
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		irlNearbyIp: vi.fn(async () => ({ success: true })),
		irlPinIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
	limitFailClosedRead: vi.fn(async () => ({ success: true })),
}));

// Presence enforcement off by default (the dev/preview contract); the claim path
// verifies the token itself, so it is asserted through verifyFixToken.
let fixIsEnforced = false;
let fixVerdict = { ok: false, reason: 'missing' };
vi.mock('../../api/_lib/irl-presence.js', () => ({
	fixEnforced: () => fixIsEnforced,
	verifyFixToken: vi.fn(async () => fixVerdict),
}));

const { default: handler } = await import('../../api/irl/drops.js');

const DROP_ID = '11111111-1111-4111-8111-111111111111';

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

async function call(method, url, { body, headers = {} } = {}) {
	const res = makeRes();
	const req = { url, method, headers: { host: 'x', ...headers }, query: {}, body };
	if (body !== undefined) {
		// readJson() reads the raw body and requires the JSON content type, exactly as
		// the server hands it over in production.
		req.rawBody = Buffer.from(JSON.stringify(body));
		req.headers['content-type'] = 'application/json';
	}
	await handler(req, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch { /* non-JSON body */ }
	return { res, body: parsed };
}

beforeEach(() => {
	sessionUser = null;
	fixIsEnforced = false;
	fixVerdict = { ok: false, reason: 'missing' };
	getDropRowMock.mockClear().mockResolvedValue(null);
	nearbyDropsMock.mockClear().mockResolvedValue([]);
});

describe('drop id validation', () => {
	it('400s a non-UUID drop id on a read, without querying for the row', async () => {
		const { res, body } = await call('GET', '/api/irl/drops/not-a-uuid');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(getDropRowMock).not.toHaveBeenCalled();
	});

	it('400s a non-UUID drop id on an action path too', async () => {
		const { res } = await call('POST', '/api/irl/drops/xyz/claim', { body: { lat: 1, lng: 1 } });
		expect(res.statusCode).toBe(400);
		expect(getDropRowMock).not.toHaveBeenCalled();
	});

	it('404s a well-formed id that names no drop', async () => {
		const { res, body } = await call('GET', `/api/irl/drops/${DROP_ID}`);
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(getDropRowMock).toHaveBeenCalledWith(DROP_ID);
	});
});

describe('nearby read', () => {
	it('400s without coordinates', async () => {
		const { res, body } = await call('GET', '/api/irl/drops');
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/lat and lng/i);
	});

	it('401s when presence is enforced and no valid fix token is presented', async () => {
		fixIsEnforced = true;
		const { res, body } = await call('GET', '/api/irl/drops?lat=37.7749&lng=-122.4194');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('fix_required');
		expect(nearbyDropsMock).not.toHaveBeenCalled();
	});

	it('caps the radius at the server ceiling rather than trusting the caller', async () => {
		await call('GET', '/api/irl/drops?lat=37.7749&lng=-122.4194&radius=100000');
		expect(nearbyDropsMock).toHaveBeenCalledWith(expect.objectContaining({ radiusM: 80 }));
	});
});

describe('write paths refuse before any custody work', () => {
	it('401s a create from a caller with neither a session nor a device token', async () => {
		const { res, body } = await call('POST', '/api/irl/drops', { body: { amount: 1, lat: 1, lng: 1 } });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('auth_required');
		expect(createDropMock).not.toHaveBeenCalled();
	});

	it('405s an unsupported method', async () => {
		const { res } = await call('PUT', '/api/irl/drops');
		expect(res.statusCode).toBe(405);
	});
});
