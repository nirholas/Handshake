/**
 * POST /api/animations/presign tests.
 *
 * The presign is what decides where a creator's animation upload lands, and
 * api/animations/sell.js trusts that decision: it refuses any artifact_key
 * outside `u/<caller>/`. So the key this endpoint mints has to stay inside the
 * caller's own namespace no matter what the body asks for, and the request has
 * to be rejected outright when there is no caller.
 *
 * The auth, R2 and rate-limit boundaries are stubbed; the handler, its schema
 * and its key construction run for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const session = { user: null };
const bearer = { auth: null, scope: 'avatars:write' };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session.user),
	authenticateBearer: vi.fn(async () => bearer.auth),
	extractBearer: vi.fn(() => (bearer.auth ? 'token' : null)),
	hasScope: vi.fn((scope, required) => String(scope || '').split(/\s+/).includes(required)),
}));

const r2 = { calls: [] };
vi.mock('../../api/_lib/r2.js', () => ({
	presignUpload: vi.fn(async (args) => {
		r2.calls.push(args);
		return `https://r2.test/${args.key}?signed=1`;
	}),
}));

const rl = { ok: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { upload: vi.fn(async () => ({ success: rl.ok, reset: 0, limit: 10, remaining: 0 })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/animations/presign.js');

const OWNER = '11111111-1111-4111-8111-111111111111';

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
			url: '/api/animations/presign',
			headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
			body,
			socket: { remoteAddress: '127.0.0.1' },
		},
		res,
	);
	return res;
}

beforeEach(() => {
	session.user = { id: OWNER };
	bearer.auth = null;
	bearer.scope = 'avatars:write';
	r2.calls = [];
	rl.ok = true;
	vi.clearAllMocks();
});

describe('auth', () => {
	it('401s an anonymous caller', async () => {
		session.user = null;
		expect((await post({ size_bytes: 1024 })).statusCode).toBe(401);
	});

	it('401s a bearer token without avatars:write', async () => {
		session.user = null;
		bearer.auth = { userId: OWNER, scope: 'avatars:read' };
		expect((await post({ size_bytes: 1024 })).statusCode).toBe(401);
	});

	it('accepts a bearer token that carries the scope', async () => {
		session.user = null;
		bearer.auth = { userId: OWNER, scope: 'avatars:read avatars:write' };
		expect((await post({ size_bytes: 1024 })).statusCode).toBe(200);
	});

	it('429s when the upload rate limit is spent', async () => {
		rl.ok = false;
		expect((await post({ size_bytes: 1024 })).statusCode).toBe(429);
	});
});

describe('key scoping', () => {
	it('mints the key inside the caller own namespace, which sell.js then enforces', async () => {
		const { storage_key } = (await post({ size_bytes: 1024, slug: 'spin-kick' })).json();
		expect(storage_key.startsWith(`u/${OWNER}/animations/`)).toBe(true);
		expect(storage_key).toMatch(/^u\/[0-9a-f-]+\/animations\/spin-kick-\d+\.glb$/);
		expect(r2.calls[0].key).toBe(storage_key);
	});

	it('cannot be steered out of that namespace by a traversal slug', async () => {
		const res = await post({ size_bytes: 1024, slug: '../../other/evil' });
		expect(res.statusCode).toBe(400);
		expect(r2.calls).toHaveLength(0);
	});

	it('generates a slug when the caller supplies none', async () => {
		const { storage_key } = (await post({ size_bytes: 1024 })).json();
		expect(storage_key).toMatch(new RegExp(`^u/${OWNER}/animations/anim-[a-z0-9]{6}-\\d+\\.glb$`));
	});
});

describe('body validation', () => {
	it('rejects a non-positive or oversized size', async () => {
		expect((await post({ size_bytes: 0 })).statusCode).toBe(400);
		expect((await post({ size_bytes: -1 })).statusCode).toBe(400);
		expect((await post({ size_bytes: 200 * 1024 * 1024 })).statusCode).toBe(400);
	});

	it('rejects a content type that is not glTF', async () => {
		expect((await post({ size_bytes: 1024, content_type: 'image/png' })).statusCode).toBe(400);
	});

	it('rejects a malformed checksum and passes a well-formed one through to R2', async () => {
		expect((await post({ size_bytes: 1024, checksum_sha256: 'nope' })).statusCode).toBe(400);
		const sum = 'a'.repeat(64);
		await post({ size_bytes: 1024, checksum_sha256: sum });
		expect(r2.calls.at(-1).checksumSha256).toBe(sum);
	});

	it('answers with the upload contract the browser needs', async () => {
		const body = (await post({ size_bytes: 1024 })).json();
		expect(body.method).toBe('PUT');
		expect(body.headers['content-type']).toBe('model/gltf-binary');
		expect(body.expires_in).toBe(300);
		expect(body.upload_url).toContain(body.storage_key);
	});
});
