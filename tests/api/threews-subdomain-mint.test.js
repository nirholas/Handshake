// /api/threews/subdomain: POST (mint) and DELETE (release) branches.
//
// The availability GET path is covered in threews-subdomain-availability.test.js.
// This file covers everything behind authentication, which the live-server audit
// cannot reach: a box without THREEWS_SOL_PARENT_SECRET_BASE58 short-circuits
// every POST at the 503 config gate, so the validation ladder underneath it is
// only observable here.
//
// api/_lib/threews-sns.js is mocked wholesale, so no Solana RPC call is made and
// nothing is ever minted on-chain by this suite.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const sessionMock = vi.fn(async () => null);
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => sessionMock(...a),
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));

const hasOwnerKeyMock = vi.fn(() => true);
const getSubdomainOwnerMock = vi.fn(async () => null);
const mintSubdomainMock = vi.fn(async () => ({
	signature: '5xTx',
	fullName: 'nich.threews.sol',
	url_record: 'https://three.ws/u/nich',
}));
vi.mock('../../api/_lib/threews-sns.js', () => ({
	PARENT_LABEL: 'threews',
	fullDomain: (label) => `${label}.threews.sol`,
	getSubdomainOwner: (...a) => getSubdomainOwnerMock(...a),
	hasOwnerKey: (...a) => hasOwnerKeyMock(...a),
	mintSubdomain: (...a) => mintSubdomainMock(...a),
	normalizeLabel: (input) => {
		if (typeof input !== 'string') return null;
		const v = input.trim().toLowerCase();
		return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v) ? v : null;
	},
}));

const { default: handler } = await import('../../api/threews/subdomain.js');

const USER_ID = '00000000-0000-0000-0000-000000000001';
const WALLET = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

function makeReq(url, methodName, body) {
	const req = { url, method: methodName, headers: { host: 'x' }, query: {} };
	if (body !== undefined) {
		req.headers['content-type'] = 'application/json';
		req.body = body;
	}
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b; },
	};
}

async function call(url, methodName, body) {
	const res = makeRes();
	await handler(makeReq(url, methodName, body), res);
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
	hasOwnerKeyMock.mockReset().mockReturnValue(true);
	getSubdomainOwnerMock.mockReset().mockResolvedValue(null);
	mintSubdomainMock.mockReset().mockResolvedValue({
		signature: '5xTx',
		fullName: 'nich.threews.sol',
		url_record: 'https://three.ws/u/nich',
	});
});

describe('POST /api/threews/subdomain', () => {
	it('401s an anonymous caller before touching the DB or the chain', async () => {
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('503s with config_missing when the platform owner key is absent', async () => {
		signedIn();
		hasOwnerKeyMock.mockReturnValue(false);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('config_missing');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('400s a malformed label', async () => {
		signedIn();
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'not a label!' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('409s when the account has no username to match the label against', async () => {
		signedIn();
		sqlMock.mockResolvedValueOnce([{ id: USER_ID, username: null }]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('no_username');
	});

	it('409s when the label does not match the caller username', async () => {
		signedIn();
		sqlMock.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'someoneelse' });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('username_mismatch');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('409s when the label is already claimed in our own table', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([{ id: 'claim-1' }]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('conflict');
		expect(getSubdomainOwnerMock).not.toHaveBeenCalled();
	});

	it('409s when the name is already registered on-chain to someone else', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([]);
		getSubdomainOwnerMock.mockResolvedValue(WALLET);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('conflict');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('503s (not 500) when the pre-mint on-chain check cannot reach Solana', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([]);
		getSubdomainOwnerMock.mockRejectedValue(new Error('fetch failed'));
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('upstream_unavailable');
		expect(body.error_description).toMatch(/retry/i);
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('400s an owner_wallet that is not a base58 Solana address', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich', owner_wallet: '0xdeadbeef' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('403s an owner_wallet that is not linked to the caller account', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich', owner_wallet: WALLET });
		expect(res.statusCode).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('409s when no owner_wallet was passed and the account has no agent wallet', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('no_wallet');
		expect(mintSubdomainMock).not.toHaveBeenCalled();
	});

	it('surfaces a mint failure with the upstream status instead of a bare 500', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ sol: WALLET }]);
		mintSubdomainMock.mockRejectedValue(
			Object.assign(new Error('insufficient rent'), { status: 502, code: 'upstream_error' }),
		);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('201s with the stored row, showcase URL and explorer link on success', async () => {
		signedIn();
		sqlMock
			.mockResolvedValueOnce([{ id: USER_ID, username: 'nich' }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ sol: WALLET }])
			.mockResolvedValueOnce([{
				id: 'claim-1',
				label: 'nich',
				parent: 'threews',
				owner_wallet: WALLET,
				url_record: 'https://three.ws/u/nich',
				signature: '5xTx',
				created_at: '2026-05-23T00:00:00.000Z',
			}]);
		const { res, body } = await call('/api/threews/subdomain', 'POST', { label: 'nich' });
		expect(res.statusCode).toBe(201);
		expect(mintSubdomainMock).toHaveBeenCalledWith({ label: 'nich', recipientWallet: WALLET });
		expect(body.data.full).toBe('nich.threews.sol');
		expect(body.data.showcase_url).toBe('https://three.ws/u/nich');
		expect(body.data.explorer).toBe('https://solscan.io/tx/5xTx');
	});
});

describe('DELETE /api/threews/subdomain', () => {
	it('401s an anonymous caller', async () => {
		const { res, body } = await call('/api/threews/subdomain?label=nich', 'DELETE');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('400s when no label is supplied', async () => {
		signedIn();
		const { res, body } = await call('/api/threews/subdomain', 'DELETE');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s when the caller has no claim on that label', async () => {
		signedIn();
		sqlMock.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/threews/subdomain?label=nich', 'DELETE');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('200s and says on-chain ownership is untouched when a claim is released', async () => {
		signedIn();
		sqlMock.mockResolvedValueOnce([{ id: 'claim-1', label: 'nich', parent: 'threews' }]);
		const { res, body } = await call('/api/threews/subdomain?label=nich', 'DELETE');
		expect(res.statusCode).toBe(200);
		expect(body.data.released.label).toBe('nich');
		expect(body.data.note).toMatch(/on-chain/i);
	});
});
