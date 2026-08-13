// POST /api/irl/share (api/irl/share.js): minting a permanent, unfurlable link
// for an AR capture the owner just took.
//
// Drives the real handler against an in-memory fake `sql` and a stubbed object
// store. The ownership check, the visibility gate, and the id validation are all
// REAL, so a regression in any of them fails here.
//
// Regression pinned: a pinId that is not a UUID used to reach Postgres through
// the `${pinId}::uuid` cast and come back as `invalid input syntax for type
// uuid`, which the boundary turned into a 500 + support ref for a request whose
// only fault was a typo. It must answer the designed 400 without ever querying.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const PIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER_DEVICE = 'device-owner-1';

let db;
function resetDb(pinOverrides = {}) {
	db = {
		pin: {
			id: PIN_ID, lat: 40.7484, lng: -73.9857, caption: 'Front desk',
			avatar_name: 'Lobby Guide', published: true, hidden_at: null,
			user_id: null, device_token: OWNER_DEVICE, ...pinOverrides,
		},
		shares: [],
		events: [],
	};
}

const fakeSql = vi.fn(async (strings, ...values) => {
	const q = strings.join('§').replace(/\s+/g, ' ');
	const has = (s) => q.includes(s);
	if (has('CREATE TABLE') || has('CREATE INDEX')) return [];
	if (has('FROM irl_pins WHERE id =')) {
		return values[0] === db.pin.id ? [db.pin] : [];
	}
	if (has('INSERT INTO irl_pin_shares')) {
		const [pin_id, token, image_key, image_url, device_hash] = values;
		db.shares.push({ pin_id, token, image_key, image_url, device_hash });
		return [];
	}
	if (has('INSERT INTO irl_events')) {
		db.events.push({ type: values[0], pin_id: values[1], geocell7: values[2] });
		return [];
	}
	return [];
});

const putObject = vi.fn(async () => {});

vi.mock('../../api/_lib/db.js', () => ({
	sql: fakeSql, isDbUnavailableError: () => false, isDbCapacityError: () => false,
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => async () => ({ success: true }) }),
	clientIp: () => '1.2.3.4',
}));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));
// The object store is the one genuinely external dependency; everything else the
// handler touches (hashing, validation, event logging) runs for real.
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...args) => putObject(...args),
	publicUrl: (key) => `https://three.ws/cdn/${key}`,
}));

const handler = (await import('../../api/irl/share.js')).default;

function call({ pinId, device = OWNER_DEVICE, bytes = 4096, method = 'POST' }) {
	const body = Buffer.alloc(bytes, 7);
	const req = Readable.from(bytes ? [body] : []);
	req.method = method;
	req.url = `/api/irl/share${pinId == null ? '' : `?pinId=${encodeURIComponent(pinId)}`}`;
	req.headers = {
		host: 'three.ws',
		'content-type': 'application/octet-stream',
		'content-length': String(bytes),
		...(device ? { 'x-irl-device': device } : {}),
	};
	req.socket = { remoteAddress: '1.2.3.4' };
	const res = {
		statusCode: 0, _body: null, _h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b ?? null; },
		get headersSent() { return this._body !== null; },
		get writableEnded() { return this._body !== null; },
	};
	return handler(req, res).then(() => ({
		status: res.statusCode,
		body: res._body ? JSON.parse(res._body) : null,
	}));
}

beforeEach(() => {
	resetDb();
	fakeSql.mockClear();
	putObject.mockClear();
});

describe('POST /api/irl/share', () => {
	it('mints a token, uploads the capture, and returns the share url', async () => {
		const r = await call({ pinId: PIN_ID });
		expect(r.status).toBe(201);
		expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
		expect(r.body.url).toBe(`https://three.ws/irl/s/${r.body.token}`);
		expect(r.body.imageUrl).toBe(`https://three.ws/cdn/irl-share/${r.body.token}.png`);
		expect(putObject).toHaveBeenCalledTimes(1);
		expect(putObject.mock.calls[0][0].contentType).toBe('image/png');
		expect(db.shares).toHaveLength(1);
		expect(db.shares[0].pin_id).toBe(PIN_ID);
		// The stored device hash is the irreversible digest, never the raw token.
		expect(db.shares[0].device_hash).not.toBe(OWNER_DEVICE);
		expect(db.events.map((e) => e.type)).toContain('share_created');
	});

	it('rejects a malformed pinId with a 400 before it ever reaches the database', async () => {
		const r = await call({ pinId: "' OR 1=1--" });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('bad_request');
		expect(fakeSql).not.toHaveBeenCalled();
	});

	it('requires a pinId', async () => {
		const r = await call({ pinId: null });
		expect(r.status).toBe(400);
		expect(fakeSql).not.toHaveBeenCalled();
	});

	it('refuses an anonymous caller with no session and no device token', async () => {
		const r = await call({ pinId: PIN_ID, device: null });
		expect(r.status).toBe(401);
	});

	it('refuses a caller who does not own the pin', async () => {
		const r = await call({ pinId: PIN_ID, device: 'device-stranger' });
		expect(r.status).toBe(403);
		expect(db.shares).toHaveLength(0);
	});

	it('refuses to turn a private placement into a public link', async () => {
		resetDb({ published: false });
		const r = await call({ pinId: PIN_ID });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('not_shareable');
		// The copy has to tell the owner what to DO: publish the pin.
		expect(r.body.error_description).toMatch(/public/);
		expect(db.shares).toHaveLength(0);
	});

	it('refuses a pin that is hidden pending review', async () => {
		resetDb({ hidden_at: new Date().toISOString() });
		const r = await call({ pinId: PIN_ID });
		expect(r.status).toBe(409);
		expect(db.shares).toHaveLength(0);
	});

	it('refuses a body too small to be a capture', async () => {
		const r = await call({ pinId: PIN_ID, bytes: 12 });
		expect(r.status).toBe(400);
		expect(putObject).not.toHaveBeenCalled();
	});

	it('surfaces an upload failure as a 502, never a stored half-share', async () => {
		putObject.mockImplementationOnce(async () => { throw new Error('bucket unreachable'); });
		const r = await call({ pinId: PIN_ID });
		expect(r.status).toBe(502);
		expect(r.body.error).toBe('upload_failed');
		expect(db.shares).toHaveLength(0);
	});

	it('is POST only', async () => {
		const r = await call({ pinId: PIN_ID, method: 'GET', bytes: 0 });
		expect(r.status).toBe(405);
	});
});
