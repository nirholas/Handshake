// Tests for api/agents/recovery.js, the HTTP dispatcher behind
// /api/agents/:id/recovery. It is not a routable file of its own: the
// vercel.json rule sends the path to api/agents/[id].js, which imports this
// module and calls it with (req, res, id, action, parts). So nothing exercises
// its authorization gates unless a test does it directly.
//
// tests/agent-recovery.test.js covers the pure state machine in
// api/_lib/agent-recovery.js; this file covers the layer above it: who is
// allowed to read the status, and what an unknown sub-resource answers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000' } }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '127.0.0.1',
	limits: new Proxy({}, { get: () => async () => ({ success: true, limit: 60, remaining: 59, reset: 0 }) }),
}));

const listGuardiansMock = vi.fn();
const getActiveRequestMock = vi.fn();
const getOwnerActivityMock = vi.fn();
vi.mock('../api/_lib/agent-recovery.js', () => ({
	getRecoveryConfig: () => ({ threshold: 2, dead_man: { enabled: false, inactivity_days: 90, grace_days: 14 } }),
	effectiveThreshold: (_c, n) => Math.min(2, n),
	listGuardians: (...a) => listGuardiansMock(...a),
	setGuardiansAndConfig: vi.fn(),
	getOwnerActivity: (...a) => getOwnerActivityMock(...a),
	deadManStatus: () => ({ enabled: false, eligible: false }),
	getActiveRequest: (...a) => getActiveRequestMock(...a),
	decorateRequest: vi.fn(),
	listRequests: vi.fn(async () => []),
	createRecoveryRequest: vi.fn(),
	recordVote: vi.fn(),
	cancelRequest: vi.fn(),
	completeIfReady: vi.fn(),
	ownerCheckIn: vi.fn(),
	armInheritance: vi.fn(),
	confirmInheritance: vi.fn(),
	resolveUserHandle: vi.fn(),
	isUuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)),
	MAX_GUARDIANS: 7,
}));

const { default: recoveryHandler } = await import('../api/agents/recovery.js');

const AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function mkReq({ method = 'GET', url = `/api/agents/${AGENT}/recovery` } = {}) {
	return { method, url, headers: {}, on() {}, destroy() {} };
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false, headersSent: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; this.headersSent = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

// loadContext issues exactly two queries: the agent row, then the caller's roles.
function queueContext({ agent, roles }) {
	let call = 0;
	sqlMock.mockImplementation(() => {
		call += 1;
		if (call === 1) return Promise.resolve(agent ? [agent] : []);
		return Promise.resolve(roles);
	});
}

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset().mockResolvedValue({ id: OWNER });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	listGuardiansMock.mockReset().mockResolvedValue([]);
	getActiveRequestMock.mockReset().mockResolvedValue(null);
	getOwnerActivityMock.mockReset().mockResolvedValue({ lastActiveAt: new Date(0), signals: [] });
});

describe('GET /api/agents/:id/recovery', () => {
	it('returns the full circle to the owner, with the unredacted guardian roster', async () => {
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [],
		});
		listGuardiansMock.mockResolvedValue([
			{ user_id: STRANGER, role: 'guardian', label: 'ke•••@three.ws', avatar_url: null, email_masked: 'ke•••@three.ws' },
		]);

		const res = mkRes();
		await recoveryHandler(mkReq(), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(200);
		const body = parse(res).data;
		expect(body.viewer).toMatchObject({ is_owner: true, is_guardian: false, is_beneficiary: false });
		expect(body.guardian_count).toBe(1);
		// Owners get the raw rows (email_masked included); non-owners get the
		// projected shape asserted below.
		expect(body.guardians[0]).toHaveProperty('email_masked');
		expect(body.dead_man).toHaveProperty('signals');
		expect(body.max_guardians).toBe(7);
	});

	it('redacts the roster and hides the owner-activity signals from a guardian', async () => {
		getSessionUserMock.mockResolvedValue({ id: STRANGER });
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [{ role: 'guardian' }],
		});
		listGuardiansMock.mockResolvedValue([
			{ user_id: STRANGER, role: 'guardian', label: 'ke•••@three.ws', avatar_url: null, email_masked: 'ke•••@three.ws' },
		]);

		const res = mkRes();
		await recoveryHandler(mkReq(), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(200);
		const body = parse(res).data;
		expect(body.viewer).toMatchObject({ is_owner: false, is_guardian: true });
		expect(body.guardians[0]).not.toHaveProperty('email_masked');
		expect(body.guardians[0]).toMatchObject({ role: 'guardian', is_you: true });
		expect(body.dead_man).not.toHaveProperty('signals');
	});

	it('401s an anonymous caller before touching the agent row', async () => {
		getSessionUserMock.mockResolvedValue(null);
		sqlMock.mockResolvedValue([]);

		const res = mkRes();
		await recoveryHandler(mkReq(), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('403s a signed-in caller who is not in the recovery circle', async () => {
		getSessionUserMock.mockResolvedValue({ id: STRANGER });
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [],
		});

		const res = mkRes();
		await recoveryHandler(mkReq(), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('forbidden');
	});

	it('404s an agent that does not exist', async () => {
		queueContext({ agent: null, roles: [] });

		const res = mkRes();
		await recoveryHandler(mkReq(), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});
});

describe('recovery sub-resource dispatch', () => {
	it('405s a method the /recovery resource does not implement', async () => {
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [],
		});

		const res = mkRes();
		await recoveryHandler(mkReq({ method: 'DELETE' }), res, AGENT, null, ['api', 'agents', AGENT, 'recovery']);

		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
	});

	it('404s an unknown sub-resource instead of falling through to the status payload', async () => {
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [],
		});

		const res = mkRes();
		await recoveryHandler(mkReq({ url: `/api/agents/${AGENT}/recovery/bogus` }), res, AGENT, 'bogus', [
			'api', 'agents', AGENT, 'recovery', 'bogus',
		]);

		expect(res.statusCode).toBe(404);
		expect(parse(res).error_description).toBe('unknown recovery resource');
	});

	it('404s a non-uuid request id on an approve without querying for the vote', async () => {
		queueContext({
			agent: { id: AGENT, user_id: OWNER, name: 'Recoverable', meta: {}, avatar_id: null, avatar_url: null },
			roles: [{ role: 'guardian' }],
		});

		const res = mkRes();
		await recoveryHandler(
			mkReq({ method: 'POST', url: `/api/agents/${AGENT}/recovery/requests/not-a-uuid/approve` }),
			res, AGENT, 'requests',
			['api', 'agents', AGENT, 'recovery', 'requests', 'not-a-uuid', 'approve'],
		);

		expect(res.statusCode).toBe(404);
		expect(parse(res).error_description).toBe('recovery request not found');
	});
});
