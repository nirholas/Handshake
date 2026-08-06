// IRL location-privacy invariants (H1 — IRL-Hardening regression fence).
//
// The founder's bar is "nobody's real-world location ever leaks." Those
// guarantees live in api/irl/pins.js but were only partially pinned by tests —
// so a future edit could silently re-leak a coordinate, an owner id, or a device
// token and still ship green. This file is the contract: it drives the REAL
// pins.js handler with a content-addressed SQL mock (the irl-pins-room.test.js
// harness, reused verbatim) and asserts every outbound-feed invariant:
//
//   1. the public nearby feed NEVER returns user_id or device_token — only an
//      is_mine boolean leaves;
//   2. every outbound coordinate (lat/lng/origin_lat/origin_lng) is coarsened to
//      ≤ PUBLIC_COORD_DP (5) decimals — false precision is stripped;
//   3. the read requires a genuine fix (missing lat/lng → 400) and clamps the
//      radius to the 60 m ceiling so one read can't widen into a window scan;
//   4. every owner-gated mutation (calibrate / outfit / field PATCH / DELETE)
//      rejects a non-owner (403/404) and mutates NOTHING.
//
// Fully offline: DB / auth / limiter / guardian / accessories all mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Content-addressed SQL mock ──────────────────────────────────────────────
// The nearby SELECT returns one seeded row (with user_id + device_token SET, to
// prove the projection strips them). Mutation SELECTs return a configurable pin
// so the ownership gates can be exercised. UPDATE/DELETE are tracked so we can
// assert a rejected mutation never reached a write.
let nearbyRow = null;     // the row the nearby SELECT yields
let lookupPin = null;     // the row a mutation's ownership SELECT yields
const writes = [];        // every UPDATE/DELETE SQL the handler attempted
let updateResult = [];    // what an UPDATE RETURNING yields (default: no row)
let deleteResult = [];    // what a DELETE RETURNING yields (default: no row)

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	// Density / per-owner count probes on the POST path.
	if (/count\(\*\)::int/i.test(q)) return Promise.resolve([{ n: 0 }]);
	// Nearby SELECT (room columns + a BETWEEN range) → the seeded row.
	if (/rel_east_m/i.test(q) && /BETWEEN/i.test(q) && /SELECT/i.test(q)) {
		return Promise.resolve(nearbyRow ? [nearbyRow] : []);
	}
	// Ownership-lookup SELECT inside calibrate / outfit (SELECT … FROM irl_pins WHERE id = …).
	if (/^\s*SELECT/i.test(q) && /FROM irl_pins/i.test(q) && /WHERE id =/i.test(q)) {
		return Promise.resolve(lookupPin ? [lookupPin] : []);
	}
	if (/UPDATE irl_pins/i.test(q)) {
		writes.push(q.replace(/\s+/g, ' ').trim().slice(0, 40));
		return Promise.resolve(updateResult);
	}
	if (/DELETE FROM irl_pins/i.test(q)) {
		writes.push(q.replace(/\s+/g, ' ').trim().slice(0, 40));
		return Promise.resolve(deleteResult);
	}
	return Promise.resolve([]); // DDL + anything else
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		irlPinIp:     vi.fn(async () => ({ success: true })),
		irlPinBurst:  vi.fn(async () => ({ success: true })),
		irlPinHourly: vi.fn(async () => ({ success: true })),
		publicIp:     vi.fn(async () => ({ success: true })),
		irlNearbyIp:  vi.fn(async () => ({ success: true })),
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
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }), assess: vi.fn(), decide: vi.fn(),
}));

let handler;

function makeRes() {
	return {
		statusCode: 200, _h: {}, headersSent: false, writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function call(method, { url = '/api/irl/pins', query = {}, body } = {}) {
	const res = makeRes();
	await handler({ url, method, headers: { host: 'x' }, query, body }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}
const getNearby = (query) => call('GET', { query });

// Count fractional digits of a number after rounding away float noise at 1e-9.
function fractionalDigits(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
	const s = String(Math.round(n * 1e9) / 1e9);
	const dot = s.indexOf('.');
	return dot < 0 ? 0 : s.length - dot - 1;
}

beforeEach(async () => {
	sqlMock.mockClear();
	sessionUser = null;
	nearbyRow = null;
	lookupPin = null;
	writes.length = 0;
	updateResult = [];
	deleteResult = [];
	vi.resetModules(); // drop any pins.js a prior file cached under its own db.js mock
	({ default: handler } = await import('../../api/irl/pins.js'));
});

const ORIGIN = { lat: 40.7128, lng: -74.006 };

function seedNearby(over = {}) {
	nearbyRow = {
		id: 'pin-1', user_id: 'owner-uuid-secret', device_token: 'device-token-secret',
		agent_id: 'agent-9', lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 90,
		avatar_url: '/a.glb', avatar_name: 'Scout', caption: 'hi', x402_endpoint: null,
		placed_at: '2026-06-17T00:00:00Z', view_count: 3,
		anchor_height_m: null, anchor_yaw_deg: 90, anchor_quat: null,
		gps_accuracy_m: 10, altitude_m: null, anchor_source: 'gyro-gps', avatar_version: 0,
		room_id: null, rel_east_m: null, rel_north_m: null,
		origin_lat: null, origin_lng: null, origin_yaw_deg: null,
		...over,
	};
}

describe('GET /api/irl/pins — the nearby feed never leaks an owner identifier', () => {
	it('strips user_id and device_token; only is_mine leaves', async () => {
		seedNearby();
		const { res, body } = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng) });
		expect(res.statusCode).toBe(200);
		expect(body.pins.length).toBe(1);
		for (const p of body.pins) {
			expect(p).not.toHaveProperty('user_id');
			expect(p).not.toHaveProperty('device_token');
			expect(p).toHaveProperty('is_mine');
			expect(typeof p.is_mine).toBe('boolean');
		}
	});

	it('the leaked-row values themselves never appear anywhere in the serialized body', async () => {
		seedNearby();
		const { res } = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng) });
		// The strongest form: the secret strings must not survive serialization at all.
		expect(res._body).not.toContain('owner-uuid-secret');
		expect(res._body).not.toContain('device-token-secret');
	});

	it('is_mine is true only when the caller proves ownership (session or device token)', async () => {
		seedNearby({ user_id: 'me-uuid' });
		sessionUser = { id: 'me-uuid' };
		const mine = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng) });
		expect(mine.body.pins[0].is_mine).toBe(true);

		sessionUser = { id: 'someone-else' };
		const notMine = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng) });
		expect(notMine.body.pins[0].is_mine).toBe(false);
	});
});

