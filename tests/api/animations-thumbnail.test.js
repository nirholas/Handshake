/**
 * POST /api/animations/thumbnail tests.
 *
 * The poster upload is the one write that takes a raw image from the browser,
 * so every way the body can be wrong needs its own honest answer: a bad id used
 * to reach Postgres as an invalid uuid literal and come back as a 500 with a
 * support ref. Ownership is enforced here too, since the clip row is looked up
 * before the R2 write rather than joined into it.
 *
 * The db, auth, R2 and rate-limit boundaries are stubbed; the handler and its
 * http envelope run for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { rows: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		db.calls.push(String(strings?.[0] || '').trim());
		return db.rows;
	}),
}));

const session = { user: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session.user),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

const r2 = { put: [], deleted: [] };
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: vi.fn(async (args) => { r2.put.push(args); }),
	deleteObject: vi.fn(async (key) => { r2.deleted.push(key); }),
	publicUrl: vi.fn((key) => `https://cdn.test/${key}`),
}));

const rl = { ok: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { upload: vi.fn(async () => ({ success: rl.ok, reset: 0, limit: 10, remaining: 0 })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/animations/thumbnail.js');

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';

// A real 1x1 PNG, so the magic-number check runs against genuine bytes.
const PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	r.json = () => JSON.parse(r._b);
	return r;
}

async function post(body) {
	const res = makeRes();
	await handler(
		{
			method: 'POST',
			url: '/api/animations/thumbnail',
			headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
			body,
			socket: { remoteAddress: '127.0.0.1' },
		},
		res,
	);
	return res;
}

beforeEach(() => {
	db.rows = [{ id: CLIP_ID, owner_id: OWNER, thumbnail_key: null }];
	db.calls = [];
	session.user = { id: OWNER };
	r2.put = [];
	r2.deleted = [];
	rl.ok = true;
	vi.clearAllMocks();
});

describe('auth', () => {
	it('401s an anonymous caller', async () => {
		session.user = null;
		const res = await post({ id: CLIP_ID, png_base64: PNG_B64 });
		expect(res.statusCode).toBe(401);
	});

	it('403s a signed-in caller who does not own the clip', async () => {
		db.rows = [{ id: CLIP_ID, owner_id: OTHER, thumbnail_key: null }];
		const res = await post({ id: CLIP_ID, png_base64: PNG_B64 });
		expect(res.statusCode).toBe(403);
		expect(r2.put).toHaveLength(0);
	});
});

describe('body validation', () => {
	it('rejects a hex-but-not-uuid id with a 400 instead of a database 500', async () => {
		const res = await post({ id: 'aaaaaaaa', png_base64: PNG_B64 });
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_request');
		expect(db.calls).toHaveLength(0);
	});

	it('rejects a missing id and a missing image', async () => {
		expect((await post({ png_base64: PNG_B64 })).statusCode).toBe(400);
		expect((await post({ id: CLIP_ID })).statusCode).toBe(400);
	});

	it('rejects bytes that are not a PNG', async () => {
		const res = await post({ id: CLIP_ID, png_base64: Buffer.from('hello').toString('base64') });
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toMatch(/not a PNG/);
	});

	it('accepts a poster the declared cap allows (the JSON envelope used to eat it first)', async () => {
		const ok = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(1_000_000),
		]);
		const res = await post({ id: CLIP_ID, png_base64: ok.toString('base64') });
		expect(res.statusCode).toBe(200);
	});

	it('names the size when the image is over the cap, rather than blaming the id', async () => {
		const big = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(1_600_000),
		]);
		const res = await post({ id: CLIP_ID, png_base64: big.toString('base64') });
		expect(res.statusCode).toBe(413);
		expect(res.json().error).toBe('too_large');
	});

	it('404s when the clip does not exist', async () => {
		db.rows = [];
		const res = await post({ id: CLIP_ID, png_base64: PNG_B64 });
		expect(res.statusCode).toBe(404);
	});

	it('429s when the upload rate limit is spent', async () => {
		rl.ok = false;
		const res = await post({ id: CLIP_ID, png_base64: PNG_B64 });
		expect(res.statusCode).toBe(429);
	});
});

describe('successful upload', () => {
	it('stores the poster under the clip id and returns its public url', async () => {
		const res = await post({ id: CLIP_ID, png_base64: `data:image/png;base64,${PNG_B64}` });
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toMatchObject({
			id: CLIP_ID,
			thumbnail_key: `anim-thumb/${CLIP_ID}.png`,
			thumbnail_url: `https://cdn.test/anim-thumb/${CLIP_ID}.png`,
		});
		expect(r2.put[0].contentType).toBe('image/png');
	});

	it('sweeps a superseded poster object instead of orphaning it', async () => {
		db.rows = [{ id: CLIP_ID, owner_id: OWNER, thumbnail_key: 'anim-thumb/old.png' }];
		await post({ id: CLIP_ID, png_base64: PNG_B64 });
		await new Promise((r) => queueMicrotask(r));
		expect(r2.deleted).toEqual(['anim-thumb/old.png']);
	});
});
