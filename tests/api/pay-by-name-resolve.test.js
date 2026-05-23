// /api/x402/pay-by-name?name=… (GET resolve-only mode).
//
// Exercises all three name-namespace branches: raw base58 address, @username,
// and *.sol. Mocks the DB and the Bonfida SDK so the test runs offline.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const snsResolve = vi.fn();
vi.mock('@bonfida/spl-name-service', () => ({
	resolve: (...a) => snsResolve(...a),
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: () => ({}),
	loadAgentForSigning: vi.fn(),
}));

beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const { default: handler } = await import('../../api/x402/pay-by-name.js');

const PAYER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const RECIPIENT = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

function makeReq(url, method = 'GET') {
	return { url, method, headers: { host: 'x' }, query: {} };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(url, method) {
	const res = makeRes();
	await handler(makeReq(url, method), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

beforeEach(() => {
	sqlMock.mockReset();
	snsResolve.mockReset();
});

describe('GET /api/x402/pay-by-name (raw address namespace)', () => {
	it('passes a base58 address through without DB or SNS calls', async () => {
		const { res, body } = await call(`/api/x402/pay-by-name?name=${RECIPIENT}`);
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			address: RECIPIENT,
			source: 'address',
			resolved: RECIPIENT,
		});
		expect(sqlMock).not.toHaveBeenCalled();
		expect(snsResolve).not.toHaveBeenCalled();
	});
});

describe('GET /api/x402/pay-by-name (@username namespace)', () => {
	it('resolves @handle → user → default agent wallet', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{ sol: RECIPIENT }]);
		const { res, body } = await call('/api/x402/pay-by-name?name=@nich');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(RECIPIENT);
		expect(body.data.source).toBe('username');
		expect(body.data.resolved).toBe('@nich');
		expect(body.data.claim).toEqual({
			user_id: 'u1',
			username: 'nich',
			display_name: 'Nicholas',
		});
	});

	it('accepts a bare handle without the @ prefix', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich', display_name: 'Nicholas' }])
			.mockResolvedValueOnce([{ sol: RECIPIENT }]);
		const { body } = await call('/api/x402/pay-by-name?name=nich');
		expect(body.data.source).toBe('username');
		expect(body.data.resolved).toBe('@nich');
	});

	it('404s when the username does not exist', async () => {
		sqlMock.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/x402/pay-by-name?name=@ghost');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('404s when the user has no agent with a Solana wallet', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: 'u1', username: 'nich' }])
			.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/x402/pay-by-name?name=@nich');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('GET /api/x402/pay-by-name (.sol namespace)', () => {
	it('resolves a top-level .sol via Bonfida', async () => {
		// Top-level .sol — no DB lookup (it's not under our threews. parent)
		snsResolve.mockResolvedValueOnce({ toBase58: () => RECIPIENT });
		const { res, body } = await call('/api/x402/pay-by-name?name=bonfida.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(RECIPIENT);
		expect(body.data.source).toBe('sns');
		expect(body.data.resolved).toBe('bonfida.sol');
		// `resolve()` got the bare label (without .sol).
		expect(snsResolve).toHaveBeenCalledWith(expect.anything(), 'bonfida');
	});

	it('attaches the DB claim when resolving a *.threews.sol subdomain', async () => {
		sqlMock.mockResolvedValueOnce([{
			label: 'nich',
			parent: 'threews',
			user_id: 'u1',
			username: 'nich',
			display_name: 'Nicholas',
		}]);
		snsResolve.mockResolvedValueOnce({ toBase58: () => RECIPIENT });
		const { res, body } = await call('/api/x402/pay-by-name?name=nich.threews.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data.address).toBe(RECIPIENT);
		expect(body.data.source).toBe('sns');
		expect(body.data.resolved).toBe('nich.threews.sol');
		expect(body.data.claim).toEqual({
			user_id: 'u1',
			username: 'nich',
			display_name: 'Nicholas',
		});
		expect(snsResolve).toHaveBeenCalledWith(expect.anything(), 'nich.threews');
	});

	it('does NOT attach a claim when the *.threews subdomain has no DB row', async () => {
		sqlMock.mockResolvedValueOnce([]);
		snsResolve.mockResolvedValueOnce({ toBase58: () => RECIPIENT });
		const { body } = await call('/api/x402/pay-by-name?name=ghost.threews.sol');
		expect(body.data.address).toBe(RECIPIENT);
		expect(body.data.claim).toBeUndefined();
	});

	it('404s when Bonfida cannot resolve the domain', async () => {
		snsResolve.mockRejectedValueOnce(new Error('no SOL record'));
		const { res, body } = await call('/api/x402/pay-by-name?name=does-not-exist.sol');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('GET /api/x402/pay-by-name (validation)', () => {
	it('400s when name is missing', async () => {
		const { res, body } = await call('/api/x402/pay-by-name');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('404s on a name that does not match any namespace', async () => {
		const { res, body } = await call('/api/x402/pay-by-name?name=!!!');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('rejects methods other than GET or POST', async () => {
		const { res } = await call('/api/x402/pay-by-name?name=' + RECIPIENT, 'DELETE');
		expect(res.statusCode).toBe(405);
	});
});
