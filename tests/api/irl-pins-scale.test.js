// PATCH /api/irl/pins { scale } — pinch-to-resize persistence.
//
// A pinch during the WebXR placement session usually happens AFTER the pin was
// persisted on the placement tap, so the final size arrives as an owner-gated
// PATCH. Because a resized agent re-renders at that size for EVERY nearby
// viewer, the server is the security boundary: it must reject non-owners,
// refuse expired/hidden pins, and clamp the scale to the same 0.25–4 band the
// gesture and the POST path enforce. The DB / auth / limiter are mocked so the
// suite stays offline — mirrors tests/api/irl-pins-calibrate.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock: the ownership SELECT returns `pinRow` (null →
// "not found"); the UPDATE echoes back the bound scale so success-path
// assertions see exactly what would persist.
let pinRow = null;
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/SELECT[\s\S]*FROM irl_pins[\s\S]*WHERE id =/i.test(q)) {
		return Promise.resolve(pinRow ? [pinRow] : []);
	}
	if (/UPDATE irl_pins SET anchor_scale/i.test(q)) {
		const [scale, id] = values;
		return Promise.resolve([{ id, anchor_scale: scale }]);
	}
	// CREATE TABLE / ALTER TABLE / CREATE INDEX from ensureTable(), and anything else.
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { irlPinIp: vi.fn(async () => ({ success: true })) },
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
async function patch(body) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'PATCH', headers: { host: 'x' }, query: {}, body }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockClear();
	sessionUser = null;
	pinRow = {
		id: 'pin-1',
		user_id: null,
		device_token: 'device-A',
		expires_at: null,
		hidden_at: null,
	};
});

describe('PATCH /api/irl/pins { scale } — resize persistence', () => {
	it('lets the placing device resize its own pin', async () => {
		const { res, body } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 2.5 });
		expect(res.statusCode).toBe(200);
		expect(body.pin.anchor_scale).toBe(2.5);
	});

	it('lets the authenticated owner resize', async () => {
		pinRow.user_id = 'owner-uuid';
		pinRow.device_token = null;
		sessionUser = { id: 'owner-uuid' };
		const { res, body } = await patch({ id: 'pin-1', scale: 0.5 });
		expect(res.statusCode).toBe(200);
		expect(body.pin.anchor_scale).toBe(0.5);
	});

	it('rejects a non-owner — resizing someone else’s agent is denied, never silent', async () => {
		const { res } = await patch({ id: 'pin-1', deviceToken: 'device-EVIL', scale: 4 });
		expect(res.statusCode).toBe(403);
	});

	it('clamps to the shared 0.25–4 band', async () => {
		const { body: huge } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 100 });
		expect(huge.pin.anchor_scale).toBe(4);
		const { body: tiny } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 0.001 });
		expect(tiny.pin.anchor_scale).toBe(0.25);
	});

	it('stores NULL for natural size (scale 1) so legacy readers see no change', async () => {
		const { res, body } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 1 });
		expect(res.statusCode).toBe(200);
		expect(body.pin.anchor_scale).toBeNull();
	});

	it('rejects garbage scales', async () => {
		const { res: nan } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 'big' });
		expect(nan.statusCode).toBe(400);
		const { res: neg } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: -2 });
		expect(neg.statusCode).toBe(400);
	});

	it('refuses an expired or hidden pin (nobody would ever see the new size)', async () => {
		pinRow.expires_at = '2020-01-01T00:00:00Z';
		const { res: expired } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 2 });
		expect(expired.statusCode).toBe(404);
		pinRow.expires_at = null;
		pinRow.hidden_at = '2026-01-01T00:00:00Z';
		const { res: hidden } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 2 });
		expect(hidden.statusCode).toBe(404);
	});

	it('404s on a pin that does not exist', async () => {
		pinRow = null;
		const { res } = await patch({ id: 'pin-1', deviceToken: 'device-A', scale: 2 });
		expect(res.statusCode).toBe(404);
	});
});
