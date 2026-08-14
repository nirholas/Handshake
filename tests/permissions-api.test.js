// api/permissions/[action].js dispatches six delegation endpoints and had no test
// coverage at all, which is how three defects survived in production code:
//
//   1. verify called `manager.isDelegationDisabled(hash)`, a name the
//      DELEGATION_MANAGER_ABI never declares (the on-chain method is
//      `disabledDelegations`), so every verify that reached the chain threw
//      "not a function" and answered 502. The endpoint was 100% broken.
//   2. list passed an unparsed `limit`/`offset` straight into `LIMIT NaN::int`,
//      turning caller error into a 500 db_error.
//   3. redeem reserved a delegation's spend budget before building the signer but
//      only released it when the on-chain submit failed. A missing RPC URL or a
//      signer that would not initialise burned that budget permanently.
//
// These tests pin all three, plus the auth gates that keep the relayer from
// spending gas for a caller who does not own the delegation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AbiCoder, Interface } from 'ethers';

import { DELEGATION_MANAGER_ABI } from '../src/erc7710/abi.js';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
	hasScope: (granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	},
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const rlOk = { value: true };
const rateLimitStub = vi.fn(async () => ({ success: rlOk.value, reset: 1_000, limit: 10 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		read: (...a) => rateLimitStub(...a),
		strict: (...a) => rateLimitStub(...a),
		permissionsGrant: (...a) => rateLimitStub(...a),
		permissionsRevoke: (...a) => rateLimitStub(...a),
	},
	clientIp: () => '203.0.113.9',
}));

const envStub = {
	APP_ORIGIN: 'http://localhost:3000',
	PERMISSIONS_RELAYER_ENABLED: true,
	AGENT_RELAYER_KEY: '0x' + '11'.repeat(32),
};
vi.mock('../api/_lib/env.js', () => ({ env: envStub }));

vi.mock('../api/_lib/usage.js', () => ({ recordEvent: vi.fn() }));

// The verify path builds a real ethers Contract over whatever provider this
// returns, so the fake runner is what proves the handler asks the chain for the
// method the ABI actually declares.
const providerCalls = [];
const chainDisabled = { value: false };
const providerFails = { value: false };
vi.mock('../api/_lib/evm/rpc.js', () => ({
	evmFallbackProvider: async () => ({
		async call(tx) {
			if (providerFails.value) throw new Error('rpc unreachable');
			providerCalls.push(tx);
			return AbiCoder.defaultAbiCoder().encode(['bool'], [chainDisabled.value]);
		},
		async getNetwork() {
			return { chainId: 84532n, name: 'base-sepolia' };
		},
		async resolveName(n) {
			return n;
		},
	}),
}));

// redeem must never reach a real chain from a unit test; the handler's own
// pre-submit gates are what these cases exercise.
const redeemDelegationMock = vi.fn();
vi.mock('../src/permissions/toolkit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		isDelegationValid: vi.fn(async () => ({ valid: true })),
		redeemDelegation: (...a) => redeemDelegationMock(...a),
	};
});

const { default: handler } = await import('../api/permissions/[action].js');

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELEGATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH = '0x' + 'ab'.repeat(32);
const TARGET = '0x1111111111111111111111111111111111111111';

function mkReq({ action, method = 'GET', query = '', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url: `/api/permissions/${action}${query}`,
		headers: hdrs,
		query: { action },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(cb);
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function call(opts) {
	const req = mkReq(opts);
	const res = mkRes();
	await handler(req, res);
	return res;
}

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => {
		const next = sqlQueue.length ? sqlQueue.shift() : [];
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	});
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	redeemDelegationMock.mockReset();
	providerCalls.length = 0;
	chainDisabled.value = false;
	providerFails.value = false;
	rlOk.value = true;
	envStub.PERMISSIONS_RELAYER_ENABLED = true;
	delete process.env.RPC_URL_137;
});

describe('permissions dispatcher', () => {
	it('404s an action it does not implement', async () => {
		const res = await call({ action: 'bogus' });
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});
});

describe('GET /api/permissions/list', () => {
	it('requires agentId or delegator', async () => {
		const res = await call({ action: 'list' });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('missing_filter');
	});

	it('rejects a non-uuid agentId before it reaches the uuid column', async () => {
		const res = await call({ action: 'list', query: '?agentId=not-a-uuid' });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects an unknown status filter', async () => {
		const res = await call({ action: 'list', query: `?agentId=${AGENT}&status=pending` });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});

	// Regression: `limit=abc` used to reach Postgres as `LIMIT NaN::int` and come
	// back as a 500 db_error, so caller error read as a platform outage.
	it.each(['limit', 'offset'])('rejects a non-numeric %s with 400, not 500', async (param) => {
		const res = await call({ action: 'list', query: `?agentId=${AGENT}&${param}=abc` });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(parse(res).error_description).toContain(param);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('returns the public shape for an agentId-only query without auth', async () => {
		sqlQueue.push([
			{
				id: DELEGATION_ID,
				chain_id: 84532,
				delegator_address: TARGET,
				delegate_address: TARGET,
				delegation_hash: HASH,
				delegation_json: { secret: 'envelope' },
				scope: { token: 'native', maxAmount: '100' },
				status: 'active',
				expires_at: '2030-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z',
				last_redeemed_at: null,
				redemption_count: 0,
			},
		]);
		const res = await call({ action: 'list', query: `?agentId=${AGENT}` });
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.ok).toBe(true);
		expect(body.delegations).toHaveLength(1);
		expect(body.delegations[0].delegationHash).toBe(HASH);
		// The signed envelope is owner-only; the public lane must not leak it.
		expect(body.delegations[0].delegationJson).toBeUndefined();
		expect(res.headers['cache-control']).toContain('max-age=30');
	});

	it('requires a session to filter by delegator', async () => {
		const res = await call({ action: 'list', query: `?delegator=${TARGET}` });
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});

	it('refuses a delegator address the session user does not own', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user-1' });
		sqlQueue.push([]); // wallet ownership lookup: no match
		const res = await call({ action: 'list', query: `?delegator=${TARGET}` });
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('forbidden');
	});
});

