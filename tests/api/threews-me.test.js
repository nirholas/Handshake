// GET /api/threews/me: the signed-in caller's `<label>.threews.sol` claim.
//
// The handler has three terminal states (`claimed`, `available`,
// `needs_username`) and the /threews/claim page branches on all three, so each
// one is pinned here along with the unauthenticated and deleted-user paths.
// No Solana RPC is involved: this endpoint only reads our own tables.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const sessionMock = vi.fn(async () => null);
const bearerMock = vi.fn(async () => null);
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => sessionMock(...a),
	authenticateBearer: (...a) => bearerMock(...a),
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'https://three.ws' },
}));

beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const { default: handler } = await import('../../api/threews/me.js');

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function call() {
	const res = makeRes();
	await handler({ url: '/api/threews/me', method: 'GET', headers: { host: 'x' }, query: {} }, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch { /* non-JSON body stays null */ }
	return { res, body: parsed };
}

function signedIn() {
	sessionMock.mockResolvedValue({ id: USER_ID });
}

beforeEach(() => {
	sqlMock.mockReset();
	sessionMock.mockReset().mockResolvedValue(null);
	bearerMock.mockReset().mockResolvedValue(null);
});

describe('GET /api/threews/me', () => {
	it('401s when neither a session nor a bearer token authenticates', async () => {
		const { res, body } = await call();
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s when the session points at a deleted user', async () => {
		signedIn();
		sqlMock.mockResolvedValueOnce([]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		// Bailed before the claim lookup.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('reports status=claimed with the full name, showcase URL and explorer link', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{
				label: 'nich',
				parent: 'threews',
				owner_wallet: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk',
				url_record: 'https://three.ws/u/nich',
				signature: '5xTx',
				created_at: '2026-05-23T00:00:00.000Z',
			}]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('claimed');
		expect(body.data.has_claim).toBe(true);
		expect(body.data.parent).toBe('threews');
		expect(body.data.claim.full).toBe('nich.threews.sol');
		expect(body.data.claim.showcase_url).toBe('https://three.ws/u/nich');
		expect(body.data.claim.explorer).toBe('https://solscan.io/tx/5xTx');
		expect(body.data.claim_url).toBeNull();
		expect(body.data.blocked_reason).toBeNull();
	});

	it('falls back to the on-chain URL record when the username was cleared after the mint', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: null, display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{
				label: 'nich',
				parent: 'threews',
				owner_wallet: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk',
				url_record: 'https://three.ws/u/nich',
				signature: null,
				created_at: '2026-05-23T00:00:00.000Z',
			}]);
		const { body } = await call();
		expect(body.data.claim.showcase_url).toBe('https://three.ws/u/nich');
		// `signature` is nullable in the schema, so the explorer link must not
		// render as /tx/null.
		expect(body.data.claim.explorer).toBeNull();
	});

	it('reports status=available with a claim URL when the account has a username but no claim', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('available');
		expect(body.data.has_claim).toBe(false);
		expect(body.data.claim).toBeNull();
		expect(body.data.claim_url).toBe('https://three.ws/threews/claim');
		expect(body.data.blocked_reason).toBeNull();
	});

	it('reports status=needs_username with a readable reason when no username is set', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: null, display_name: 'qa-audit' }])
			.mockResolvedValueOnce([]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('needs_username');
		expect(body.data.claim_url).toBeNull();
		expect(body.data.blocked_reason).toMatch(/username/i);
	});

	it('accepts a bearer token when there is no session cookie', async () => {
		bearerMock.mockResolvedValue({ userId: USER_ID });
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([]);
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.data.user.id).toBe(USER_ID);
	});
});
