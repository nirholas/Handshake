// /api/x402/pay-by-name — name → payment routing. Exercises the resolver
// across all three name sources (raw address, .sol domain incl. threews
// subdomain, username) plus the prep/send envelope validation. Mocks Bonfida
// + DB + auth so the tests stay offline.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

const snsResolveMock = vi.fn();
vi.mock('@bonfida/spl-name-service', () => ({
	resolve: (...a) => snsResolveMock(...a),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const getSessionUserMock = vi.fn(async () => null);
const authenticateBearerMock = vi.fn(async () => null);
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: () => null,
}));

// solanaConnection() returns an object — only handleResolve and handlePrep
// touch it, and handlePrep also calls getLatestBlockhash. We stub a minimal
// surface and rely on individual tests to mock it further when needed.
const connMock = {
	getLatestBlockhash: vi.fn(async () => ({
		blockhash: '11111111111111111111111111111111',
		lastValidBlockHeight: 100,
	})),
};
vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: () => connMock,
	loadAgentForSigning: vi.fn(async () => ({
		error: { status: 404, code: 'not_found', msg: 'agent not found' },
	})),
}));

beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const ADDR = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';
const PAYER = '5xoBq7f6XNGSpGT6h2KqxKaq6r8sfTrgyiUbWiQ7Lf4D';

const { default: handler } = await import('../../api/x402/pay-by-name.js');

function makeReq(url, method = 'GET', body = null) {
	const req = {
		url,
		method,
		headers: { host: 'x', 'content-type': 'application/json' },
		query: {},
	};
	if (body !== null) {
		const buf = Buffer.from(JSON.stringify(body));
		let read = false;
		req.on = (event, cb) => {
			if (event === 'data' && !read) {
				cb(buf);
				read = true;
			} else if (event === 'end') queueMicrotask(cb);
			return req;
		};
		req.headers['content-length'] = String(buf.length);
	}
	return req;
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
		},
	};
}
async function call(url, method, body) {
	const res = makeRes();
	await handler(makeReq(url, method, body), res);
	let parsed = null;
	try {
		parsed = JSON.parse(res._body);
	} catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockReset();
	snsResolveMock.mockReset();
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
});

describe('GET /api/x402/pay-by-name?name=… (resolve)', () => {
	it('passes a raw base58 address straight through', async () => {
		const { res, body } = await call(`/api/x402/pay-by-name?name=${ADDR}`);
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ address: ADDR, source: 'address', resolved: ADDR });
		expect(snsResolveMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('resolves a top-level .sol domain via SNS', async () => {
		snsResolveMock.mockResolvedValue({ toBase58: () => ADDR });
		const { res, body } = await call('/api/x402/pay-by-name?name=bonfida.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(ADDR);
		expect(body.data.source).toBe('sns');
		expect(body.data.resolved).toBe('bonfida.sol');
		expect(body.data.claim).toBeUndefined();
		expect(snsResolveMock).toHaveBeenCalledWith(expect.anything(), 'bonfida');
	});

	it('resolves a <label>.threews.sol and joins the DB claim', async () => {
		snsResolveMock.mockResolvedValue({ toBase58: () => ADDR });
		sqlMock.mockResolvedValueOnce([
			{
				label: 'nich',
				parent: 'threews',
				user_id: '00000000-0000-0000-0000-000000000001',
				username: 'nich',
				display_name: 'Nicholas',
			},
		]);
		const { res, body } = await call('/api/x402/pay-by-name?name=nich.threews.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(ADDR);
		expect(body.data.source).toBe('sns');
		expect(body.data.claim).toEqual({
			user_id: '00000000-0000-0000-0000-000000000001',
			username: 'nich',
			display_name: 'Nicholas',
		});
		expect(snsResolveMock).toHaveBeenCalledWith(expect.anything(), 'nich.threews');
	});

	it('returns 404 when SNS resolution fails', async () => {
		snsResolveMock.mockRejectedValue(new Error('DomainDoesNotExist'));
		sqlMock.mockResolvedValueOnce([]); // claim DB lookup tries first for threews
		const { res, body } = await call('/api/x402/pay-by-name?name=missing.threews.sol');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it("resolves @username to the user's default agent wallet", async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{ sol: ADDR }]);
		const { res, body } = await call('/api/x402/pay-by-name?name=@nich');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(ADDR);
		expect(body.data.source).toBe('username');
		expect(body.data.resolved).toBe('@nich');
		expect(body.data.claim.username).toBe('nich');
	});

	it('resolves a bare username (no @) the same way', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{ sol: ADDR }]);
		const { res, body } = await call('/api/x402/pay-by-name?name=nich');
		expect(res.statusCode).toBe(200);
		expect(body.data.source).toBe('username');
	});

	it('returns 404 when the username exists but the user has no agent wallet', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{ sol: null }]);
		const { res, body } = await call('/api/x402/pay-by-name?name=@nich');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 404 when the username does not exist', async () => {
		sqlMock.mockResolvedValueOnce([]);
		const { res } = await call('/api/x402/pay-by-name?name=@ghost');
		expect(res.statusCode).toBe(404);
	});

	it('rejects an unrecognized name shape with 404', async () => {
		const { res } = await call('/api/x402/pay-by-name?name=!!not-a-name!!');
		expect(res.statusCode).toBe(404);
	});

	it('rejects calls with no name', async () => {
		const { res, body } = await call('/api/x402/pay-by-name');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('sets a brief cache hint on successful resolution', async () => {
		const { res } = await call(`/api/x402/pay-by-name?name=${ADDR}`);
		expect(res.getHeader('cache-control')).toMatch(/max-age=60/);
	});
});

