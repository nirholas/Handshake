// POST /api/irl/pins { anchor } — IRL-Live A2 anchor-pose persistence.
//
// A2 extends a placement from a 2D dot + compass heading to a full, reproducible
// anchor pose: floor height, orientation, and the GPS-fix trust metadata. That
// pose is the foundation A1 (WebXR anchors), A3 (everyone sees the agent in the
// same real-world spot), and A4 (gyro-lock replay) all build on, so the POST
// handler's capture + coercion of it is worth pinning down. These tests prove:
// a present pose persists, an old client with no `anchor` still creates a valid
// pin (NULL pose), and out-of-range values coerce/clamp rather than store noise.
// The DB / auth / limiter / guardian are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock: classify each tagged-template query by its text so
// ensureTable()'s DDL, the density + owner-cap counts, and the INSERT each return
// the right shape regardless of call order. The INSERT echoes its bound values
// back as columns so success-path assertions see the EXACT coerced pose persisted.
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	// Density cap + per-owner cap both select count(*)::int — return 0 so neither trips.
	if (/count\(\*\)::int/i.test(q)) {
		return Promise.resolve([{ n: 0 }]);
	}
	if (/INSERT INTO irl_pins/i.test(q)) {
		const [
			user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint, expires_at,
			anchor_height_m, anchor_yaw_deg, anchor_quat, anchor_scale,
			gps_accuracy_m, altitude_m, anchor_source, geocell7,
		] = values;
		return Promise.resolve([{
			id: 'pin-new', user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint,
			placed_at: '2026-06-17T00:00:00Z', expires_at,
			anchor_height_m, anchor_yaw_deg, anchor_quat, anchor_scale,
			gps_accuracy_m, altitude_m, anchor_source, geocell7,
			view_count: 0, avatar_version: 0,
		}]);
	}
	// CREATE TABLE / ALTER TABLE / CREATE INDEX from ensureTable(), and anything else.
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// Anonymous by default (the common IRL placement); a test can flip to a session.
let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

// All three placement limiters pass — A2 is about pose, not throttling.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		irlPinIp:     vi.fn(async () => ({ success: true })),
		irlPinBurst:  vi.fn(async () => ({ success: true })),
		irlPinHourly: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

// Keep the AI content tier off so a captioned pin never reaches watsonx in CI.
vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }),
	assess: vi.fn(),
	decide: vi.fn(),
}));

const { default: handler } = await import('../../api/irl/pins.js');

const ORIGIN = { lat: 40.7128, lng: -74.006 };

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
async function post(body) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'POST', headers: { host: 'x' }, query: {}, body }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const basePin = () => ({
	lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 270,
	avatarUrl: '/avatars/default.glb', avatarName: 'Scout',
	deviceToken: 'device-A',
});

beforeEach(() => {
	sqlMock.mockClear();
	sessionUser = null;
});