describe('GET /api/permissions/metadata', () => {
	it('requires agentId', async () => {
		const res = await call({ action: 'metadata' });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('missing_param');
	});

	it('404s an agent that does not exist', async () => {
		sqlQueue.push([]);
		const res = await call({ action: 'metadata', query: `?agentId=${AGENT}` });
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('agent_not_found');
	});

	it('serves the manifest with an etag and honours if-none-match', async () => {
		const rows = [
			{
				chain_id: 84532,
				delegator_address: TARGET,
				delegate_address: TARGET,
				delegation_hash: HASH,
				delegation_json: { hash: HASH },
				scope: { token: 'native' },
				expires_at: '2030-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z',
				revoked_at: null,
			},
		];
		sqlQueue.push([{ id: AGENT }], rows);
		const first = await call({ action: 'metadata', query: `?agentId=${AGENT}` });
		expect(first.statusCode).toBe(200);
		const body = parse(first);
		expect(body.spec).toBe('erc-7715/0.1');
		expect(body.delegations[0].hash).toBe(HASH);
		const etag = first.headers.etag;
		expect(etag).toBeTruthy();

		sqlQueue.push([{ id: AGENT }], rows);
		const second = await call({
			action: 'metadata',
			query: `?agentId=${AGENT}`,
			headers: { 'if-none-match': etag },
		});
		expect(second.statusCode).toBe(304);
		expect(second.body).toBeUndefined();
	});
});

describe('GET /api/permissions/verify', () => {
	it.each([
		['', 'hash query param is required'],
		['?hash=0xnothex', 'hash must be 0x + 64 hex chars'],
		[`?hash=${HASH}`, 'chainId query param is required'],
		[`?hash=${HASH}&chainId=abc`, 'chainId must be a positive integer'],
		[`?hash=${HASH}&chainId=999999`, 'chainId 999999 is not supported'],
	])('rejects %s', async (query, message) => {
		const res = await call({ action: 'verify', query });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toBe(message);
	});

	// Regression: the handler used to call a method name absent from the ABI, so
	// every on-chain check threw TypeError and the endpoint answered 502 forever.
	it('asks the chain for disabledDelegations(bytes32) and reports a live delegation valid', async () => {
		sqlQueue.push([]); // unknown to the platform
		const res = await call({ action: 'verify', query: `?hash=${HASH}&chainId=84532` });
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.valid).toBe(true);
		expect(body.reason).toBe('unknown_to_platform');
		expect(providerCalls).toHaveLength(1);
		const selector = new Interface(DELEGATION_MANAGER_ABI).getFunction(
			'disabledDelegations',
		).selector;
		expect(providerCalls[0].data.slice(0, 10)).toBe(selector);
	});

	it('reports an on-chain disabled delegation as revoked and self-heals the row', async () => {
		chainDisabled.value = true;
		sqlQueue.push([{ status: 'active', expires_at: '2030-01-01T00:00:00.000Z' }]);
		const res = await call({ action: 'verify', query: `?hash=${HASH}&chainId=84532` });
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.valid).toBe(false);
		expect(body.reason).toBe('delegation_revoked');
	});

	it('short-circuits a DB-revoked delegation without touching the chain', async () => {
		sqlQueue.push([{ status: 'revoked', expires_at: '2030-01-01T00:00:00.000Z' }]);
		const res = await call({ action: 'verify', query: `?hash=${HASH}&chainId=84532` });
		expect(res.statusCode).toBe(200);
		expect(parse(res).reason).toBe('delegation_revoked');
		expect(providerCalls).toHaveLength(0);
	});

	it('surfaces an RPC failure as a 502 with a support ref, not a stack trace', async () => {
		providerFails.value = true;
		sqlQueue.push([]);
		const res = await call({ action: 'verify', query: `?hash=${HASH}&chainId=84532` });
		expect(res.statusCode).toBe(502);
		const body = parse(res);
		expect(body.error).toBe('rpc_error');
		expect(body.ref).toBeTruthy();
		expect(res.body).not.toContain('rpc unreachable');
	});
});

