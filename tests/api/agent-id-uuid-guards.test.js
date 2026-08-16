// agent_identities.id is a uuid column. Four handlers took the agent id straight
// off the request body or query and interpolated it into `WHERE id = $1`, so a
// caller typo reached Postgres as an uncastable literal (SQLSTATE 22P02). The
// caller saw a 500 (agent-ask, agent-collab) or a 502 blaming the LLM
// (agent-delegate) for what is plainly a malformed request. This pins the 400,
// and pins that no query is attempted. agent-detail-og is here for the sibling
// gap: it is a GET-only crawler read that answered its 302 passthrough to any
// method.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

const authState = { session: null };
const sqlState = { calls: [] };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	mintAccessToken: vi.fn(async () => 'test-token'),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		agentDelegate: vi.fn(async () => ({ success: true })),
		apiIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const { default: askHandler } = await import('../../api/agent-ask.js');
const { default: collabHandler } = await import('../../api/agent-collab.js');
const { default: delegateHandler } = await import('../../api/agent-delegate.js');
const { default: detailOgHandler } = await import('../../api/agent-detail-og.js');

const BAD_ID = 'not-a-uuid';

beforeEach(() => {
	authState.session = { id: 'owner-user' };
	sqlState.calls = [];
});

describe('agent id uuid guards', () => {
	it('agent-ask answers 400 for a malformed agentId', async () => {
		const { status, body } = await invoke(askHandler, {
			method: 'POST',
			url: '/api/agent-ask',
			body: { agentId: BAD_ID, question: 'hello' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_agent_id');
		expect(sqlState.calls).toHaveLength(0);
	});

	it('agent-collab answers 400 for a malformed leadAgentId', async () => {
		const { status, body } = await invoke(collabHandler, {
			method: 'POST',
			url: '/api/agent-collab',
			body: { leadAgentId: BAD_ID, goal: 'ship the thing' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toMatch(/uuid/);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('agent-delegate answers 400 for a malformed toAgentId, not a 502', async () => {
		const { status, body } = await invoke(delegateHandler, {
			method: 'POST',
			url: '/api/agent-delegate',
			body: { toAgentId: BAD_ID, message: 'hello' },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toMatch(/uuid/);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('agent-detail-og rejects a non-GET method with 405', async () => {
		const { status } = await invoke(detailOgHandler, {
			method: 'POST',
			url: '/api/agent-detail-og?id=00000000-0000-4000-8000-000000000001',
		});
		expect(status).toBe(405);
		expect(sqlState.calls).toHaveLength(0);
	});
});
