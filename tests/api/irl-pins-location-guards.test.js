// GET /api/irl/pins — location-privacy guards.
//
// Placed agents are private by location: another agent's coordinates are revealed
// ONLY through the per-viewer nearby read, and only for the handful physically
// within a tight radius of the caller. This locks in the guarantees that make
// that true:
//   1. There is NO bulk window feed. A `bbox` query is not a special path — it
//      falls through to the nearby branch and 400s without lat/lng, never
//      returning a multi-pin neighbourhood roster.
//   2. The discovery radius is HARD-CAPPED small server-side, so even a crafted
//      huge radius only ever scans a tight box around the caller.
//   3. The public nearby feed is IP rate-limited (so it can't be gridded into a
//      scrape) and never projects owner identifiers.
//   4. The /mine feed (which DOES return coordinates) is strictly owner-scoped:
//      a guessed device token surfaces nothing — coordinates leave only for the
//      caller's OWN pins.
//   5. Pin mutations (report / calibrate / edit) carry NO realtime publish path:
//      a placement's coordinates are never fanned out to a room, so neither is a
//      removal. The handlers import no colyseus / room / publish module.
// DB / auth / limiter are mocked so the suite stays offline.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PIN = {
	id: 'pin-1', user_id: 'owner-1', device_token: 'dev-1', agent_id: null,
	lat: 40.7128, lng: -74.006, heading: 0,
	avatar_url: null, avatar_name: 'Aria', caption: 'hi', x402_endpoint: null,
	placed_at: '2026-01-01T00:00:00Z', view_count: 0,
	anchor_height_m: null, anchor_yaw_deg: null, anchor_quat: null,
	gps_accuracy_m: null, altitude_m: null, anchor_source: null, avatar_version: 0,
	room_id: null, rel_east_m: null, rel_north_m: null,
	origin_lat: null, origin_lng: null, origin_yaw_deg: null,
};

// The owner's own /mine row shape (the projection the /mine SELECT returns). This
// is the only place coordinates leave for an authenticated owner/device.
const MINE_ROW = {
	id: 'pin-1', lat: 40.7128, lng: -74.006, avatar_name: 'Aria', caption: 'hi',
	placed_at: '2026-01-01T00:00:00Z', expires_at: null, view_count: 0,
};

// The nearby pin SELECT carries `FROM irl_pins` + `lat BETWEEN`; return one
// in-range pin for it and [] for everything else (ensureTable DDL etc). The /mine
// owner-scoped SELECT is modelled as a one-pin store owned by device 'dev-1':
// it yields the row ONLY when the caller's interpolated identifier actually matches
// the owner, so a guessed token (which interpolates a value that doesn't) gets [].
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM\s+irl_pins/i.test(q) && /lat BETWEEN/i.test(q)) return Promise.resolve([PIN]);
	if (/FROM\s+irl_pins/i.test(q) && /device_token\s*=/i.test(q) && /LIMIT 20/i.test(q)) {
		const owns = values.includes(PIN.device_token) || values.includes(PIN.user_id);
		return Promise.resolve(owns ? [MINE_ROW] : []);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));

let publicVerdict = { success: true, reset: Date.now() + 60_000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => publicVerdict),
		irlNearbyIp: vi.fn(async () => publicVerdict),
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
async function get({ query = {}, headers = {} } = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'GET', headers: { host: 'x', ...headers }, query }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}
async function getMine({ query = {}, headers = {} } = {}) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins/mine', method: 'GET', headers: { host: 'x', ...headers }, query }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}
// The nearby SELECT is interpolated `WHERE lat BETWEEN ${latLo} AND ${latHi} AND
// lng BETWEEN ${lngLo} AND ${lngHi} …`, so its call args are [strings, latLo,
// latHi, lngLo, lngHi]. Return that call (or null) so a test can inspect the box.
function nearbySelectCall() {
	return sqlMock.mock.calls.find(([s]) => {
		const q = Array.isArray(s) ? s.join(' ') : String(s);
		return /FROM\s+irl_pins/i.test(q) && /lat BETWEEN/i.test(q);
	}) || null;
}
function ranPinSelect() {
	return nearbySelectCall() !== null;
}
// The /mine owner-scoped SELECT (device_token = … OR user_id = …, LIMIT 20). True
// only when the handler actually reached the owner read — distinct from the DDL
// `ensureTable()` calls that run on every request.
function ranMineSelect() {
	return sqlMock.mock.calls.some(([s]) => {
		const q = Array.isArray(s) ? s.join(' ') : String(s);
		return /FROM\s+irl_pins/i.test(q) && /device_token\s*=/i.test(q) && /LIMIT 20/i.test(q);
	});
}

beforeEach(() => {
	sqlMock.mockClear();
	publicVerdict = { success: true, reset: Date.now() + 60_000 };
});

