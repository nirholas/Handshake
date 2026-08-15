// Route-level tests for POST/DELETE /api/agents/:id/memory/seed/github.
//
// The pure narrowing (catalog, selection, seed document, memory rows) is covered
// in tests/github-memory-seed.test.js. What is covered here is the ordering the
// route imposes around it, which is where three defects lived: a cookie POST
// that carried no CSRF token, a rejected selection that still spent the agent's
// 6-hour seed budget, and an exhausted LLM chain that surfaced as a bare
// internal error while the budget stayed spent.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
sqlMock.transaction = vi.fn(async () => []);
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
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

const requireCsrfMock = vi.fn();
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const githubSeedLimit = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { githubSeed: (...a) => githubSeedLimit(...a) },
	clientIp: () => '127.0.0.1',
}));

const llmCompleteMock = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({ llmComplete: (...a) => llmCompleteMock(...a) }));

vi.mock('../api/_lib/github-token.js', () => ({ decryptGithubToken: async () => 'gh-token' }));

const fetchProfileMock = vi.fn();
const fetchReposMock = vi.fn();
const fetchPinnedReposMock = vi.fn();
const fetchReadmeMock = vi.fn();
vi.mock('../api/_lib/github-api.js', () => ({
	fetchProfile: (...a) => fetchProfileMock(...a),
	fetchRepos: (...a) => fetchReposMock(...a),
	fetchPinnedRepos: (...a) => fetchPinnedReposMock(...a),
	fetchReadme: (...a) => fetchReadmeMock(...a),
}));

const { default: handler } = await import('../api/agents/[id]/memory-seed-github.js');

const AGENT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';

