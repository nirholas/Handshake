// POST + GET /api/irl/pins — shared room-frame anchoring.
//
// A room-placed agent stores its EXACT offset (rel_east_m / rel_north_m) from a
// shared origin (origin_lat/lng/yaw) instead of relying on its own GPS, so a
// cluster keeps its room-scale layout identical for every viewer (see
// src/irl/room-anchor.js). These tests pin the API contract for that pose:
//   • a valid room block persists, clamped/normalized;
//   • an invalid/absent block leaves every room column NULL (a standalone pin),
//     so old clients and single-drop placements are untouched;
//   • the nearby projection surfaces the room columns (and never an owner id).
// DB / auth / limiter / guardian / realtime are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock. The INSERT echoes its bound values back as columns
// (incl. the six room columns appended last) so success-path assertions see the
// EXACT coerced pose. The nearby SELECT returns one seeded room pin so the
// projection round-trip can be asserted.
let nearbyRow = null;
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/count\(\*\)::int/i.test(q)) return Promise.resolve([{ n: 0 }]);
	if (/INSERT INTO irl_pins/i.test(q)) {
		const [
			user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint, expires_at,
			anchor_height_m, anchor_yaw_deg, anchor_quat, anchor_scale,
			gps_accuracy_m, altitude_m, anchor_source, geocell7,
			room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg,
		] = values;
		return Promise.resolve([{
			id: 'pin-new', user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint,
			placed_at: '2026-06-17T00:00:00Z', expires_at,
			anchor_height_m, anchor_yaw_deg, anchor_quat, anchor_scale,
			gps_accuracy_m, altitude_m, anchor_source, geocell7,
			room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg,
			view_count: 0, avatar_version: 0,
		}]);
	}
	// Nearby SELECT (has the room columns + a BETWEEN range) → the seeded row.
	if (/rel_east_m/i.test(q) && /BETWEEN/i.test(q) && /SELECT/i.test(q)) {
		return Promise.resolve(nearbyRow ? [nearbyRow] : []);
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
	},
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }), assess: vi.fn(), decide: vi.fn(),
}));

// Import the handler fresh per test (after resetModules) so this file's db.js
// mock deterministically backs the handler even when another pins.js-importing
// test ran first in the same worker — otherwise a leaked sibling mock (which
// doesn't echo the room columns) makes these assertions flake. See beforeEach.
let handler;

const ORIGIN = { lat: 40.7128, lng: -74.006 };

function makeRes() {
	return {
		statusCode: 200, _h: {}, headersSent: false, writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this.writableEnded = true; this._body = body; },
	};
}
async function post(body) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'POST', headers: { host: 'x' }, query: {}, body }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}
async function getNearby(query) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'GET', headers: { host: 'x' }, query }, res);
	let parsed = null; try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const basePin = () => ({
	lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 270,
	avatarUrl: '/avatars/default.glb', avatarName: 'Scout', deviceToken: 'device-A',
});
const room = (over = {}) => ({
	id: 'living-room-7', originLat: ORIGIN.lat, originLng: ORIGIN.lng,
	originYawDeg: 0, relEast: 2, relNorth: 1, ...over,
});

beforeEach(async () => {
	sqlMock.mockClear(); sessionUser = null; nearbyRow = null;
	vi.resetModules(); // drop any pins.js a prior file cached under its own db.js mock
	({ default: handler } = await import('../../api/irl/pins.js'));
});