describe('GET /api/irl/pins — no bulk location window', () => {
	it('treats a bbox param as a normal query: 400s without lat/lng, never reads pins', async () => {
		const { res } = await get({ query: { bbox: '40.70,-74.02,40.73,-73.99' } });
		expect(res.statusCode).toBe(400);
		expect(ranPinSelect()).toBe(false);
	});

	it('grants no special access for the old internal-hydration header', async () => {
		// The shared-secret window feed is gone — a bbox + secret header is just a
		// query missing lat/lng, so it 400s like any other and reads nothing.
		const { res } = await get({
			query: { bbox: '40.70,-74.02,40.73,-73.99' },
			headers: { 'x-mp-internal': 'any-secret-at-all' },
		});
		expect(res.statusCode).toBe(400);
		expect(ranPinSelect()).toBe(false);
	});
});

describe('GET /api/irl/pins — tight proximity radius', () => {
	it('hard-caps the radius so a huge requested radius still scans a tiny box', async () => {
		const { res } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: '100000' } });
		expect(res.statusCode).toBe(200);
		const call = nearbySelectCall();
		expect(call).not.toBeNull();
		const [, latLo, latHi] = call;
		// 60 m cap → half-window 60/110540 ≈ 0.00054°, so the full lat span is ~0.0011°.
		// Assert it's well under ~150 m (0.0027°) — proves the requested 100 km was clamped.
		expect(latHi - latLo).toBeLessThan(0.0027);
	});
});

describe('GET /api/irl/pins — public nearby feed', () => {
	it('200s a normal nearby query, consults the limiter, and hides owner identifiers', async () => {
		const { limits } = await import('../../api/_lib/rate-limit.js');
		limits.publicIp.mockClear();
		const { res, body } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: '40' } });
		expect(res.statusCode).toBe(200);
		expect(body.pins[0].id).toBe('pin-1');
		// Owner identifiers are never projected into the public feed.
		expect(body.pins[0]).not.toHaveProperty('user_id');
		expect(body.pins[0]).not.toHaveProperty('device_token');
		expect(limits.publicIp).toHaveBeenCalledTimes(1);
	});

	it('429s the nearby feed when the public limiter is exhausted, before any DB read', async () => {
		publicVerdict = { success: false, reset: Date.now() + 30_000 };
		const { res } = await get({ query: { lat: '40.7128', lng: '-74.006', radius: '40' } });
		expect(res.statusCode).toBe(429);
		expect(ranPinSelect()).toBe(false);
	});
});

describe('GET /api/irl/pins/mine — owner-scoped, no cross-user coordinate leak', () => {
	it('returns the OWN pin (with coordinates) for the device that actually placed it', async () => {
		// The placing device sees its own pin — coordinates included — so it can manage it.
		const { res, body } = await getMine({ query: { deviceToken: 'dev-1' } });
		expect(res.statusCode).toBe(200);
		expect(body.pins).toHaveLength(1);
		expect(body.pins[0].id).toBe('pin-1');
		expect(body.pins[0].lat).toBe(40.7128);
	});

	it('a GUESSED device token surfaces NOTHING — never another owner’s coordinates', async () => {
		// The attack: enumerate /mine with a fabricated token hoping to read someone
		// else's placement. The owner-scoped WHERE clause matches the guessed value,
		// not the real owner, so the store yields [] — no row, no lat/lng.
		const { res, body } = await getMine({ query: { deviceToken: 'totally-guessed-token' } });
		expect(res.statusCode).toBe(200);
		expect(body.pins).toEqual([]);
		// And it never fell through to the bulk nearby roster read to find them.
		expect(ranPinSelect()).toBe(false);
	});

	it('400s a /mine call with no identifier at all, before the owner read', async () => {
		const { res } = await getMine({ query: {} });
		expect(res.statusCode).toBe(400);
		// The owner-scoped SELECT never ran — a caller with no identifier can't probe.
		expect(ranMineSelect()).toBe(false);
	});
});

// ── Structural fence: pin mutations carry no realtime publish path ───────────────
// Task 07 acceptance: a placement's coordinates are never broadcast to a room, so a
// removal isn't either. The mutation handlers (report / calibrate / edit) must import
// no colyseus / matchMaker / room / publish module — if a future edit re-wires one in
// to "push a pin removal/placement live", the privacy invariant reopens and this fails.
describe('pin-mutation handlers — no realtime publish module imported', () => {
	const FORBIDDEN_IMPORT = /import[^\n]*from\s*['"][^'"]*(?:colyseus|matchMaker|match-maker|IrlRoom|\/rooms\/|publish|broadcast|window-feed)[^'"]*['"]/i;

	const sources = {
		'api/irl/report.js': readFileSync(resolve(__dirname, '../../api/irl/report.js'), 'utf8'),
		'api/irl/pins.js':   readFileSync(resolve(__dirname, '../../api/irl/pins.js'), 'utf8'),
	};

	for (const [file, src] of Object.entries(sources)) {
		it(`${file} imports no colyseus / room / publish module`, () => {
			const offending = src.split('\n').filter((l) => FORBIDDEN_IMPORT.test(l));
			expect(offending).toEqual([]);
		});

		it(`${file} makes no pin broadcast / room-publish call`, () => {
			// No `broadcast('pin…')`, `room.send`, `matchMaker.…`, or a pin:remove publish.
			expect(src).not.toMatch(/broadcast\s*\(\s*['"`](?:pin|pins|roster|window)/i);
			expect(src).not.toMatch(/matchMaker\./);
			expect(src).not.toMatch(/\bpin:remove\b/);
		});
	}
});
