// Tests for POST /api/embed/gate-create, the endpoint that turns an asset you
// own into a holder-only embed.
//
// Two rules carry the weight here. First, only the owner may put a gate on an
// asset: a gate created by anyone else would be a stranger paywalling someone
// else's avatar. Second, the response must not contain the glbUrl, because the
// point of gating is that the model is handed out by api/embed/resolve.js and
// only against a proven holding.
//
// The gate config is coin-agnostic plumbing: `mint` is a runtime parameter so
// any community can gate with its own SPL token, and it defaults to $THREE when
// the caller does not name one. Both behaviours are pinned below.
//
// Only the database and the session lookup are stubbed. The gate normalization,
// the asset resolver and the snippet the caller pastes are all the real thing.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
	process.env.JWT_SECRET = 'test-jwt-secret-embed-gate-create-0123456789';
	process.env.S3_PUBLIC_DOMAIN = 'assets.test.three.ws';
});

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		embedGateCreateIp: vi.fn(async () => ({ success: true, limit: 20, remaining: 19, reset: 0 })),
	},
	clientIp: () => '203.0.113.11',
}));

const handler = (await import('../../api/embed/gate-create.js')).default;
const { DEFAULT_GATE_MINT } = await import('../../api/_lib/embed-gate.js');

const OWNER = 'user_owner_1';
const AVATAR_ID = '8e3f1c22-0000-4000-8000-0000000000c1';
const ASSET = `avatar:${AVATAR_ID}`;

const avatarRow = {
	id: AVATAR_ID,
	name: 'Nova',
	description: 'A public avatar',
	storage_key: 'avatars/nova.glb',
	thumbnail_key: 'avatars/nova.jpg',
};

/** `owner` is the row checkAssetOwnership reads; `avatar` is what the resolver
 *  reads. They are separate queries against the same table, so they are stubbed
 *  by the columns each selects. */
function stubDb({ avatar = [avatarRow], owner = [{ owner_id: OWNER }], inserted = [] } = {}) {
	sqlMock.mockImplementation((strings) => {
		const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
		if (/insert into embed_gates/i.test(text)) return Promise.resolve(inserted);
		if (/update embed_gates/i.test(text)) return Promise.resolve([]);
		if (/select owner_id from avatars/i.test(text)) return Promise.resolve(owner);
		if (/from\s+avatars/i.test(text)) return Promise.resolve(avatar);
		return Promise.resolve([]);
	});
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk) this.body += chunk;
		},
	};
}

async function post(body) {
	const req = {
		method: 'POST',
		url: '/api/embed/gate-create',
		headers: { 'content-type': 'application/json' },
		rawBody: Buffer.from(JSON.stringify(body)),
		body,
		on(event, cb) {
			if (event === 'data') {
				queueMicrotask(() => {
					cb(Buffer.from(JSON.stringify(body)));
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
			}
		},
		destroy() {},
	};
	const res = mkRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset();
});

describe('authorization', () => {
	it('401s a caller with no session and no bearer token', async () => {
		getSessionUserMock.mockResolvedValue(null);
		stubDb();
		const { res, json } = await post({ assetId: ASSET, gate: { minAmount: 5000 } });

		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('403s a signed-in caller who does not own the asset', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user_someone_else' });
		stubDb();
		const { res, json } = await post({ assetId: ASSET, gate: { minAmount: 5000 } });

		expect(res.statusCode).toBe(403);
		expect(json.error).toBe('not_owner');
	});

	it('404s an asset that does not exist', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		stubDb({ avatar: [], owner: [] });
		const { res, json } = await post({ assetId: ASSET, gate: { minAmount: 5000 } });

		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});

describe('creating a gate', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
	});

	it('defaults to $THREE and returns a paste-ready snippet', async () => {
		stubDb();
		const { res, json } = await post({ assetId: ASSET, gate: { minAmount: 5000 } });

		expect(res.statusCode).toBe(201);
		expect(json.gate).toEqual({ mint: DEFAULT_GATE_MINT, minAmount: 5000, chain: 'solana' });
		expect(json.gateId).toMatch(/^[A-Za-z0-9]{12}$/);
		expect(json.embed.snippet).toContain(json.assetId);
		expect(json.embed.snippet).toContain('/embed/v1.js');
		// The whole point of gating: this response is not a way around it.
		expect(JSON.stringify(json)).not.toContain('avatars/nova.glb');
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('accepts a runtime mint, so a community can gate with its own token', async () => {
		stubDb();
		const mint = 'THREEsynthetic1111111111111111111111111111';
		const { res, json } = await post({ assetId: ASSET, gate: { mint, minAmount: 1 } });

		expect(res.statusCode).toBe(201);
		expect(json.gate.mint).toBe(mint);
	});

	it('rejects a non-positive threshold instead of creating an open gate', async () => {
		stubDb();
		const { res, json } = await post({ assetId: ASSET, gate: { minAmount: 0 } });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});

	it('rejects a chain other than solana, the home chain for gating', async () => {
		stubDb();
		const { res, json } = await post({
			assetId: ASSET,
			gate: { minAmount: 5000, chain: 'ethereum' },
		});

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});

	it('rejects an assetId that is not one of the documented specs', async () => {
		stubDb();
		const { res, json } = await post({ assetId: 'not-an-asset-ref', gate: { minAmount: 5000 } });

		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});

	it('rejects a body with no gate at all', async () => {
		stubDb();
		const { res, json } = await post({ assetId: ASSET });
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});
});