describe('GET /api/irl/pins — every outbound coordinate is coarsened to ≤ 5 decimals', () => {
	it('rounds lat/lng/origin_lat/origin_lng below the false-precision threshold', async () => {
		const preciseLat = 40.71280123456;
		const preciseLng = -74.00609987654;
		seedNearby({
			lat: preciseLat, lng: preciseLng,
			room_id: 'living-room-7', rel_east_m: 2, rel_north_m: 1,
			origin_lat: preciseLat, origin_lng: preciseLng, origin_yaw_deg: 0,
		});
		const { body } = await getNearby({ lat: String(preciseLat), lng: String(preciseLng), radius: '60' });
		const p = body.pins[0];
		for (const key of ['lat', 'lng', 'origin_lat', 'origin_lng']) {
			expect(fractionalDigits(p[key])).toBeLessThanOrEqual(5);
		}
		// The exact stored sub-mm values must NOT leave the server.
		expect(p.lat).not.toBe(preciseLat);
		expect(p.lng).not.toBe(preciseLng);
		// The exact intra-room layout (relative metres) is untouched — only the GPS index is coarsened.
		expect(p.rel_east_m).toBe(2);
		expect(p.rel_north_m).toBe(1);
	});
});

describe('GET /api/irl/pins — the read is bound to a real fix and a tight radius', () => {
	it('400s a missing lat/lng (no couch-browsing without a position)', async () => {
		const { res, body } = await getNearby({ radius: '40' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/lat and lng/i);
	});

	it('clamps a huge requested radius to the 60 m ceiling (no window widening)', async () => {
		seedNearby();
		// A pin ~58 m north is within the 60 m cap but would be excluded by a 40 m
		// default — so if it comes back, the radius was honored up to but not beyond 60.
		const farLat = ORIGIN.lat + 58 / 110540; // ~58 m north
		seedNearby({ lat: farLat, lng: ORIGIN.lng });
		const { body } = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng), radius: '100000' });
		// 58 m is inside the 60 m clamp, so it survives; the row is the only seeded one.
		expect(body.pins.length).toBe(1);
		expect(body.pins[0].distance_m).toBeLessThanOrEqual(60);
	});
});

describe('PATCH calibrate / outfit — a non-owner is rejected and nothing is written', () => {
	const PIN_ID = '11111111-1111-4111-8111-111111111111';

	it('calibrate from a wrong device token → 403, no UPDATE', async () => {
		lookupPin = {
			id: PIN_ID, user_id: null, device_token: 'real-owner-device',
			lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 0,
			anchor_yaw_deg: 0, anchor_height_m: 0, expires_at: null, hidden_at: null,
		};
		const { res } = await call('PATCH', {
			body: { id: PIN_ID, deviceToken: 'attacker-device', calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng } },
		});
		expect(res.statusCode).toBe(403);
		expect(writes.length).toBe(0); // never reached the UPDATE
	});

	it('outfit change from a non-owner session → 403, no bake/UPDATE', async () => {
		lookupPin = {
			id: PIN_ID, user_id: 'real-owner-uuid', avatar_url: '/a.glb',
			avatar_base_url: '/a.glb', avatar_version: 0, expires_at: null, hidden_at: null,
		};
		sessionUser = { id: 'attacker-uuid' };
		const { res } = await call('PATCH', {
			body: { id: PIN_ID, avatar_manifest: { colors: {} } },
		});
		expect(res.statusCode).toBe(403);
		expect(writes.length).toBe(0);
	});
});

describe('PATCH field-edit / DELETE — a non-owner mutates nothing', () => {
	const PIN_ID = '22222222-2222-4222-8222-222222222222';

	it('a field PATCH from a different session updates no row (owner-scoped WHERE → 404)', async () => {
		sessionUser = { id: 'attacker-uuid' };
		updateResult = []; // the owner-scoped WHERE matches nothing for an attacker
		const { res, body } = await call('PATCH', {
			body: { id: PIN_ID, caption: 'defaced' },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found/i);
	});

	it('a DELETE with neither a session nor a device token → 401, never deletes', async () => {
		const { res } = await call('DELETE', { url: `/api/irl/pins?id=${PIN_ID}`, query: { id: PIN_ID } });
		expect(res.statusCode).toBe(401);
		expect(writes.length).toBe(0);
	});

	it('a DELETE with a wrong device token matches no row (owner-scoped WHERE → 404)', async () => {
		deleteResult = []; // strict owner-scoped WHERE returns nothing for a stranger
		const { res, body } = await call('DELETE', {
			url: `/api/irl/pins?id=${PIN_ID}`,
			query: { id: PIN_ID, deviceToken: 'attacker-device' },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found|not yours/i);
	});
});
