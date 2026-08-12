// Tests for /api/agents/:id/activate (api/agents/_id/activate.js), the
// owner-only activation-grant endpoint.
//
// The grant itself (treasury transfer, custody recording, eligibility rules)
// lives in api/_lib/agent-activation.js and is covered by
// tests/agent-activation.test.js. What this pins at the HTTP boundary: auth is
// enforced before anything else, a bearer POST without avatars:write scope is a
// 403, GET hands the caller the status payload, and the POST result-to-status
// mapping never lets a business failure (cap reached, treasury low) surface as
// a bare 500.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a2';
const OWNER_ID = 'user-owner';

let agentRow = { id: AGENT_ID, user_id: OWNER_ID, name: 'Audit Bot', meta: {} };
const sqlMock = vi.fn(async () => (agentRow ? [agentRow] : []));
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = { id: OWNER_ID };
let bearerResult = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => bearerResult),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn((scope, need) => String(scope || '').split(/[\s,]+/).includes(need)),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const statusMock = vi.fn(async () => ({ enabled: false, eligible: false, reason: 'not_configured' }));
const activateMock = vi.fn(async () => ({ ok: true, tx: 'sig' }));
vi.mock('../../api/_lib/agent-activation.js', () => ({
	getActivationStatus: (...a) => statusMock(...a),
	activateAgent: (...a) => activateMock(...a),
}));

const { default: handler } = await import('../../api/agents/_id/activate.js');

async function invoke({ method = 'GET', headers = {} } = {}) {
	const req = makeReq({ method, url: `/api/agents/${AGENT_ID}/activate`, headers, body: method === 'POST' ? {} : null });
	const res = makeRes();
	await handler(req, res, AGENT_ID);
	return res;
}

beforeEach(() => {
	sessionUser = { id: OWNER_ID };
	bearerResult = null;
	agentRow = { id: AGENT_ID, user_id: OWNER_ID, name: 'Audit Bot', meta: {} };
	activateMock.mockResolvedValue({ ok: true, tx: 'sig' });
	vi.clearAllMocks();
});

describe('/api/agents/:id/activate', () => {
	it('GET returns the activation status for the owner', async () => {
		const res = await invoke();
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).data.reason).toBe('not_configured');
		expect(statusMock).toHaveBeenCalledOnce();
	});

	it('GET 401s without auth', async () => {
		sessionUser = null;
		const res = await invoke();
		expect(res.statusCode).toBe(401);
		expect(statusMock).not.toHaveBeenCalled();
	});

	it('GET 404s for an agent the caller does not own', async () => {
		agentRow = null;
		const res = await invoke();
		expect(res.statusCode).toBe(404);
	});

	it('POST 403s for an authenticated non-owner', async () => {
		sessionUser = { id: 'user-other' };
		const res = await invoke({ method: 'POST' });
		expect(res.statusCode).toBe(403);
		expect(activateMock).not.toHaveBeenCalled();
	});

	it('POST 403s for a bearer token without avatars:write scope', async () => {
		sessionUser = null;
		bearerResult = { userId: OWNER_ID, scope: 'read' };
		const res = await invoke({ method: 'POST', headers: { authorization: 'Bearer tok' } });
		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.body).error).toBe('insufficient_scope');
		expect(activateMock).not.toHaveBeenCalled();
	});

	it('POST activates for the owner and returns the result', async () => {
		const res = await invoke({ method: 'POST' });
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).data.ok).toBe(true);
		expect(activateMock).toHaveBeenCalledWith({ agentId: AGENT_ID, userId: OWNER_ID });
	});

	it('POST maps business failures to their status codes, never a 500', async () => {
		activateMock.mockResolvedValue({ ok: false, code: 'cap_reached', message: 'daily cap' });
		const res = await invoke({ method: 'POST' });
		expect(res.statusCode).toBe(429);
		expect(JSON.parse(res.body).error).toBe('cap_reached');

		activateMock.mockResolvedValue({ ok: false, code: 'treasury_low', message: 'treasury low' });
		const res2 = await invoke({ method: 'POST' });
		expect(res2.statusCode).toBe(503);
	});

	it('rejects unsupported methods with 405', async () => {
		const res = await invoke({ method: 'DELETE' });
		expect(res.statusCode).toBe(405);
	});
});