describe('POST /api/x402/pay-by-name (mode=prep)', () => {
	it('rejects when payer_wallet is missing or malformed', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: ADDR,
			amount_usdc: 1,
		});
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/payer_wallet/);
	});

	it('rejects amount_usdc <= 0', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: ADDR,
			amount_usdc: 0,
			payer_wallet: PAYER,
		});
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/amount_usdc/);
	});

	it('rejects amount_usdc above the per-call cap', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: ADDR,
			amount_usdc: 50_000,
			payer_wallet: PAYER,
		});
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/amount_usdc/);
	});

	it('rejects self-pay (payer == recipient)', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: PAYER,
			amount_usdc: 1,
			payer_wallet: PAYER,
		});
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('self_pay');
	});

	it('returns 404 if the name does not resolve', async () => {
		snsResolveMock.mockRejectedValue(new Error('DomainDoesNotExist'));
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: 'ghost.sol',
			amount_usdc: 1,
			payer_wallet: PAYER,
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('builds a base64 VersionedTransaction when inputs are valid', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'prep',
			name: ADDR,
			amount_usdc: 1.5,
			payer_wallet: PAYER,
		});
		expect(res.statusCode).toBe(200);
		expect(body.data.recipient.address).toBe(ADDR);
		expect(body.data.amount_usdc).toBe(1.5);
		expect(typeof body.data.tx_base64).toBe('string');
		expect(body.data.tx_base64.length).toBeGreaterThan(0);
		expect(body.data.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	});
});

describe('POST /api/x402/pay-by-name (mode=send)', () => {
	it('requires authentication', async () => {
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'send',
			name: ADDR,
			amount_usdc: 1,
			agent_id: 'a1',
		});
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('requires agent_id even when authenticated', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		const { res, body } = await call('/api/x402/pay-by-name', 'POST', {
			mode: 'send',
			name: ADDR,
			amount_usdc: 1,
		});
		expect(res.statusCode).toBe(400);
		expect(body.error_description).toMatch(/agent_id/);
	});

	it('rejects non-GET/POST methods', async () => {
		const { res } = await call('/api/x402/pay-by-name', 'DELETE');
		expect(res.statusCode).toBe(405);
	});
});