describe('POST /api/irl/pins — anchor pose persistence (A2)', () => {
	it('stores a full pose when the client sends one', async () => {
		const { res, body } = await post({
			...basePin(),
			anchor: { heightM: 1.5, yawDeg: 270, quat: [0, 0, 0, 1], gpsAccuracyM: 8, altitudeM: 30.2, source: 'webxr' },
		});
		expect(res.statusCode).toBe(201);
		const p = body.pin;
		expect(p.anchor_height_m).toBe(1.5);
		expect(p.anchor_yaw_deg).toBe(270);
		expect(p.anchor_quat).toBe(JSON.stringify([0, 0, 0, 1]));
		expect(p.gps_accuracy_m).toBe(8);
		expect(p.altitude_m).toBe(30.2);
		expect(p.anchor_source).toBe('webxr');
	});

	it('creates a valid pin with NULL pose for an old client (no anchor) — back-compat', async () => {
		const { res, body } = await post(basePin());
		expect(res.statusCode).toBe(201);
		const p = body.pin;
		expect(p.anchor_height_m).toBeNull();
		expect(p.anchor_yaw_deg).toBeNull();
		expect(p.anchor_quat).toBeNull();
		expect(p.gps_accuracy_m).toBeNull();
		expect(p.altitude_m).toBeNull();
		// Source defaults to the gyro path, never null — A3 needs to know how it was placed.
		expect(p.anchor_source).toBe('gyro-gps');
		// The pin itself is fully valid.
		expect(p.lat).toBeCloseTo(ORIGIN.lat, 9);
		expect(p.permanent).toBe(false); // anonymous → 7-day expiry
	});

	it('coerces an absurd floor height (> ±50 m) to NULL rather than storing noise', async () => {
		const { body: tooHigh } = await post({ ...basePin(), anchor: { heightM: 80, yawDeg: 10 } });
		expect(tooHigh.pin.anchor_height_m).toBeNull();
		const { body: tooLow } = await post({ ...basePin(), anchor: { heightM: -120, yawDeg: 10 } });
		expect(tooLow.pin.anchor_height_m).toBeNull();
		// A sane height on the boundary is kept.
		const { body: ok } = await post({ ...basePin(), anchor: { heightM: -2.5, yawDeg: 10 } });
		expect(ok.pin.anchor_height_m).toBe(-2.5);
	});

	it('clamps GPS accuracy to a sane 0–500 m band', async () => {
		const { body: huge } = await post({ ...basePin(), anchor: { gpsAccuracyM: 9999, source: 'gyro-gps' } });
		expect(huge.pin.gps_accuracy_m).toBe(500);
		const { body: neg } = await post({ ...basePin(), anchor: { gpsAccuracyM: -5, source: 'gyro-gps' } });
		expect(neg.pin.gps_accuracy_m).toBe(0);
		const { body: ok } = await post({ ...basePin(), anchor: { gpsAccuracyM: 12.4, source: 'gyro-gps' } });
		expect(ok.pin.gps_accuracy_m).toBe(12.4);
	});

	it('normalizes anchor yaw into 0–359°', async () => {
		const { body: neg } = await post({ ...basePin(), anchor: { yawDeg: -10 } });
		expect(neg.pin.anchor_yaw_deg).toBe(350);
		const { body: over } = await post({ ...basePin(), anchor: { yawDeg: 730 } });
		expect(over.pin.anchor_yaw_deg).toBe(10);
	});

	it('drops a malformed quaternion to NULL and only honours the known anchor sources', async () => {
		// Wrong length / non-finite → NULL (we never store a half-orientation).
		const { body: badQuat } = await post({ ...basePin(), anchor: { quat: [0, 0, 1], source: 'webxr' } });
		expect(badQuat.pin.anchor_quat).toBeNull();
		expect(badQuat.pin.anchor_source).toBe('webxr');
		// The page-relative gyro variant (A3 down-weights it) is preserved verbatim.
		const { body: rel } = await post({ ...basePin(), anchor: { source: 'gyro-gps:rel' } });
		expect(rel.pin.anchor_source).toBe('gyro-gps:rel');
		// Any unknown source collapses to the safe gyro default.
		const { body: weird } = await post({ ...basePin(), anchor: { source: 'made-up' } });
		expect(weird.pin.anchor_source).toBe('gyro-gps');
	});

	it('persists a pinch-resized scale, clamped to the 0.25–4 band', async () => {
		const { body: ok } = await post({ ...basePin(), anchor: { source: 'webxr', scale: 2.5 } });
		expect(ok.pin.anchor_scale).toBe(2.5);
		const { body: huge } = await post({ ...basePin(), anchor: { source: 'webxr', scale: 50 } });
		expect(huge.pin.anchor_scale).toBe(4);
		const { body: tiny } = await post({ ...basePin(), anchor: { source: 'webxr', scale: 0.01 } });
		expect(tiny.pin.anchor_scale).toBe(0.25);
	});

	it('stores NULL scale for natural size, absent scale, and garbage — never noise', async () => {
		const { body: natural } = await post({ ...basePin(), anchor: { source: 'webxr', scale: 1 } });
		expect(natural.pin.anchor_scale).toBeNull();
		const { body: absent } = await post({ ...basePin(), anchor: { source: 'webxr' } });
		expect(absent.pin.anchor_scale).toBeNull();
		const { body: garbage } = await post({ ...basePin(), anchor: { source: 'webxr', scale: 'big' } });
		expect(garbage.pin.anchor_scale).toBeNull();
		const { body: negative } = await post({ ...basePin(), anchor: { source: 'webxr', scale: -3 } });
		expect(negative.pin.anchor_scale).toBeNull();
	});

	it('persists pose for an authenticated owner and marks the pin permanent', async () => {
		sessionUser = { id: 'owner-uuid' };
		const { res, body } = await post({
			...basePin(),
			anchor: { heightM: 0, yawDeg: 90, gpsAccuracyM: 6, source: 'gyro-gps' },
		});
		expect(res.statusCode).toBe(201);
		expect(body.pin.user_id).toBe('owner-uuid');
		expect(body.pin.permanent).toBe(true); // signed-in → no expiry
		expect(body.pin.anchor_yaw_deg).toBe(90);
		expect(body.pin.gps_accuracy_m).toBe(6);
	});
});
