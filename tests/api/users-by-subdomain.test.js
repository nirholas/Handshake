// /api/users/by-subdomain — reverse-lookup from a `<label>.<parent>.sol` to
// the three.ws user_id that claimed it. Mocks the DB so the test stays
// offline.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { snsResolve: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const { default: handler } = await import('../../api/users/by-subdomain.js');

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
});

describe('/api/users/by-subdomain', () => {
	it('returns the user + display fields for a claimed subdomain', async () => {
		sqlMock.mockResolvedValueOnce([{
			label: 'nich',
			parent: 'threews',
			owner_wallet: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk',
			url_record: 'https://three.ws/u/nich',
			created_at: '2026-05-23T00:00:00.000Z',
			user_id: '00000000-0000-0000-0000-000000000001',
			username: 'nich',
			display_name: 'Nicholas',
		}]);
		const { res, body } = await call('/api/users/by-subdomain?label=nich');
		expect(res.statusCode).toBe(200);
		expect(body.data.label).toBe('nich');
		expect(body.data.full).toBe('nich.threews.sol');
		expect(body.data.user).toEqual({
			id: '00000000-0000-0000-0000-000000000001',
			username: 'nich',
			display_name: 'Nicholas',
		});
		expect(body.data.owner_wallet).toBe('HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk');
		expect(body.data.url_record).toBe('https://three.ws/u/nich');
		// Reverse lookups are cached at the edge — verify the hint is there.
		expect(res.getHeader('cache-control')).toMatch(/max-age=120/);
	});

	it('returns 404 when no claim exists for the label', async () => {
		sqlMock.mockResolvedValueOnce([]);
		const { res, body } = await call('/api/users/by-subdomain?label=ghost');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.error_description).toMatch(/not claimed/);
	});

	it('rejects missing label', async () => {
		const { res, body } = await call('/api/users/by-subdomain');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects reserved (denylisted) labels before hitting the DB', async () => {
		const { res, body } = await call('/api/users/by-subdomain?label=admin');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects malformed labels before hitting the DB', async () => {
		const { res, body } = await call('/api/users/by-subdomain?label=!invalid');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects non-GET methods', async () => {
		const { res } = await call('/api/users/by-subdomain?label=nich', 'POST');
		expect(res.statusCode).toBe(405);
	});
});
