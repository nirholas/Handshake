// /api/irl/pins — production hardening (tasks 11 / 12 / 13).
//
// These tests cover the backend-resilience + security-validation surface added to
// api/irl/pins.js: radius + pin-id validation, the limiter degradation policy (the
// public read fails CLOSED per H7; writes fail open), the Guardian degraded-state
// cache, the x402 allow-list parse, ownership + expiry on calibrate/outfit/delete,
// and the no-internal-detail outfit-bake error. The DB / auth / limiter / baker are
// mocked so the suite runs offline in Node.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted spy for the lazily-imported baker ────────────────────────────────
const { bakeSpy } = vi.hoisted(() => ({ bakeSpy: vi.fn() }));

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// `pinRow` is the row the WHERE-id SELECT returns (null → not found). Each mutation
// (calibrate UPDATE, outfit UPDATE, delete) is classified by its query text and
// honours the expiry/hidden guards the handler now appends to the WHERE clause —
// so a test can make a mutation "miss" by marking the row expired/hidden.
let pinRow = null;
let deleteResult = [{ id: 'del-1', lat: 1, lng: 2 }];

function pinIsLive(row) {
	if (!row) return false;
	if (row.hidden_at != null) return false;
	if (row.expires_at == null) return true;
	return new Date(row.expires_at).getTime() > Date.now();
}

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);

	// SELECT … WHERE id = $id (calibrate + outfit ownership lookup)
	if (/SELECT[\s\S]*FROM irl_pins[\s\S]*WHERE id =/i.test(q)) {
		return Promise.resolve(pinRow ? [pinRow] : []);
	}
	// Calibrate UPDATE — now guarded by hidden_at/expires_at; return a row only when live.
	if (/UPDATE irl_pins SET[\s\S]*anchor_yaw_deg\s*=\s*COALESCE/i.test(q)) {
		if (!pinIsLive(pinRow)) return Promise.resolve([]);
		const [lat, lng, yaw, heading, height, id] = values;
		return Promise.resolve([{
			id, lat, lng,
			heading:         heading ?? pinRow?.heading ?? null,
			anchor_yaw_deg:  yaw     ?? pinRow?.anchor_yaw_deg ?? null,
			anchor_height_m: height  ?? pinRow?.anchor_height_m ?? null,
			gps_accuracy_m:  pinRow?.gps_accuracy_m ?? null,
		}]);
	}
	// Outfit UPDATE — guarded too.
	if (/UPDATE irl_pins SET[\s\S]*avatar_version\s*=\s*avatar_version \+ 1/i.test(q)) {
		if (!pinIsLive(pinRow)) return Promise.resolve([]);
		const [manifestJson, , newAvatarUrl, id] = values;
		return Promise.resolve([{
			id, lat: pinRow?.lat ?? null, lng: pinRow?.lng ?? null,
			avatar_url: newAvatarUrl,
			avatar_manifest: manifestJson ? JSON.parse(manifestJson) : null,
			avatar_version: (Number(pinRow?.avatar_version) || 0) + 1,
		}]);
	}
	// DELETE … RETURNING id, lat, lng
	if (/DELETE FROM irl_pins/i.test(q)) {
		return Promise.resolve(deleteResult);
	}
	return Promise.resolve([]); // ensureTable DDL + anything else
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));

// Limiter mock with a throw switch so we can prove the call-site fail-open wrapper
// catches an outage instead of 500ing the request.
let limiterThrows = false;
function verdict() {
	if (limiterThrows) throw new Error('redis: max requests limit exceeded');
	return { success: true, reset: Date.now() + 60_000 };
}
// `irlNearbyIp` is the dedicated coordinate-read bucket the H7 sweep-cost numbers are
// computed against; `nearbyDenied` flips it to a plain (non-throwing) denial so we can
// prove the nearby branch actually consults it. limitFailClosedRead mirrors the real
// helper's contract; the real implementation is asserted against directly in
// tests/api/irl-nearby-limit.test.js.
let nearbyDenied = false;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp:     vi.fn(async () => verdict()),
		irlNearbyIp:  vi.fn(async () => (nearbyDenied ? { success: false, reset: Date.now() + 60_000 } : verdict())),
		irlPinIp:     vi.fn(async () => verdict()),
		irlPinBurst:  vi.fn(async () => verdict()),
		irlPinHourly: vi.fn(async () => verdict()),
	},
	limitFailClosedRead: async (_name, fn, ...args) => {
		try { return await fn(...args); }
		catch { return { success: false, reason: 'rate_limiter_unavailable', reset: Date.now() + 60_000 }; }
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/irl-bake.js', () => ({
	bakePinOutfit: (...a) => bakeSpy(...a),
	isBakeable: (m) => !!(m && (
		m.outfit ||
		(Array.isArray(m.accessories) && m.accessories.length) ||
		(m.morphs && Object.keys(m.morphs).length) ||
		(m.colors && Object.keys(m.colors).length) ||
		(Array.isArray(m.hidden) && m.hidden.length)
	)),
}));

