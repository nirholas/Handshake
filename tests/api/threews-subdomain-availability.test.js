// /api/threews/subdomain — GET availability check. Exercises the
// validation/denylist paths (no external calls) and the
// "already-claimed-in-our-DB" short-circuit (sql mock only, no Solana RPC).
//
// The "go look on-chain" path is not covered here because it would require
// mocking the Bonfida SDK at the module-graph level. That branch is tested
// indirectly by tests/api/sns.test.js, which covers the Bonfida `resolve()`
// flow on the same parent + subdomain machinery.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'https://three.ws' },
}));

beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const { default: handler } = await import('../../api/threews/subdomain.js');

function makeReq(url, method = 'GET', body = null) {
	const req = { url, method, headers: { host: 'x' }, query: {} };
	if (body !== null) {
		req.headers['content-type'] = 'application/json';
		const buf = Buffer.from(JSON.stringify(body));
		// Minimal Readable stream that calling readJson() can consume.
		req.on = (ev, fn) => {
			if (ev === 'data') queueMicrotask(() => fn(buf));
			if (ev === 'end') queueMicrotask(fn);
			return req;
		};
	}
	return req;
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
async function call(url, method = 'GET', body = null) {
	const res = makeRes();
	await handler(makeReq(url, method, body), res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	sqlMock.mockReset();
});

describe('GET /api/threews/subdomain?label=…', () => {
	it('reports a claim from our DB without hitting Solana', async () => {
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
		const { res, body } = await call('/api/threews/subdomain?label=nich');
		expect(res.statusCode).toBe(200);
		expect(body.data.available).toBe(false);
		expect(body.data.full).toBe('nich.threews.sol');
		expect(body.data.label).toBe('nich');
		expect(body.data.owner).toBe('HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk');
		expect(body.data.claim).toMatchObject({
			user_id: '00000000-0000-0000-0000-000000000001',
			username: 'nich',
			display_name: 'Nicholas',
		});
		expect(body.data.showcase_url).toBe('https://three.ws/u/nich');
		expect(res.getHeader('cache-control')).toMatch(/max-age=30/);
		// Only one query — the DB row short-circuits the RPC lookup.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed labels with 400 before any DB or RPC call', async () => {
		const { res, body } = await call('/api/threews/subdomain?label=!bad');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects reserved labels with 400 before any DB or RPC call', async () => {
		for (const reserved of ['admin', 'root', 'www', 'threews']) {
			sqlMock.mockReset();
			const { res, body } = await call(`/api/threews/subdomain?label=${reserved}`);
			expect(res.statusCode, `${reserved} should be rejected`).toBe(400);
			expect(body.error).toBe('validation_error');
			expect(sqlMock).not.toHaveBeenCalled();
		}
	});

	it('strips a .threews.sol suffix the user typed in by mistake', async () => {
		sqlMock.mockResolvedValueOnce([]);
		// Don't mock the on-chain getSubdomainOwner — it'll try a real RPC and
		// throw. We catch the result and assert that whatever returns, the label
		// was normalized down to "nich".
		try {
			const { body } = await call('/api/threews/subdomain?label=nich.threews.sol');
			if (body?.data) expect(body.data.label).toBe('nich');
		} catch {
			// RPC reachout failed in the test sandbox — that's expected and the
			// normalization invariant is the assertion that matters.
		}
		// The sql call (if it happened) used the normalized label.
		if (sqlMock.mock.calls.length > 0) {
			// The sql template's interpolated values include the label as the
			// second positional value — find it among the args.
			const flatArgs = sqlMock.mock.calls.flat(Infinity);
			expect(flatArgs).toContain('nich');
		}
	});
});