describe('POST /api/permissions/grant', () => {
	it('requires a session', async () => {
		const res = await call({ action: 'grant', method: 'POST', body: {} });
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});

	it('rejects a malformed body with a field-level 400', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user-1' });
		const res = await call({
			action: 'grant',
			method: 'POST',
			body: { agentId: 'nope', chainId: 84532 },
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(parse(res).error_description).toContain('agentId');
	});

	it('rejects a chain with no DelegationManager deployment', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user-1' });
		const res = await call({
			action: 'grant',
			method: 'POST',
			body: {
				agentId: AGENT,
				chainId: 999999,
				delegation: {
					delegator: TARGET,
					delegate: TARGET,
					caveats: [],
					salt: '1',
					signature: '0x00',
					hash: HASH,
				},
				scope: {
					token: 'native',
					maxAmount: '1',
					period: 'daily',
					targets: [TARGET],
					expiry: 4102444800,
				},
			},
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('chain_not_supported');
	});
});

describe('POST /api/permissions/revoke', () => {
	it('requires a session', async () => {
		const res = await call({ action: 'revoke', method: 'POST', body: {} });
		expect(res.statusCode).toBe(401);
	});

	it('rejects a malformed txHash', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'user-1' });
		const res = await call({
			action: 'revoke',
			method: 'POST',
			body: { id: DELEGATION_ID, txHash: '0x1234' },
		});
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('txHash');
	});
});

describe('POST /api/permissions/redeem', () => {
	const okBody = { id: DELEGATION_ID, calls: [{ to: TARGET, value: '5' }] };

	function bearer({ scope = 'permissions:redeem', userId = 'user-1' } = {}) {
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId, scope, apiKeyId: 'key-1' });
	}

	function delegationRow(overrides = {}) {
		return {
			id: DELEGATION_ID,
			agent_id: AGENT,
			chain_id: 84532,
			delegation_hash: HASH,
			delegation_json: { hash: HASH },
			scope: { token: 'native', maxAmount: '100', period: 'daily', targets: [TARGET] },
			status: 'active',
			expires_at: '2030-01-01T00:00:00.000Z',
			redemption_count: 0,
			last_redeemed_at: null,
			...overrides,
		};
	}

	it('503s when the relayer is disabled on this deployment', async () => {
		envStub.PERMISSIONS_RELAYER_ENABLED = false;
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('feature_disabled');
	});

	it('requires a bearer token', async () => {
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(401);
	});

	it('requires the permissions:redeem scope', async () => {
		bearer({ scope: 'profile' });
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('insufficient_scope');
	});

	it('404s a delegation whose agent the caller does not own, without leaking existence', async () => {
		bearer();
		sqlQueue.push([delegationRow()], [{ user_id: 'someone-else' }]);
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('delegation_not_found');
		expect(redeemDelegationMock).not.toHaveBeenCalled();
	});

	it('refuses a call target outside scope.targets', async () => {
		bearer();
		sqlQueue.push([delegationRow()], [{ user_id: 'user-1' }]);
		const res = await call({
			action: 'redeem',
			method: 'POST',
			body: {
				id: DELEGATION_ID,
				calls: [{ to: '0x2222222222222222222222222222222222222222', value: '1' }],
			},
		});
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('target_not_allowed');
		expect(redeemDelegationMock).not.toHaveBeenCalled();
	});

	it('409s a revoked delegation', async () => {
		bearer();
		sqlQueue.push([delegationRow({ status: 'revoked' })], [{ user_id: 'user-1' }]);
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('delegation_revoked');
	});

	it('409s an expired delegation', async () => {
		bearer();
		sqlQueue.push([delegationRow({ expires_at: '2020-01-01T00:00:00.000Z' })], [
			{ user_id: 'user-1' },
		]);
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('delegation_expired');
	});

	it('403s when the atomic reservation finds the period cap already spent', async () => {
		bearer();
		sqlQueue.push(
			[delegationRow()],
			[{ user_id: 'user-1' }],
			[], // reservation INSERT…SELECT materialised no row: over cap
			[{ spent: '100' }],
		);
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(403);
		const body = parse(res);
		expect(body.error).toBe('scope_exceeded');
		expect(body.periodSpent).toBe('100');
		expect(redeemDelegationMock).not.toHaveBeenCalled();
	});

	// Regression: the reservation is written before the signer is built, so an exit
	// between the two has to release it. It used to leak, permanently consuming the
	// delegation's period budget for a request that never touched the chain.
	it('releases the spend reservation when no RPC is configured for the chain', async () => {
		bearer();
		sqlQueue.push(
			[delegationRow({ chain_id: 137 })],
			[{ user_id: 'user-1' }],
			[{ id: 'usage-1', spent_before: '0' }],
			[],
		);
		const res = await call({ action: 'redeem', method: 'POST', body: okBody });
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('rpc_error');
		// Last statement must be the release, keyed on the reservation just written.
		const lastArgs = sqlMock.mock.calls.at(-1);
		expect(lastArgs[0].join('?')).toContain("status = 'failed'");
		expect(lastArgs).toContain('usage-1');
	});
});
