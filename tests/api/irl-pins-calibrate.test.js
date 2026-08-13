// PATCH /api/irl/pins { calibrate } — IRL-Live A3 cross-user anchor consistency.
//
// The calibrate path is a small, owner-gated pose correction: the owner (or the
// anonymous device that placed the pin) nudges an agent a few centimetres /
// degrees into its true real-world spot so every nearby viewer sees it there.
// Because a corrected pose re-saves for EVERYONE, the server is the security
// boundary — it must reject non-owners and clamp the nudge so calibration can
// never be abused to teleport someone's agent across the map. These tests prove
// that boundary holds (the A3 acceptance criterion the client clamp alone can't
// guarantee). The DB / auth / limiter are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock: classify the tagged-template query by its text so
// ensureTable()'s DDL, the ownership SELECT, and the UPDATE each return the right
// shape regardless of call order. `pinRow` is the row the WHERE-id SELECT returns
// (null → "not found"); the UPDATE echoes back the bound values so success-path
// assertions see the persisted pose.
//
// The UPDATE binds, in order: lat, lng, anchor_yaw_deg, heading, anchor_height_m,
// then a clearQuat boolean (anchor_quat CASE — task 02 retires the stored surface
// quat when the owner manually re-yaws), then the WHERE id. The mock models that
// CASE so a yaw nudge surfaces anchor_quat: null and a move/height-only nudge
// leaves the stored quat untouched, exactly like the SQL.
let pinRow = null;
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/SELECT[\s\S]*FROM irl_pins[\s\S]*WHERE id =/i.test(q)) {
		return Promise.resolve(pinRow ? [pinRow] : []);
	}
	if (/UPDATE irl_pins SET/i.test(q)) {
		const [lat, lng, yaw, heading, height, clearQuat, id] = values;
		return Promise.resolve([{
			id,
			lat, lng,
			heading:         heading ?? pinRow?.heading ?? null,
			anchor_yaw_deg:  yaw     ?? pinRow?.anchor_yaw_deg ?? null,
			anchor_height_m: height  ?? pinRow?.anchor_height_m ?? null,
			anchor_quat:     clearQuat ? null : (pinRow?.anchor_quat ?? null),
			gps_accuracy_m:  pinRow?.gps_accuracy_m ?? null,
		}]);
	}
	// CREATE TABLE / ALTER TABLE / CREATE INDEX from ensureTable(), and anything else.
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// getSessionUser is overridden per-test to model authed vs anonymous callers.
let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { irlPinIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/irl/pins.js');

// Reference placement: an anonymous device-owned pin near lower Manhattan.
const ORIGIN = { lat: 40.7128, lng: -74.006 };
const M_PER_DEG_LAT = 110540;

function makeReq(body) {
	return { url: '/api/irl/pins', method: 'PATCH', headers: { host: 'x' }, query: {}, body };
}
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
async function patch(body) {
	const res = makeRes();
	await handler(makeReq(body), res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockClear();
	pinRow = {
		id: PIN_ID,
		user_id: null,
		device_token: 'device-A',
		lat: ORIGIN.lat,
		lng: ORIGIN.lng,
		heading: 90,
		anchor_yaw_deg: 90,
		anchor_height_m: 0,
		// A WebXR placement that captured the full tap-moment surface orientation.
		anchor_quat: [0, 0.7071, 0, 0.7071], // ≈ 90° about Y
		gps_accuracy_m: 12,
	};
	sessionUser = null;
});

// `irl_pins.id` is a UUID column and the handler rejects any non-UUID id at the
// boundary, so the fixtures below are real UUIDs rather than readable slugs.
const PIN_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_PIN_ID = '22222222-2222-4222-8222-222222222222';

describe('PATCH /api/irl/pins calibrate — ownership gate', () => {
	it('404s when the pin no longer exists', async () => {
		pinRow = null;
		const { res, body } = await patch({
			id: MISSING_PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found/i);
	});

	it('403s a non-owner (device token mismatch, no session)', async () => {
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-B',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng },
		});
		expect(res.statusCode).toBe(403);
		expect(body.error).toMatch(/only the owner/i);
	});

	it('403s a caller with neither matching session nor device token', async () => {
		const { res } = await patch({
			id: PIN_ID,
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng },
		});
		expect(res.statusCode).toBe(403);
	});

	it('never reaches the UPDATE for a denied caller', async () => {
		await patch({ id: PIN_ID, deviceToken: 'device-B', calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng } });
		const ranUpdate = sqlMock.mock.calls.some(([s]) =>
			/UPDATE irl_pins SET/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranUpdate).toBe(false);
	});
});

describe('PATCH /api/irl/pins calibrate — bounds enforcement', () => {
	it('400s on out-of-range coordinates', async () => {
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: 999, lng: ORIGIN.lng },
		});
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/invalid calibrate coordinates/i);
	});

	it('422s a ground move larger than the calibration ceiling (anti-teleport)', async () => {
		// ~22 m north — well beyond the ±3 m client clamp and the 5 m server ceiling.
		const farLat = ORIGIN.lat + 0.0002;
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: farLat, lng: ORIGIN.lng },
		});
		expect(res.statusCode).toBe(422);
		expect(body.error).toMatch(/move too large/i);
		expect(body.max_m).toBe(5);
	});

	it('422s a yaw nudge beyond the rotation ceiling', async () => {
		// Same spot (move passes), but 90° off the stored 90° bearing → > 46° cap.
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, anchorYawDeg: 180 },
		});
		expect(res.statusCode).toBe(422);
		expect(body.error).toMatch(/rotation too large/i);
		expect(body.max_deg).toBe(46);
	});

	it('422s a floor-height nudge beyond the rise ceiling', async () => {
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, anchorHeightM: 5 },
		});
		expect(res.statusCode).toBe(422);
		expect(body.error).toMatch(/height too large/i);
	});
});

describe('PATCH /api/irl/pins calibrate — accepted nudges persist for everyone', () => {
	it('200s a small nudge from the anonymous device owner and writes the corrected pose', async () => {
		// ~1.1 m north, 10° yaw correction, +30 cm — all within the calibrate envelope.
		const newLat = ORIGIN.lat + 1.1 / M_PER_DEG_LAT;
		const { res, body } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: newLat, lng: ORIGIN.lng, anchorYawDeg: 100, anchorHeightM: 0.3 },
		});
		expect(res.statusCode).toBe(200);
		expect(body.calibrated).toBe(true);
		expect(body.pin.lat).toBeCloseTo(newLat, 9);
		expect(body.pin.anchor_yaw_deg).toBe(100);
		// heading mirrors the corrected yaw so legacy clients (heading-only) agree.
		expect(body.pin.heading).toBe(100);
		expect(body.pin.anchor_height_m).toBeCloseTo(0.3, 9);
	});

	it('200s the authenticated owner via session.id (calibrate routes before the auth gate)', async () => {
		pinRow.user_id = 'owner-uuid';
		pinRow.device_token = null;
		sessionUser = { id: 'owner-uuid' };
		const { res, body } = await patch({
			id: PIN_ID,
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, anchorYawDeg: 90 },
		});
		expect(res.statusCode).toBe(200);
		expect(body.calibrated).toBe(true);
	});

	it('treats yaw as wrap-around (340° vs stored 90° is 110° apart → rejected)', async () => {
		const { res } = await patch({
			id: PIN_ID, deviceToken: 'device-A',
			calibrate: { lat: ORIGIN.lat, lng: ORIGIN.lng, anchorYawDeg: 340 },
		});
		expect(res.statusCode).toBe(422);
	});
});
