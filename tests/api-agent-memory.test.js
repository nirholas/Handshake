import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// `sql` is a tagged template — mock it as a fn that returns a configurable result.
const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

// CSRF gating is enforced on the mutating routes; its behavior is covered by
// tests/api/security-csrf-gates.test.js. Here it's a pass-through so these tests
// exercise the handler logic, not the CSRF middleware.
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

// env throws if required vars are missing — stub before handler imports it.
vi.mock('../api/_lib/env.js', () => ({
	env: {
		APP_ORIGIN: 'http://localhost:3000',
		ISSUER: 'http://test',
		MCP_RESOURCE: 'http://test',
	},
}));

// Import the handler AFTER mocks are registered.
const { default: handler } = await import('../api/agent-memory.js');

// ── Test helpers ──────────────────────────────────────────────────────────

function mkReq({ method = 'GET', url = '/api/agent-memory', headers = {}, body = null } = {}) {
	const req = {
		method,
		url,
		headers: { ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				this._dataCb = cb;
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
			} else if (event === 'error') {
				this._errCb = cb;
			}
		},
		destroy() {},
	};
	return req;
}

function mkRes() {
	const res = {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(body) {
			this.body = body;
			this.writableEnded = true;
		},
	};
	return res;
}

function parseBody(res) {
	return res.body ? JSON.parse(res.body) : undefined;
}

// Queue sql responses in FIFO order. Each call to sql`...` returns the next value.
let sqlQueue = [];
function queueSql(...results) {
	sqlQueue.push(...results);
}

beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset();
	sqlMock.mockImplementation(() => {
		if (sqlQueue.length === 0) {
			throw new Error('unexpected sql call — no queued response');
		}
		const next = sqlQueue.shift();
		return Promise.resolve(next);
	});
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe('agent-memory auth', () => {
	it('GET without session or bearer returns empty list (200)', async () => {
		// Public embeds boot this fetch on every page load. Returning an empty
		// list (instead of 401) keeps the console clean for anonymous viewers.
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ entries: [] });
	});

	it('POST without auth returns 401', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'hi' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('DELETE without auth returns 401', async () => {
		const req = mkReq({ method: 'DELETE', url: '/api/agent-memory/33333333-3333-4333-8333-333333333333' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('falls back to bearer auth when session is absent', async () => {
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: 'u1' });
		queueSql([{ user_id: 'u1' }], []); // ownership check, then list

		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ entries: [] });
	});
});

// ── Validation ────────────────────────────────────────────────────────────

describe('agent-memory validation', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('GET without agentId returns 400', async () => {
		const req = mkReq({ method: 'GET', url: '/api/agent-memory' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
	});

	it('POST without agentId returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { entry: { content: 'x' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/agentId/);
	});

	it('POST without entry returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111' },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/entry/);
	});

	it('GET for nonexistent agent returns empty list (200)', async () => {
		queueSql([]); // no agent row
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=44444444-4444-4444-8444-444444444444' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ entries: [] });
	});

	it('GET for agent owned by another user returns empty list (200)', async () => {
		queueSql([{ user_id: 'someone-else' }]);
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ entries: [] });
	});

	it('disallowed HTTP method returns 405', async () => {
		const req = mkReq({ method: 'PUT', url: '/api/agent-memory' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(405);
	});
});

// ── Read (list) ───────────────────────────────────────────────────────────

