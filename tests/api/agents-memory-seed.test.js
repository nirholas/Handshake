// Tests for POST /api/agents/:id/memory-seed (api/agents/_id/memory-seed.js),
// the preset GitHub seed.
//
// The catalog/selection/facts logic lives in api/_lib/github-seed.js and is
// covered by tests/github-memory-seed.test.js. What this pins at the boundary:
// auth and ownership are enforced before any GitHub token is touched, a user
// without a GitHub connection gets the actionable 412 (never a crash), the
// happy path distills facts and writes them through ONE transaction that first
// clears the previous seed, and the CSRF gate runs on session-cookie writes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a4';
const OWNER_ID = 'user-owner';

let agentRow = { id: AGENT_ID };
let connRow = { access_token: 'encrypted', username: 'auditagent02' };
const txCalls = [];
const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	const fragment = { strings, values, q };
	if (/from agent_identities/i.test(q)) Object.assign(fragment, { _rows: agentRow ? [agentRow] : [] });
	if (/from social_connections/i.test(q)) Object.assign(fragment, { _rows: connRow ? [connRow] : [] });
	return Object.assign(Promise.resolve(fragment._rows ?? []), fragment);
});
sqlMock.transaction = vi.fn(async (fragments) => {
	txCalls.push(fragments.map((f) => f.q || String(f.strings?.join(' ') || f)));
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = { id: OWNER_ID };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const csrfMock = vi.fn(async () => true);
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => csrfMock(...a) }));

// The real requireCsrf writes the 403 itself and returns false; the mock must
// do the same so the handler's early return leaves a faithful response.
function csrfReject(_req, res) {
	res.statusCode = 403;
	res.end(JSON.stringify({ error: 'csrf_invalid', error_description: 'CSRF token invalid or expired' }));
	return false;
}

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { memorySeed: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/github-token.js', () => ({
	decryptGithubToken: vi.fn(async () => 'ghp_plain'),
}));

vi.mock('../../api/_lib/github-api.js', () => ({
	fetchProfile: vi.fn(async () => ({ login: 'auditagent02', name: 'Audit', bio: 'probe', public_repos: 1 })),
	fetchPinnedRepos: vi.fn(async () => [{ full_name: 'auditagent02/pinned-one', name: 'pinned-one', description: 'd', html_url: 'https://github.com/auditagent02/pinned-one' }]),
	fetchRepos: vi.fn(async () => [{ full_name: 'auditagent02/repo-one', name: 'repo-one', description: 'd', html_url: 'https://github.com/auditagent02/repo-one' }]),
	fetchReadme: vi.fn(async () => '# pinned-one\na readme'),
}));

const llmMock = vi.fn(async () => ({ text: '["ships TypeScript CLI tools","maintains the audit harness"]' }));
vi.mock('../../api/_lib/llm.js', () => ({ llmComplete: (...a) => llmMock(...a) }));

const { default: handleMemorySeed } = await import('../../api/agents/_id/memory-seed.js');

async function invoke(body = {}) {
	const req = makeReq({ method: 'POST', url: `/api/agents/${AGENT_ID}/memory-seed`, body });
	const res = makeRes();
	await handleMemorySeed(req, res, AGENT_ID);
	return res;
}

beforeEach(() => {
	sessionUser = { id: OWNER_ID };
	agentRow = { id: AGENT_ID };
	connRow = { access_token: 'encrypted', username: 'auditagent02' };
	txCalls.length = 0;
	vi.clearAllMocks();
	sqlMock.transaction.mockClear();
});

describe('POST /api/agents/:id/memory-seed', () => {
	it('seeds memories from the default catalog through one atomic transaction', async () => {
		const res = await invoke();
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.seeded).toBe(2);
		expect(body.facts).toEqual(['ships TypeScript CLI tools', 'maintains the audit harness']);
		expect(body.selection).toBeDefined();

		// The previous seed is cleared and the new rows inserted atomically.
		expect(sqlMock.transaction).toHaveBeenCalledOnce();
		const statements = txCalls[0];
		expect(statements[0]).toMatch(/delete from agent_memories/i);
		expect(statements.length).toBe(1 + 2);
		expect(statements.slice(1).every((s) => /insert into agent_memories/i.test(s))).toBe(true);
	});

	it('runs the CSRF gate for session-cookie writes', async () => {
		await invoke();
		expect(csrfMock).toHaveBeenCalled();
	});

	it('aborts before touching GitHub when CSRF fails', async () => {
		csrfMock.mockImplementationOnce(csrfReject);
		const res = await invoke();
		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.body).error).toBe('csrf_invalid');
		const { decryptGithubToken } = await import('../../api/_lib/github-token.js');
		expect(decryptGithubToken).not.toHaveBeenCalled();
	});

	it('401s without auth', async () => {
		sessionUser = null;
		const res = await invoke();
		expect(res.statusCode).toBe(401);
	});

	it('404s for an agent the caller does not own', async () => {
		agentRow = null;
		const res = await invoke();
		expect(res.statusCode).toBe(404);
	});

	it('412s with an actionable error when GitHub is not connected', async () => {
		connRow = null;
		const res = await invoke();
		expect(res.statusCode).toBe(412);
		expect(JSON.parse(res.body).error).toBe('not_connected');
	});

	it('405s on GET', async () => {
		const req = makeReq({ method: 'GET', url: `/api/agents/${AGENT_ID}/memory-seed` });
		const res = makeRes();
		await handleMemorySeed(req, res, AGENT_ID);
		expect(res.statusCode).toBe(405);
	});
});