describe('POST /api/irl/pins — room frame persistence', () => {
	it('stores room id + exact offset + origin when the client places into a room', async () => {
		const { res, body } = await post({ ...basePin(), room: room({ relEast: 2.5, relNorth: -1.25, originYawDeg: 30 }) });
		expect(res.statusCode).toBe(201);
		const p = body.pin;
		expect(p.room_id).toBe('living-room-7');
		expect(p.rel_east_m).toBe(2.5);
		expect(p.rel_north_m).toBe(-1.25);
		expect(p.origin_lat).toBe(ORIGIN.lat);
		expect(p.origin_lng).toBe(ORIGIN.lng);
		expect(p.origin_yaw_deg).toBe(30);
	});

	it('an old client with no room block creates a valid standalone pin (NULL room columns)', async () => {
		const { res, body } = await post(basePin());
		expect(res.statusCode).toBe(201);
		const p = body.pin;
		for (const k of ['room_id', 'rel_east_m', 'rel_north_m', 'origin_lat', 'origin_lng', 'origin_yaw_deg']) {
			expect(p[k]).toBeNull();
		}
	});

	it('drops an invalid room to a standalone pin rather than anchoring at (0,0)', async () => {
		// Bad slug.
		const a = await post({ ...basePin(), room: room({ id: 'Living Room!' }) });
		expect(a.body.pin.room_id).toBeNull();
		expect(a.body.pin.rel_east_m).toBeNull();
		// Null-island origin is rejected (a missing GPS fix must never plant a real room there).
		const b = await post({ ...basePin(), room: room({ originLat: 0, originLng: 0 }) });
		expect(b.body.pin.room_id).toBeNull();
		// Non-finite offset.
		const c = await post({ ...basePin(), room: room({ relEast: 'NaN' }) });
		expect(c.body.pin.room_id).toBeNull();
	});

	it('clamps an out-of-range offset and normalizes the frame rotation', async () => {
		const { body } = await post({ ...basePin(), room: room({ relEast: 9000, relNorth: -9000, originYawDeg: -45 }) });
		expect(body.pin.rel_east_m).toBe(500);    // REL_MAX_M ceiling
		expect(body.pin.rel_north_m).toBe(-500);
		expect(body.pin.origin_yaw_deg).toBe(315); // −45° → 315°
	});
});

describe('GET /api/irl/pins — room frame projection', () => {
	it('surfaces the room columns to viewers and never an owner identifier', async () => {
		nearbyRow = {
			id: 'pin-room', user_id: 'owner-uuid', device_token: 'device-A', agent_id: null,
			lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 90,
			avatar_url: '/a.glb', avatar_name: 'Scout', caption: '', x402_endpoint: null,
			placed_at: '2026-06-17T00:00:00Z', view_count: 0,
			anchor_height_m: null, anchor_yaw_deg: 90, anchor_quat: null,
			gps_accuracy_m: 10, altitude_m: null, anchor_source: 'gyro-gps', avatar_version: 0,
			room_id: 'living-room-7', rel_east_m: 2, rel_north_m: 1,
			origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, origin_yaw_deg: 0,
		};
		const { res, body } = await getNearby({ lat: String(ORIGIN.lat), lng: String(ORIGIN.lng), radius: '150' });
		expect(res.statusCode).toBe(200);
		const p = body.pins[0];
		expect(p.room_id).toBe('living-room-7');
		expect(p.rel_east_m).toBe(2);
		expect(p.rel_north_m).toBe(1);
		expect(p.origin_lat).toBe(ORIGIN.lat);
		expect(p.origin_yaw_deg).toBe(0);
		// The allow-list projection must not leak owner identity.
		expect(p.user_id).toBeUndefined();
		expect(p.device_token).toBeUndefined();
	});

	it('coarsens outbound coordinates to ~1.1 m so the public feed carries no false precision', async () => {
		// A pin stored at full float64 precision (sub-millimetre tail).
		const preciseLat = 40.71280123456;
		const preciseLng = -74.00609987654;
		nearbyRow = {
			id: 'pin-precise', user_id: 'owner-uuid', device_token: 'device-A', agent_id: null,
			lat: preciseLat, lng: preciseLng, heading: 0,
			avatar_url: '/a.glb', avatar_name: 'Scout', caption: '', x402_endpoint: null,
			placed_at: '2026-06-17T00:00:00Z', view_count: 0,
			anchor_height_m: null, anchor_yaw_deg: 0, anchor_quat: null,
			gps_accuracy_m: 10, altitude_m: null, anchor_source: 'gyro-gps', avatar_version: 0,
			room_id: 'living-room-7', rel_east_m: 2, rel_north_m: 1,
			origin_lat: preciseLat, origin_lng: preciseLng, origin_yaw_deg: 0,
		};
		const { body } = await getNearby({ lat: String(preciseLat), lng: String(preciseLng), radius: '60' });
		const p = body.pins[0];
		// Rounded to 5 decimals (PUBLIC_COORD_DP) — the sub-mm tail is gone.
		expect(p.lat).toBe(40.7128);
		expect(p.lng).toBe(-74.0061);
		expect(p.origin_lat).toBe(40.7128);
		expect(p.origin_lng).toBe(-74.0061);
		// The exact stored values must NOT leave the server.
		expect(p.lat).not.toBe(preciseLat);
		expect(p.lng).not.toBe(preciseLng);
		// The room's exact intra-room layout (relative offsets) is untouched.
		expect(p.rel_east_m).toBe(2);
		expect(p.rel_north_m).toBe(1);
	});
});