const mod = await import('../../api/irl/pins.js');
const { default: handler, isValidPinId, isExpiredOrHidden, safePaymentEndpoint, guardianDegraded, resetGuardianDegraded } = mod;

const UUID = '11111111-1111-4111-8111-111111111111';

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
async function call(method, { query = {}, body } = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method, headers: { host: 'x' }, query, body }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}
const get    = (opts) => call('GET', opts);
const patch  = (body) => call('PATCH', { body });
const del    = (query) => call('DELETE', { query });

beforeEach(() => {
	sqlMock.mockClear();
	bakeSpy.mockReset();
	bakeSpy.mockResolvedValue({ url: 'https://three.ws/cdn/irl/pins/x/abc.glb' });
	deleteResult = [{ id: 'del-1', lat: 1, lng: 2 }];
	limiterThrows = false;
	nearbyDenied = false;
	sessionUser = null;
	resetGuardianDegraded();
	pinRow = {
		id: UUID, user_id: null, device_token: 'device-A',
		lat: 40.7128, lng: -74.006, heading: 90,
		anchor_yaw_deg: 90, anchor_height_m: 0, gps_accuracy_m: 12,
		avatar_url: '/api/avatars/av-1/glb', avatar_base_url: null, avatar_version: 0,
		expires_at: null, hidden_at: null,
	};
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('isValidPinId', () => {
	it('accepts a canonical UUID', () => {
		expect(isValidPinId(UUID)).toBe(true);
		expect(isValidPinId(UUID.toUpperCase())).toBe(true);
	});
	// `irl_pins.id` is a UUID COLUMN. A "URL-safe opaque id" used to be accepted
	// here, which handed non-UUID text straight to Postgres: the query died with
	// `invalid input syntax for type uuid` and the caller saw a 500 where this
	// guard exists to produce a 400. Anything that is not a UUID is rejected.
	it('rejects url-safe-but-not-UUID ids that the UUID column cannot cast', () => {
		expect(isValidPinId('pin-1')).toBe(false);
		expect(isValidPinId('del_1')).toBe(false);
		expect(isValidPinId('not-a-uuid')).toBe(false);
	});
	it('rejects empty / non-string / oversized / dangerous-shaped ids', () => {
		expect(isValidPinId('')).toBe(false);
		expect(isValidPinId(null)).toBe(false);
		expect(isValidPinId(123)).toBe(false);
		expect(isValidPinId('x'.repeat(5000))).toBe(false);  // oversized
		expect(isValidPinId('has space')).toBe(false);       // whitespace
		expect(isValidPinId('a/b')).toBe(false);             // path separator
		// SQL-injection-shaped id is rejected at the boundary (defense in depth).
		expect(isValidPinId("1' OR '1'='1")).toBe(false);
		expect(isValidPinId('drop;--')).toBe(false);
	});
});

describe('isExpiredOrHidden', () => {
	const now = Date.now();
	it('treats a NULL expiry as permanent (live)', () => {
		expect(isExpiredOrHidden({ expires_at: null, hidden_at: null }, now)).toBe(false);
	});
	it('treats a future expiry as live and a past expiry as gone', () => {
		expect(isExpiredOrHidden({ expires_at: new Date(now + 60_000).toISOString() }, now)).toBe(false);
		expect(isExpiredOrHidden({ expires_at: new Date(now - 60_000).toISOString() }, now)).toBe(true);
	});
	it('treats any hidden_at as gone regardless of expiry', () => {
		expect(isExpiredOrHidden({ expires_at: null, hidden_at: new Date(now).toISOString() }, now)).toBe(true);
	});
});

describe('safePaymentEndpoint — x402 allow-list (config validation)', () => {
	it('accepts a same-origin relative path (always first-party)', () => {
		expect(safePaymentEndpoint('/api/x402-pay')).toEqual({ ok: true, value: '/api/x402-pay' });
	});
	it('accepts a first-party host from the default allow-list', () => {
		const r = safePaymentEndpoint('https://three.ws/api/x402-pay');
		expect(r.ok).toBe(true);
	});
	it('rejects an arbitrary external host', () => {
		expect(safePaymentEndpoint('https://evil.example.com/drain').ok).toBe(false);
	});
	it('rejects a non-https / private-host endpoint', () => {
		expect(safePaymentEndpoint('http://three.ws/x').ok).toBe(false);
		expect(safePaymentEndpoint('https://127.0.0.1/x').ok).toBe(false);
	});
	it('passes a null/empty endpoint through as cleared', () => {
		expect(safePaymentEndpoint(null)).toEqual({ ok: true, value: null });
		expect(safePaymentEndpoint('')).toEqual({ ok: true, value: null });
	});
});

// ── GET radius validation (task 11) ──────────────────────────────────────────
describe('GET /api/irl/pins — radius validation', () => {
	it('400s a present-but-non-finite radius instead of silently scanning a NaN box', async () => {
		const { res, body } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: 'abc' } });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/invalid radius/i);
		// Never reached the pin SELECT — failed at the boundary.
		const ranSelect = sqlMock.mock.calls.some(([s]) =>
			/lat BETWEEN/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranSelect).toBe(false);
	});
	it('defaults a missing radius to 40 and 200s', async () => {
		const { res } = await get({ query: { lat: '40.7128', lng: '-74.006' } });
		expect(res.statusCode).toBe(200);
	});
});

