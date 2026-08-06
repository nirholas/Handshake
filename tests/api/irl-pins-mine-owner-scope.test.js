// GET /api/irl/pins/mine — owner/device scoping (location-leak regression).
//
// The `/mine` feed returns COORDINATES (it's the placer's own pins, surfaced so
// they can manage them without logging in). That makes its WHERE clause a
// location-leak boundary: it must return a pin's lat/lng ONLY to the session that
// owns it or the device token that placed it — never widen to another owner's
// pins because an identifier was missing or empty.
//
// The bug this locks out: a `device_token = ${deviceToken ?? ''}` clause with no
// null-guard. An authenticated caller with no deviceToken (or an empty one) would
// run `device_token = ''`, matching every legacy NULL/empty-token anonymous pin —
// leaking those placers' coordinates to anyone. The fixed query null-guards both
// arms (`${id}::uuid IS NOT NULL AND user_id = …` / `${dev}::text IS NOT NULL AND
// device_token = …`) so a missing identifier contributes an UNSATISFIABLE arm.
//
// DB / auth / limiter are mocked so the suite stays offline. We inspect the exact
// parameters the `/mine` SELECT was interpolated with — proving the guard holds at
// the query layer rather than trusting a mock's row shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins that would leak if the WHERE clause ever matched an empty/NULL identifier.
const FOREIGN_PIN = {
	id: 'pin-foreign', lat: 51.5, lng: -0.12, avatar_name: 'NotYours', caption: null,
	placed_at: '2026-01-01T00:00:00Z', expires_at: null, view_count: 0,
};
const OWN_PIN = {
	id: 'pin-own', lat: 40.0, lng: -73.0, avatar_name: 'Mine', caption: null,
	placed_at: '2026-01-02T00:00:00Z', expires_at: null, view_count: 0,
};

// The `/mine` device/auth SELECT is the only query carrying both `FROM irl_pins`
// and an `OR (... device_token = ...)` owner clause. Capture its interpolated
// parameters so a test can prove what it would match in Postgres.
let mineCall = null;
let mineRows = [];
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM\s+irl_pins/i.test(q) && /device_token\s*=/i.test(q) && /user_id\s*=/i.test(q) && /LIMIT 20/i.test(q)) {
		mineCall = { q, values };
		return Promise.resolve(mineRows);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
		irlNearbyIp: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
	},
	// limitFailClosedRead + irlNearbyIp: the nearby branch draws on a dedicated
	// coordinate-read bucket and denies when the limiter cannot decide. Behaviour is
	// owned by tests/api/irl-nearby-limit.test.js; here they just have to exist.
	limitFailClosedRead: async (_name, fn, ...args) => {
		try { return await fn(...args); }
		catch { return { success: false, reason: 'rate_limiter_unavailable', reset: Date.now() + 60_000 }; }
	},
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/irl/pins.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function getMine({ query = {} } = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins/mine', method: 'GET', headers: { host: 'x' }, query }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch { /* non-JSON */ }
	return { res, body };
}

beforeEach(() => {
	sqlMock.mockClear();
	mineCall = null;
	mineRows = [];
	sessionUser = null;
});

describe('GET /api/irl/pins/mine — requires an identifier', () => {
	it('400s a caller with neither a session nor a device token, and never queries pins', async () => {
		const { res } = await getMine({ query: {} });
		expect(res.statusCode).toBe(400);
		expect(mineCall).toBeNull();
	});

	it('400s when the device token is an empty string (no usable identifier)', async () => {
		const { res } = await getMine({ query: { deviceToken: '' } });
		expect(res.statusCode).toBe(400);
		expect(mineCall).toBeNull();
	});
});

describe('GET /api/irl/pins/mine — null-guarded owner scoping (no cross-user leak)', () => {
	it('passes a NULL owner id (not an empty/guessable value) when the caller is anonymous', async () => {
		// Anonymous device caller: the user_id arm must be NULL so it can never match a
		// row whose user_id is NULL — only the device_token arm should be live.
		const { res } = await getMine({ query: { deviceToken: 'dev-xyz' } });
		expect(res.statusCode).toBe(200);
		expect(mineCall).not.toBeNull();
		// Params, in order: ownerId(null), ownerId(null), ownerDev, ownerDev — the
		// guard interpolates each identifier twice (the `IS NOT NULL` check + the `=`).
		expect(mineCall.values).toContain('dev-xyz');
		// No empty-string identifier ever reaches the query — that was the leak.
		expect(mineCall.values).not.toContain('');
		// The owner-id arm is explicitly NULL for an anonymous caller.
		expect(mineCall.values.filter((v) => v === null).length).toBeGreaterThanOrEqual(1);
	});

	it('passes a NULL device token (not "") when an authenticated caller omits deviceToken', async () => {
		// The exact bug vector: signed-in user, no deviceToken param. The device arm
		// must be NULL so `device_token = ''` can never surface other anonymous pins.
		sessionUser = { id: 'owner-uuid-1' };
		const { res } = await getMine({ query: {} });
		expect(res.statusCode).toBe(200);
		expect(mineCall).not.toBeNull();
		expect(mineCall.values).toContain('owner-uuid-1');
		// Crucially: NOT an empty string in the device-token slot.
		expect(mineCall.values).not.toContain('');
	});

	it('scopes by session id and device token together for an authenticated placer', async () => {
		sessionUser = { id: 'owner-uuid-2' };
		mineRows = [OWN_PIN];
		const { res, body } = await getMine({ query: { deviceToken: 'dev-abc' } });
		expect(res.statusCode).toBe(200);
		expect(mineCall.values).toContain('owner-uuid-2');
		expect(mineCall.values).toContain('dev-abc');
		expect(mineCall.values).not.toContain('');
		expect(body.pins[0].id).toBe('pin-own');
	});

	it('filters out hidden and expired pins (the row leaves only for live, own pins)', async () => {
		// The query the handler runs always carries the hidden/expired guards; assert
		// they are present so a future edit can't quietly drop them.
		await getMine({ query: { deviceToken: 'dev-abc' } });
		expect(mineCall.q).toMatch(/hidden_at\s+IS\s+NULL/i);
		expect(mineCall.q).toMatch(/expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*NOW\(\)/i);
	});
});
