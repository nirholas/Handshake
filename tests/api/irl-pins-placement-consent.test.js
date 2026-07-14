// POST /api/irl/pins { placement, fuzzRadiusM } — H4 placement consent + approximate.
//
// A placer chooses whether the agent sits at their EXACT spot or is deliberately
// blurred to a random point within a chosen radius. The CLIENT computes the fuzzed
// coordinate it sends; the server only records the CONSENT (placement_kind) + the
// radius it was blurred by — it never receives or stores the true precise fix for an
// approximate placement. These tests pin the POST handler's parse + validation:
// the kind allow-list, the radius clamp band, the 'precise' default for old clients,
// and that a precise placement carries no fuzz radius. DB/auth/limiter/guardian are
// mocked so the suite stays fully offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock — the INSERT echoes its bound values back as columns so
// the success-path assertions read the EXACT coerced placement fields persisted.
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/count\(\*\)::int/i.test(q)) return Promise.resolve([{ n: 0 }]);
	if (/INSERT INTO irl_pins/i.test(q)) {
		// Column order mirrors the handler's INSERT … VALUES list.
		const [
			user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint, expires_at,
			anchor_height_m, anchor_yaw_deg, anchor_quat, anchor_scale,
			gps_accuracy_m, altitude_m, anchor_source, geocell7,
			room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg,
			placement_kind, fuzz_radius_m, vps_provider, vps_id,
		] = values;
		return Promise.resolve([{
			id: 'pin-new', user_id, agent_id, device_token, lat, lng, heading,
			avatar_url, avatar_name, caption, x402_endpoint,
			placed_at: '2026-06-23T00:00:00Z', expires_at,
			placement_kind, fuzz_radius_m,
			view_count: 0, avatar_version: 0,
		}]);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		irlPinIp:     vi.fn(async () => ({ success: true })),
		irlPinBurst:  vi.fn(async () => ({ success: true })),
		irlPinHourly: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/granite-guardian.js', () => ({
	guardianConfig: () => ({ configured: false }),
	assess: vi.fn(),
	decide: vi.fn(),
}));

const { default: handler } = await import('../../api/irl/pins.js');

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
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const basePin = () => ({
	lat: ORIGIN.lat, lng: ORIGIN.lng, heading: 0,
	avatarUrl: '/avatars/default.glb', avatarName: 'Scout', deviceToken: 'device-A',
});

beforeEach(() => { sqlMock.mockClear(); sessionUser = null; });

describe('POST /api/irl/pins — placement consent + approximate (H4)', () => {
	it("defaults to 'precise' with no fuzz radius for an old client that sends neither", async () => {
		const { res, body } = await post(basePin());
		expect(res.statusCode).toBe(201);
		expect(body.pin.placement_kind).toBe('precise');
		expect(body.pin.fuzz_radius_m).toBeNull();
	});

	it("stores an approximate placement with the consent + the chosen radius", async () => {
		const { res, body } = await post({ ...basePin(), placement: 'approximate', fuzzRadiusM: 100 });
		expect(res.statusCode).toBe(201);
		expect(body.pin.placement_kind).toBe('approximate');
		expect(body.pin.fuzz_radius_m).toBe(100);
	});

	it("never attaches a fuzz radius to a precise placement, even if one is sent", async () => {
		const { body } = await post({ ...basePin(), placement: 'precise', fuzzRadiusM: 250 });
		expect(body.pin.placement_kind).toBe('precise');
		expect(body.pin.fuzz_radius_m).toBeNull();
	});

	it("clamps the fuzz radius to the sane band (>= FUZZ_MIN_M, <= FUZZ_MAX_M)", async () => {
		const { body: tooSmall } = await post({ ...basePin(), placement: 'approximate', fuzzRadiusM: 1 });
		expect(tooSmall.pin.fuzz_radius_m).toBe(10);  // FUZZ_MIN_M
		const { body: tooBig } = await post({ ...basePin(), placement: 'approximate', fuzzRadiusM: 99999 });
		expect(tooBig.pin.fuzz_radius_m).toBe(500);   // FUZZ_MAX_M
	});

	it("treats an unknown placement kind as 'precise' (allow-list, never store noise)", async () => {
		const { body } = await post({ ...basePin(), placement: 'somewhere-ish', fuzzRadiusM: 100 });
		expect(body.pin.placement_kind).toBe('precise');
		expect(body.pin.fuzz_radius_m).toBeNull();
	});

	it("accepts the snake_case field names too (placement_kind / fuzz_radius_m)", async () => {
		const { body } = await post({ ...basePin(), placement_kind: 'approximate', fuzz_radius_m: 30 });
		expect(body.pin.placement_kind).toBe('approximate');
		expect(body.pin.fuzz_radius_m).toBe(30);
	});

	it("requires a finite radius for approximate — a non-numeric radius drops to null", async () => {
		const { body } = await post({ ...basePin(), placement: 'approximate', fuzzRadiusM: 'abc' });
		expect(body.pin.placement_kind).toBe('approximate');
		expect(body.pin.fuzz_radius_m).toBeNull();
	});
});
