/**
 * api/registry/resolve.js, the public agent-registry lookup behind
 * public/lookup.html. One `q` resolves an agent UUID, an avatar UUID, an avatar
 * slug, or a Solana Core mint into a single record.
 *
 * The invariant under test is the visibility gate. The handler's own contract is
 * that a private avatar never leaks its body, and the thumbnail is a render of
 * that same body, so it is gated identically. Before this suite existed, a
 * private avatar resolved by UUID returned a live CDN URL to its rendered PNG.
 *
 * `api/_lib/db.js` and `api/_lib/rate-limit.js` are mocked so every branch runs
 * without a Neon branch or an RPC round trip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.S3_PUBLIC_DOMAIN ||= 'https://cdn.test';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({
			success: rl.ok,
			limit: 120,
			remaining: 0,
			reset: Date.now() + 60_000,
		})),
	},
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../api/registry/resolve.js');

const AVATAR_ID = '11111111-2222-4333-8444-555555555555';

function makeReq(q, { method = 'GET' } = {}) {
	return {
		method,
		url: `/api/registry/resolve?q=${encodeURIComponent(q ?? '')}`,
		query: q === undefined ? {} : { q },
		headers: { host: 'three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null, writableEnded: false, headersSent: false };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.writeHead = (c, h) => { r.statusCode = c; Object.assign(r._h, h || {}); return r; };
	r.end = (b) => { r._b = b ?? r._b; r.writableEnded = true; r.headersSent = true; };
	r.json = () => (r._b ? JSON.parse(r._b) : undefined);
	return r;
}

async function call(q, opts) {
	const res = makeRes();
	await handler(makeReq(q, opts), res);
	return res;
}

// One avatar row as resolveAvatarById() selects it: no linked agent, so the
// record's identity fields stay null and only the avatar gates the media.
function avatarRow(visibility) {
	return {
		id: AVATAR_ID,
		name: 'Selfie',
		description: 'a private render',
		slug: 'selfie-3s2x1z',
		storage_key: `u/owner/${AVATAR_ID}.glb`,
		visibility,
		content_type: 'model/gltf-binary',
		thumbnail_key: `thumb/${AVATAR_ID}.png`,
		agent_id: null,
		agent_name: null,
		agent_description: null,
		agent_wallet: null,
		agent_meta: null,
	};
}

beforeEach(() => {
	rl.ok = true;
	sqlMock.mockReset().mockResolvedValue([]);
});

describe('GET /api/registry/resolve validation', () => {
	it('rejects a missing q with a 400 JSON envelope, never a stack trace', async () => {
		const res = await call(undefined);
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ error: 'validation_error' });
		expect(res._b).not.toMatch(/at \w+ \(/);
	});

	it('rejects an over-long q rather than querying with it', async () => {
		const res = await call('a'.repeat(65));
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers an unknown input with a 200 not_found record, never a 404 or a 500', async () => {
		const res = await call('no-such-slug');
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			name: null,
			description: '',
			agentId: null,
			genesisRank: null,
			modelUrl: null,
			imageUrl: null,
			onchain: null,
			state: 'not_found',
		});
	});

	it('refuses a non-GET method', async () => {
		const res = await call('x', { method: 'POST' });
		expect(res.statusCode).toBe(405);
	});

	it('surfaces a rate-limit rejection as 429', async () => {
		rl.ok = false;
		const res = await call('anything');
		expect(res.statusCode).toBe(429);
	});
});

describe('avatar visibility gates the media', () => {
	it('publishes both the model and the thumbnail for a public avatar', async () => {
		// resolveAgentById (empty), resolveAvatarById (hit), genesisRankFor (skipped:
		// agentId is null), so a single row queue covers the lookup.
		sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([avatarRow('public')]);
		const res = await call(AVATAR_ID);
		const body = res.json();
		expect(res.statusCode).toBe(200);
		expect(body.state).toBe('public');
		expect(body.modelUrl).toBe(`https://cdn.test/u/owner/${AVATAR_ID}.glb`);
		expect(body.imageUrl).toBe(`https://cdn.test/thumb/${AVATAR_ID}.png`);
	});

	it('publishes both for an unlisted avatar', async () => {
		sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([avatarRow('unlisted')]);
		const body = (await call(AVATAR_ID)).json();
		expect(body.modelUrl).toBe(`https://cdn.test/u/owner/${AVATAR_ID}.glb`);
		expect(body.imageUrl).toBe(`https://cdn.test/thumb/${AVATAR_ID}.png`);
	});

	it('leaks neither the model nor the thumbnail of a private avatar', async () => {
		sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([avatarRow('private')]);
		const res = await call(AVATAR_ID);
		const body = res.json();
		expect(res.statusCode).toBe(200);
		expect(body.state).toBe('private');
		expect(body.modelUrl).toBeNull();
		// The thumbnail is a render of the same private body: gated identically.
		expect(body.imageUrl).toBeNull();
		expect(res._b).not.toContain('thumb/');
	});

	it('drops a legacy origin-pointing *_og.png thumbnail key instead of publishing a 404', async () => {
		const row = avatarRow('public');
		row.thumbnail_key = 'https://three.ws/avatars/selfie_og.png';
		sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
		const body = (await call(AVATAR_ID)).json();
		expect(body.imageUrl).toBeNull();
		expect(body.modelUrl).toBe(`https://cdn.test/u/owner/${AVATAR_ID}.glb`);
	});
});