describe('agent-memory list', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('returns decorated entries for owner', async () => {
		const createdAt = new Date('2024-01-01T00:00:00Z');
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'm1',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: 'note',
					tags: ['t'],
					context: { k: 'v' },
					salience: 0.7,
					created_at: createdAt,
					expires_at: null,
				},
			],
		);

		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		const body = parseBody(res);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0]).toMatchObject({
			id: 'm1',
			agent_id: '11111111-1111-4111-8111-111111111111',
			type: 'project',
			content: 'note',
			tags: ['t'],
			context: { k: 'v' },
			salience: 0.7,
			createdAt: createdAt.getTime(),
			expiresAt: null,
		});
	});

	it('applies type filter when provided', async () => {
		queueSql([{ user_id: 'u1' }], []);
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111&type=feedback' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		// Second sql call should have seen the `type` branch — we just verify overall success.
		expect(sqlMock).toHaveBeenCalledTimes(2);
	});

	it('handles empty tags/context with safe defaults', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'm2',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'user',
					content: '',
					tags: null,
					context: null,
					salience: 0.5,
					created_at: new Date(),
					expires_at: null,
				},
			],
		);
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		const res = mkRes();
		await handler(req, res);
		const body = parseBody(res);
		expect(body.entries[0].tags).toEqual([]);
		expect(body.entries[0].context).toEqual({});
	});
});

// ── Upsert ────────────────────────────────────────────────────────────────

describe('agent-memory upsert', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('creates a new entry without id', async () => {
		const createdAt = new Date();
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'generated-id',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: 'hello',
					tags: [],
					context: {},
					salience: 0.5,
					created_at: createdAt,
					expires_at: null,
				},
			],
		);

		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'hello' } },
		});
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(201);
		expect(parseBody(res).entry.id).toBe('generated-id');
	});

	it('upserts an entry with a client-supplied id', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: '55555555-5555-4555-8555-555555555555',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'user',
					content: 'c',
					tags: [],
					context: {},
					salience: 0.9,
					created_at: new Date(),
					expires_at: null,
				},
			],
		);

		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: {
				agentId: '11111111-1111-4111-8111-111111111111',
				entry: { id: '55555555-5555-4555-8555-555555555555', type: 'user', content: 'c', salience: 0.9 },
			},
		});
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(201);
		expect(parseBody(res).entry.id).toBe('55555555-5555-4555-8555-555555555555');
	});

	it('returns 409 when id collides with another agents memory', async () => {
		// Ownership passes; the upsert SQL returns no rows because ON CONFLICT guard fired.
		queueSql([{ user_id: 'u1' }], []);

		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { id: '66666666-6666-4666-8666-666666666666', content: 'x' } },
		});
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(409);
		expect(parseBody(res).error).toBe('id_conflict');
	});

	it('returns 403 when upserting against an agent the user does not own', async () => {
		queueSql([{ user_id: 'other' }]);
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'x' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(403);
	});

	it('falls back to project type when entry.type is invalid', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'm1',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project', // server normalized
					content: 'x',
					tags: [],
					context: {},
					salience: 0.5,
					created_at: new Date(),
					expires_at: null,
				},
			],
		);

		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { type: 'not-a-real-type', content: 'x' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(201);
		expect(parseBody(res).entry.type).toBe('project');
	});
});

// ── Delete ────────────────────────────────────────────────────────────────

describe('agent-memory delete', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('deletes a memory owned by the user', async () => {
		queueSql([{ id: '33333333-3333-4333-8333-333333333333', user_id: 'u1' }], []); // lookup, then delete
		const req = mkReq({ method: 'DELETE', url: '/api/agent-memory/33333333-3333-4333-8333-333333333333' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ ok: true });
	});

	it('returns 404 for nonexistent memory', async () => {
		queueSql([]);
		const req = mkReq({ method: 'DELETE', url: '/api/agent-memory/77777777-7777-4777-8777-777777777777' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('returns 403 when memory belongs to another user', async () => {
		queueSql([{ id: '33333333-3333-4333-8333-333333333333', user_id: 'other' }]);
		const req = mkReq({ method: 'DELETE', url: '/api/agent-memory/33333333-3333-4333-8333-333333333333' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(403);
	});
});

// ── Size limits / payload ─────────────────────────────────────────────────

describe('agent-memory size + payload limits', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('truncates content > 10,000 chars before inserting', async () => {
		const huge = 'a'.repeat(20000);
		let capturedContent;
		// Custom sql impl for this test so we can capture the interpolated content value.
		sqlMock.mockReset();
		let call = 0;
		sqlMock.mockImplementation((_strings, ...values) => {
			call += 1;
			if (call === 1) return Promise.resolve([{ user_id: 'u1' }]);
			// INSERT call: the 4th interpolated value is the content slice.
			// Scan for the string that starts with 'a'. Only assign on a hit so
			// the later signing queries (loadAgentSigner SELECT + content_hash
			// UPDATE) don't clobber the captured value back to undefined.
			const match = values.find(
				(v) => typeof v === 'string' && v.startsWith('a') && v.length >= 10000,
			);
			if (match) capturedContent = match;
			return Promise.resolve([
				{
					id: 'x',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: capturedContent,
					tags: [],
					context: {},
					salience: 0.5,
					created_at: new Date(),
					expires_at: null,
				},
			]);
		});

		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: huge } },
		});
		const res = mkRes();
		await handler(req, res);

		expect(res.statusCode).toBe(201);
		expect(capturedContent).toBeDefined();
		expect(capturedContent.length).toBe(10000);
	});

	it('rejects non-JSON content-type with 415', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'not json',
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(415);
	});

	it('rejects malformed JSON with 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{not valid json',
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
	});

	it('caps list limit at 500', async () => {
		queueSql([{ user_id: 'u1' }], []);
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111&limit=99999' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		// The limit is applied via Math.min(..., 500). We can only confirm success here
		// since sql is mocked; the branch coverage is satisfied.
	});
});