// ── Pin-id validation on mutations (task 13) ─────────────────────────────────
describe('PATCH /api/irl/pins — pin-id validation', () => {
	it('400s a malformed id before any auth or DB work', async () => {
		const { res, body } = await patch({ id: "bad id'", calibrate: { lat: 40.7128, lng: -74.006 } });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/invalid pin id/i);
		const ranSelect = sqlMock.mock.calls.some(([s]) =>
			/WHERE id =/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranSelect).toBe(false);
	});
});

describe('DELETE /api/irl/pins — pin-id validation', () => {
	it('400s a malformed id before the delete query', async () => {
		const { res, body } = await del({ id: "bad id'", deviceToken: 'device-A' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/invalid pin id/i);
		const ranDelete = sqlMock.mock.calls.some(([s]) =>
			/DELETE FROM irl_pins/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranDelete).toBe(false);
	});
});

// ── PATCH x402 edit must enforce the SAME allow-list as POST (task 13) ────────
// Editing a pin can't be a back door around the first-party payment-host gate.
describe('PATCH /api/irl/pins — x402 edit honours the payment-host allow-list', () => {
	beforeEach(() => { sessionUser = { id: 'owner-uuid' }; });
	it('422s an arbitrary external x402 host on edit, never reaching the UPDATE', async () => {
		const { res, body } = await patch({ id: UUID, x402Endpoint: 'https://evil.example.com/drain' });
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('endpoint');
		expect(body.field).toBe('x402Endpoint');
		const ranEdit = sqlMock.mock.calls.some(([s]) =>
			/UPDATE irl_pins SET[\s\S]*x402_endpoint/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranEdit).toBe(false);
	});
	it('accepts a same-origin relative pay path on edit (passes the allow-list)', async () => {
		const { res } = await patch({ id: UUID, x402Endpoint: '/api/x402-pay' });
		// Allow-list accepted it — not a 422 endpoint rejection. (The mocked field-edit
		// UPDATE returns no row, so the handler then 404s; the point is it got past the gate.)
		expect(res.statusCode).not.toBe(422);
	});
});

// ── Expiry guard on mutations (task 13) ──────────────────────────────────────
describe('calibrate — refuses an expired pin', () => {
	it('404s an expired pin even for the owner, and never UPDATEs', async () => {
		pinRow.expires_at = new Date(Date.now() - 1000).toISOString();
		const { res, body } = await patch({
			id: UUID, deviceToken: 'device-A',
			calibrate: { lat: 40.7128, lng: -74.006 },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found/i);
		const ranUpdate = sqlMock.mock.calls.some(([s]) =>
			/UPDATE irl_pins SET[\s\S]*anchor_yaw_deg/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranUpdate).toBe(false);
	});
	it('200s a live pin for the owner', async () => {
		const { res, body } = await patch({
			id: UUID, deviceToken: 'device-A',
			calibrate: { lat: 40.7128, lng: -74.006, anchorYawDeg: 95 },
		});
		expect(res.statusCode).toBe(200);
		expect(body.calibrated).toBe(true);
	});
});

describe('outfit — refuses an expired pin', () => {
	beforeEach(() => {
		pinRow.user_id = 'owner-uuid';
		pinRow.device_token = null;
		sessionUser = { id: 'owner-uuid' };
	});
	it('404s an expired pin and never bakes', async () => {
		pinRow.expires_at = new Date(Date.now() - 1000).toISOString();
		const { res, body } = await patch({ id: UUID, avatar_manifest: { colors: { outfit: '#7a1f2b' } } });
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found/i);
		expect(bakeSpy).not.toHaveBeenCalled();
	});
	it('does NOT leak the upstream error message when a bake fails', async () => {
		bakeSpy.mockRejectedValueOnce(new Error('libvips: /secret/internal/path exploded'));
		const { res, body } = await patch({ id: UUID, avatar_manifest: { colors: { outfit: '#7a1f2b' } } });
		expect(res.statusCode).toBe(502);
		expect(body.error).toMatch(/could not bake/i);
		expect(body).not.toHaveProperty('detail');
		expect(JSON.stringify(body)).not.toMatch(/libvips|secret|internal|path/i);
	});
});

describe('delete — expiry-guarded WHERE', () => {
	it('returns the delete result for a live owned pin', async () => {
		const { res, body } = await del({ id: UUID, deviceToken: 'device-A' });
		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
	});
	it('404s when the guarded WHERE matches nothing (expired / not yours)', async () => {
		deleteResult = []; // the expiry/owner clause matched no row
		const { res, body } = await del({ id: UUID, deviceToken: 'device-A' });
		expect(res.statusCode).toBe(404);
		expect(body.error).toMatch(/not found|not yours/i);
	});
});

// ── Bulk purge (L5 — Remove all from this device) ────────────────────────────
describe('DELETE /api/irl/pins?all=1 — bulk device purge', () => {
	const deleteQueries = () => sqlMock.mock.calls
		.map(([s]) => (Array.isArray(s) ? s.join(' ') : String(s)))
		.filter((q) => /DELETE FROM irl_pins/i.test(q));

	it('purges every pin for the device token and returns the count', async () => {
		deleteResult = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const { res, body } = await del({ all: '1', deviceToken: 'device-A' });
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ ok: true, deleted: 3 });
	});

	it('scopes the purge to the device token only — strict IS NOT NULL guard, never by id', async () => {
		await del({ all: '1', deviceToken: 'device-A' });
		const q = deleteQueries().pop();
		expect(q).toBeTruthy();
		expect(q).toMatch(/device_token IS NOT NULL/i);
		expect(q).not.toMatch(/WHERE id =/i);
		// the bound parameter is exactly the caller's device token (no NULL/empty match)
		const call = sqlMock.mock.calls.find(([s]) =>
			/DELETE FROM irl_pins/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(call.slice(1)).toContain('device-A');
	});

	it('400s a bulk delete with no device token and never runs the delete', async () => {
		const { res, body } = await del({ all: '1' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toMatch(/device.?token/i);
		expect(deleteQueries()).toHaveLength(0);
	});

	it('leaves the single-id delete path unchanged (id-scoped WHERE)', async () => {
		const { res, body } = await del({ id: UUID, deviceToken: 'device-A' });
		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
		expect(deleteQueries().pop()).toMatch(/WHERE id =/i);
	});
});

// ── Rate-limiter degradation: read fails CLOSED, writes fail OPEN (task 12 + H7) ─
describe('rate limiter degradation', () => {
	it('a throwing limiter FAILS CLOSED on the public GET read — 429, never an unmetered scrape (H7)', async () => {
		limiterThrows = true;
		const { res, body } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: '40' } });
		// The nearby read is the ONLY surface that reveals another agent's location, so a
		// limiter it can't evaluate must DENY (retryable), never open an unmetered read.
		expect(res.statusCode).toBe(429);
		expect(body.reason).toBe('rate_limiter_unavailable');
		// Denied before any location data left the DB — the pin SELECT never ran.
		const ranSelect = sqlMock.mock.calls.some(([s]) =>
			/lat BETWEEN/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranSelect).toBe(false);
	});
	it('the nearby read is bounded by the DEDICATED coordinate bucket, not just the shared public one (H7)', async () => {
		// The generic public read ceiling is tuned for page-load fan-out and has been
		// raised for reasons unrelated to location privacy. The grid-sweep cost in the
		// threat model is computed from `irlNearbyIp`, so the branch must actually
		// consult it and deny on it.
		nearbyDenied = true;
		const { res } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: '40' } });
		expect(res.statusCode).toBe(429);
		const ranSelect = sqlMock.mock.calls.some(([s]) =>
			/lat BETWEEN/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(ranSelect).toBe(false);
	});
	it('a throwing limiter does not 500 a DELETE — write fails open, ownership still enforced (task 12)', async () => {
		limiterThrows = true;
		const { res } = await del({ id: UUID, deviceToken: 'device-A' });
		// Writes are bounded by the DB density/owner caps even when the limiter is blind,
		// so an infra hiccup must never block a legitimate placement/removal.
		expect(res.statusCode).toBe(200);
	});
});

// ── Guardian degraded cache (task 12) ────────────────────────────────────────
describe('guardian degraded state', () => {
	it('starts not-degraded and resets cleanly', () => {
		resetGuardianDegraded();
		expect(guardianDegraded()).toBe(false);
	});
});
