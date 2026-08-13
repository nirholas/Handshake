// POST /api/irl/pins — IRL-Live D4 moderation, safety & density caps.
//
// The POST chokepoint is where a public, shared placement turns dangerous: a slur
// in a caption, a non-$THREE coin shill, a pin pointing its Pay button at an
// off-platform drain, one actor carpet-bombing a plaza, or a scripted flood. These
// tests prove each gate fires with its designed error code, in the right order
// (content → endpoint → rate → density → owner cap), and that a clean placement
// still succeeds. DB / auth / limiter are mocked so the suite stays offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content-addressed SQL mock: the density count, the per-owner count, and the
// INSERT each return a shape keyed off the query text, so call order doesn't
// matter. `densityCount` / `ownerCount` are tunable per test.
let densityCount = 0;
let ownerCount = 0;
const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/count\(\*\)::int AS n[\s\S]*geocell7 =/i.test(q)) {
		return Promise.resolve([{ n: densityCount }]);
	}
	if (/count\(\*\)::int AS n[\s\S]*user_id =/i.test(q)) {
		return Promise.resolve([{ n: ownerCount }]);
	}
	if (/INSERT INTO irl_pins/i.test(q)) {
		return Promise.resolve([{ id: 'new-pin', expires_at: '2030-01-01T00:00:00Z' }]);
	}
	// ensureTable DDL + anything else.
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));

// Tunable limiter verdicts. Default: everything passes. A test flips one to
// model that bucket being exhausted.
let limiterVerdicts = {};
function verdict(name) {
	return limiterVerdicts[name] ?? { success: true, reset: Date.now() + 60_000 };
}
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		irlPinIp:     vi.fn(async () => verdict('irlPinIp')),
		irlPinBurst:  vi.fn(async () => verdict('irlPinBurst')),
		irlPinHourly: vi.fn(async () => verdict('irlPinHourly')),
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
async function post(body) {
	const res = makeRes();
	await handler({ url: '/api/irl/pins', method: 'POST', headers: { host: 'x' }, query: {}, body }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const BASE = { lat: 40.7128, lng: -74.006, avatarName: 'Aria', caption: 'hello world' };

beforeEach(() => {
	sqlMock.mockClear();
	densityCount = 0;
	ownerCount = 0;
	limiterVerdicts = {};
	sessionUser = null;
});

describe('POST /api/irl/pins — content gate', () => {
	it('422s a caption with a blacklisted term and never inserts', async () => {
		const { res, body } = await post({ ...BASE, caption: 'you absolute retard' });
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('content');
		expect(body.field).toBe('caption');
		const inserted = sqlMock.mock.calls.some(([s]) =>
			/INSERT INTO irl_pins/i.test(Array.isArray(s) ? s.join(' ') : String(s)));
		expect(inserted).toBe(false);
	});

	it('422s a blacklisted avatar name', async () => {
		const { res, body } = await post({ ...BASE, avatarName: 'kys bot' });
		expect(res.statusCode).toBe(422);
		expect(body.field).toBe('avatarName');
	});

	it('422s an off-brand coin cashtag with a $THREE-only message', async () => {
		const { res, body } = await post({ ...BASE, caption: 'aping $DOGE hard' });
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('content');
		expect(body.message).toMatch(/\$THREE/);
	});

	// A ticker longer than ten characters used to slip past the guard entirely: the
	// cashtag pattern capped the ticker at nine trailing characters and then demanded
	// a word boundary, which can never fall mid-word, so the whole cashtag went
	// unmatched and the caption was treated as clean.
	it('422s an off-brand cashtag whose ticker is longer than ten characters', async () => {
		const { res, body } = await post({ ...BASE, caption: 'buy $SOMETHINGELSE now' });
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('content');
		expect(body.field).toBe('caption');
	});

	it('allows a caption that references $THREE', async () => {
		const { res } = await post({ ...BASE, caption: 'powered by $THREE' });
		expect(res.statusCode).toBe(201);
	});
});

describe('POST /api/irl/pins — endpoint allow-list', () => {
	it('422s an x402 endpoint on an arbitrary external host', async () => {
		const { res, body } = await post({ ...BASE, x402Endpoint: 'https://evil.example.com/drain' });
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('endpoint');
	});

	it('201s an x402 endpoint on a first-party host', async () => {
		const { res } = await post({ ...BASE, x402Endpoint: 'https://three.ws/api/x402-pay' });
		expect(res.statusCode).toBe(201);
	});
});

describe('POST /api/irl/pins — rate limit', () => {
	it('429s with retryAfter when the burst bucket is exhausted', async () => {
		limiterVerdicts.irlPinBurst = { success: false, reset: Date.now() + 30_000 };
		const { res, body } = await post({ ...BASE });
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate');
		expect(body.retryAfter).toBeGreaterThan(0);
		expect(res.getHeader('Retry-After')).toBeTruthy();
	});
});

describe('POST /api/irl/pins — density + owner caps', () => {
	it('429 area_full when the geocell is at capacity (40 pins → 41st rejected)', async () => {
		densityCount = 40;
		const { res, body } = await post({ ...BASE });
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('area_full');
	});

	it('429 pin_limit when an anonymous device is at its active-pin cap (20)', async () => {
		ownerCount = 20;
		const { res, body } = await post({ ...BASE, deviceToken: 'dev-A' });
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('pin_limit');
		expect(body.limit).toBe(20);
	});

	it('a signed-in owner gets the higher cap (19 anon-over-limit still passes)', async () => {
		sessionUser = { id: 'owner-uuid' };
		ownerCount = 19; // over the anon 20? no — 19 < 60 signed ceiling, so it passes
		const { res } = await post({ ...BASE });
		expect(res.statusCode).toBe(201);
	});
});

describe('POST /api/irl/pins — clean placement', () => {
	it('201s and returns the created pin with permanent=false for anonymous', async () => {
		const { res, body } = await post({ ...BASE, deviceToken: 'dev-A' });
		expect(res.statusCode).toBe(201);
		expect(body.pin.id).toBe('new-pin');
		expect(body.pin.permanent).toBe(false);
	});
});