function mkReq({ method = 'POST', headers = {}, body = null } = {}) {
	return {
		method,
		url: `/api/agents/${AGENT}/memory/seed/github`,
		query: { id: AGENT },
		headers: { ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
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
		headersSent: false,
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
const post = (body, headers = {}) =>
	mkReq({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

beforeEach(() => {
	// Owned-agent lookup, then the github social_connection row.
	sqlMock.mockReset().mockImplementation(() => Promise.resolve([]));
	sqlMock.transaction.mockReset().mockResolvedValue([]);
	getSessionUserMock.mockReset().mockResolvedValue({ id: USER });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	requireCsrfMock.mockReset().mockResolvedValue(true);
	githubSeedLimit.mockReset().mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: Date.now() + 21_600_000 });
	llmCompleteMock.mockReset().mockResolvedValue({ text: '["A fact about the owner."]' });
	fetchProfileMock.mockReset().mockResolvedValue({ login: 'dev', name: 'Dev', public_repos: 2, followers: 3 });
	fetchPinnedReposMock.mockReset().mockResolvedValue([
		{ full_name: 'dev/kit', name: 'kit', description: 'A kit', language: 'JavaScript', stargazers_count: 5 },
	]);
	fetchReposMock.mockReset().mockResolvedValue([]);
	fetchReadmeMock.mockReset().mockResolvedValue('# kit\n\nWhat the kit does.');
});

/** Agent-owned + connected: the two queries every mutation makes first. */
function connected() {
	let call = 0;
	sqlMock.mockImplementation(() => {
		call += 1;
		if (call === 1) return Promise.resolve([{ id: AGENT }]);
		if (call === 2) return Promise.resolve([{ id: 'conn', username: 'dev', access_token: 'enc', connected_at: null }]);
		return Promise.resolve([]);
	});
}

describe('CSRF on the seeding mutations', () => {
	it('POST is refused when the CSRF gate fails, before GitHub is read', async () => {
		connected();
		requireCsrfMock.mockImplementation(async (req, res) => {
			res.statusCode = 403;
			res.end(JSON.stringify({ error: 'csrf_missing' }));
			return false;
		});
		const res = mkRes();
		await handler(post({ include_profile: true, repos: [], readmes: [] }), res);
		expect(res.statusCode).toBe(403);
		expect(fetchProfileMock).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
		expect(sqlMock.transaction).not.toHaveBeenCalled();
	});

	it('DELETE is refused when the CSRF gate fails, and deletes nothing', async () => {
		connected();
		requireCsrfMock.mockImplementation(async (req, res) => {
			res.statusCode = 403;
			res.end(JSON.stringify({ error: 'csrf_missing' }));
			return false;
		});
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE' }), res);
		expect(res.statusCode).toBe(403);
		// Only the ownership lookup ran; the DELETE … RETURNING never did.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('a valid token lets the seed through', async () => {
		connected();
		const res = mkRes();
		await handler(post({ include_profile: true, repos: ['dev/kit'], readmes: [] }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).seeded).toBe(1);
		expect(requireCsrfMock).toHaveBeenCalled();
	});
});

describe('the 6-hour seed budget', () => {
	it('is not spent by an empty selection', async () => {
		connected();
		const res = mkRes();
		await handler(post({ include_profile: false, repos: [], readmes: [] }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('empty_selection');
		expect(githubSeedLimit).not.toHaveBeenCalled();
	});

	it('is not spent by a selection naming a repo outside the catalog', async () => {
		connected();
		const res = mkRes();
		await handler(post({ include_profile: true, repos: ['someone/else'], readmes: [] }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_selection');
		expect(parse(res).rejected).toEqual([{ key: 'someone/else', reason: 'not_in_catalog' }]);
		expect(githubSeedLimit).not.toHaveBeenCalled();
	});

	it('is spent once the selection is good, and blocks the next run', async () => {
		connected();
		githubSeedLimit.mockResolvedValue({ success: false, limit: 1, remaining: 0, reset: Date.now() + 60_000 });
		const res = mkRes();
		await handler(post({ include_profile: true, repos: ['dev/kit'], readmes: [] }), res);
		expect(res.statusCode).toBe(429);
		expect(githubSeedLimit).toHaveBeenCalledWith(AGENT);
		// Refused before anything was read or written.
		expect(fetchReadmeMock).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
		expect(sqlMock.transaction).not.toHaveBeenCalled();
	});
});

describe('when every model provider is busy', () => {
	it('answers 503 distill_unavailable and leaves the existing memories alone', async () => {
		connected();
		llmCompleteMock.mockRejectedValue(
			Object.assign(new Error('chain exhausted'), {
				status: 502,
				code: 'upstream_error',
				attempts: [{ provider: 'ovh' }, { provider: 'pollinations' }],
			}),
		);
		const res = mkRes();
		await handler(post({ include_profile: true, repos: ['dev/kit'], readmes: [] }), res);
		expect(res.statusCode).toBe(503);
		const body = parse(res);
		expect(body.error).toBe('distill_unavailable');
		expect(body.error_description).toMatch(/nothing was seeded/);
		expect(body.providers_tried).toEqual(['ovh', 'pollinations']);
		expect(typeof body.retry_at).toBe('string');
		expect(sqlMock.transaction).not.toHaveBeenCalled();
	});

	it('still answers distill_error when the material yields no facts', async () => {
		connected();
		llmCompleteMock.mockResolvedValue({ text: '[]' });
		const res = mkRes();
		await handler(post({ include_profile: true, repos: ['dev/kit'], readmes: [] }), res);
		expect(res.statusCode).toBe(502);
		expect(parse(res).error).toBe('distill_error');
		expect(sqlMock.transaction).not.toHaveBeenCalled();
	});
});

describe('the README narrowing survives the route', () => {
	it('reads a README only for a repo that was also ticked', async () => {
		connected();
		const res = mkRes();
		await handler(post({ include_profile: false, repos: ['dev/kit'], readmes: ['dev/kit'] }), res);
		expect(res.statusCode).toBe(200);
		expect(fetchReadmeMock).toHaveBeenCalledTimes(1);
		expect(fetchReadmeMock).toHaveBeenCalledWith('gh-token', 'dev/kit');
		expect(parse(res).readmes_read).toEqual(['dev/kit']);
	});

	it('refuses a README for a repo that was not ticked, reading nothing', async () => {
		connected();
		fetchReposMock.mockResolvedValue([
			{ full_name: 'dev/other', name: 'other', description: null, pushed_at: '2026-01-01T00:00:00Z' },
		]);
		const res = mkRes();
		await handler(post({ include_profile: false, repos: ['dev/kit'], readmes: ['dev/other'] }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).rejected).toEqual([{ key: 'dev/other', reason: 'readme_without_repo' }]);
		expect(fetchReadmeMock).not.toHaveBeenCalled();
	});
});