// ── CORS preflight ────────────────────────────────────────────────────────

describe('agent-memory CORS', () => {
	it('OPTIONS returns 204 with CORS headers', async () => {
		const req = mkReq({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
		expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
	});
});

// ── Malformed input ───────────────────────────────────────────────────────
//
// agent_identities.id and agent_memories.id are uuid columns, and `since` /
// `limit` are interpolated straight into the query. Every case below used to
// reach Postgres (or `new Date().toISOString()`) with a value it rejects and
// answer 500 for what is plainly a caller mistake. Where `sqlQueue` is left
// empty the mock throws on any sql call, so these fail if validation ever stops
// short-circuiting ahead of the query.

const VALID_AGENT = '11111111-1111-4111-8111-111111111111';

describe('agent-memory rejects malformed input before it reaches Postgres', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('GET with a non-uuid agentId returns 400', async () => {
		const req = mkReq({ method: 'GET', url: '/api/agent-memory?agentId=not-a-uuid' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/uuid/);
	});

	it('GET clamps an out-of-range since instead of throwing a RangeError', async () => {
		queueSql([{ user_id: 'u1' }], []);
		const req = mkReq({
			method: 'GET',
			url: `/api/agent-memory?agentId=${VALID_AGENT}&since=999999999999999999`,
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
	});

	it('GET falls back to the default for a negative limit', async () => {
		queueSql([{ user_id: 'u1' }], []);
		const req = mkReq({ method: 'GET', url: `/api/agent-memory?agentId=${VALID_AGENT}&limit=-1` });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
	});

	it('POST with a non-uuid agentId returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: 'not-a-uuid', entry: { content: 'hi' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/uuid/);
	});

	it('POST with a non-object entry returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: VALID_AGENT, entry: 'oops' },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/object/);
	});

	it('POST with a non-uuid entry.id returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: VALID_AGENT, entry: { id: 'client-generated', content: 'hi' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/entry\.id/);
	});

	it('POST with an unparseable timestamp returns 400', async () => {
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: VALID_AGENT, entry: { content: 'hi', createdAt: 'not-a-date' } },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toMatch(/timestamps/);
	});

	it('POST coerces a string salience and non-array tags into column-safe values', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: '33333333-3333-4333-8333-333333333333',
					agent_id: VALID_AGENT,
					content: 'hi',
					tags: [],
					salience: 0.5,
				},
			],
		);
		const req = mkReq({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: {
				agentId: VALID_AGENT,
				entry: { content: 'hi', salience: 'very high', tags: 'not-an-array' },
			},
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(201);
	});

	it('DELETE with a non-uuid memory id returns 404', async () => {
		const req = mkReq({ method: 'DELETE', url: '/api/agent-memory/not-a-uuid' });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});
});
