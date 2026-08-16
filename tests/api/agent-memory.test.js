import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

// CSRF gating is enforced on the mutating routes; its behavior is covered by
// tests/api/security-csrf-gates.test.js. Here it's a pass-through.
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../../api/_lib/env.js', () => ({
	env: {
		APP_ORIGIN: 'http://localhost:3000',
		ISSUER: 'http://test',
		MCP_RESOURCE: 'http://test',
	},
}));

const { default: handler } = await import('../../api/agent-memory.js');

// ── Helpers ───────────────────────────────────────────────────────────────

function mkReq({ method = 'GET', url = '/api/agent-memory', headers = {}, body = null } = {}) {
	const req = {
		method,
		url,
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
			} else if (event === 'error') {
				// no-op
			}
		},
		destroy() {},
	};
	return req;
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
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

function parse(res) {
	return res.body ? JSON.parse(res.body) : undefined;
}

// Queue sql results FIFO. Each sql`...` call consumes one.
let sqlQueue = [];
function queueSql(...results) {
	sqlQueue.push(...results);
}

async function invoke(reqOpts) {
	const req = mkReq(reqOpts);
	const res = mkRes();
	await handler(req, res);
	return { res, status: res.statusCode, body: parse(res) };
}

// ── Reset ─────────────────────────────────────────────────────────────────

beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset();
	sqlMock.mockImplementation(() => {
		if (sqlQueue.length === 0) throw new Error('unexpected sql call — queue is empty');
		return Promise.resolve(sqlQueue.shift());
	});
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe('auth', () => {
	it('GET without session or bearer returns empty list (200)', async () => {
		// Public embeds boot this fetch on every page load. Returning an empty
		// list (instead of 401) keeps the console clean for anonymous viewers.
		const { status, body } = await invoke({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		expect(status).toBe(200);
		expect(body.entries).toEqual([]);
	});

	it('POST without auth returns 401', async () => {
		const { status } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'x' } },
		});
		expect(status).toBe(401);
	});

	it('DELETE without auth returns 401', async () => {
		const { status } = await invoke({ method: 'DELETE', url: '/api/agent-memory/55555555-5555-4555-8555-555555555555' });
		expect(status).toBe(401);
	});

	it('accepts bearer token when session is absent', async () => {
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: 'u1' });
		queueSql([{ user_id: 'u1' }], []); // ownership row, then memory rows

		const { status, body } = await invoke({
			method: 'GET',
			url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111',
		});
		expect(status).toBe(200);
		expect(body.entries).toEqual([]);
	});
});

// ── GET (list) ────────────────────────────────────────────────────────────

describe('GET /api/agent-memory', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('returns entries for the authenticated agent owner', async () => {
		const createdAt = new Date('2024-06-01T00:00:00Z');
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'm1',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: 'test note',
					tags: ['alpha'],
					context: { k: 1 },
					salience: 0.8,
					created_at: createdAt,
					expires_at: null,
				},
			],
		);

		const { status, body } = await invoke({
			method: 'GET',
			url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111',
		});

		expect(status).toBe(200);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0]).toMatchObject({
			id: 'm1',
			agent_id: '11111111-1111-4111-8111-111111111111',
			type: 'project',
			content: 'test note',
			tags: ['alpha'],
			salience: 0.8,
			createdAt: createdAt.getTime(),
			expiresAt: null,
		});
	});

	it('returns 400 when agentId is missing', async () => {
		const { status, body } = await invoke({ method: 'GET', url: '/api/agent-memory' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns empty list (200) when agent does not exist', async () => {
		queueSql([]); // no ownership row
		const { status, body } = await invoke({ method: 'GET', url: '/api/agent-memory?agentId=22222222-2222-4222-8222-222222222222' });
		expect(status).toBe(200);
		expect(body.entries).toEqual([]);
	});

	it('returns empty list (200) when agent is owned by another user', async () => {
		queueSql([{ user_id: 'other-user' }]);
		const { status, body } = await invoke({
			method: 'GET',
			url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111',
		});
		expect(status).toBe(200);
		expect(body.entries).toEqual([]);
	});

	it('handles null tags/context with safe defaults in response', async () => {
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
		const { body } = await invoke({ method: 'GET', url: '/api/agent-memory?agentId=11111111-1111-4111-8111-111111111111' });
		expect(body.entries[0].tags).toEqual([]);
		expect(body.entries[0].context).toEqual({});
	});
});

// ── POST (upsert) ─────────────────────────────────────────────────────────

describe('POST /api/agent-memory', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('creates a new entry (no client id) and returns it with an id', async () => {
		const createdAt = new Date();
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'server-gen-id',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: 'new memory',
					tags: [],
					context: {},
					salience: 0.5,
					created_at: createdAt,
					expires_at: null,
				},
			],
		);

		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'new memory' } },
		});

		expect(status).toBe(201);
		expect(body.entry.id).toBe('server-gen-id');
		expect(body.entry.content).toBe('new memory');
	});

	it('returns 400 when agentId is missing', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { entry: { content: 'x' } },
		});
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/agentId/);
	});

	it('returns 400 when entry is missing', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111' },
		});
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/entry/);
	});

	it('returns 403 when agent belongs to another user', async () => {
		queueSql([{ user_id: 'other' }]);
		const { status } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: 'steal' } },
		});
		expect(status).toBe(403);
	});

	it('upserts an entry when a client-supplied id is provided', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: '33333333-3333-4333-8333-333333333333',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'user',
					content: 'updated',
					tags: [],
					context: {},
					salience: 0.9,
					created_at: new Date(),
					expires_at: null,
				},
			],
		);

		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: {
				agentId: '11111111-1111-4111-8111-111111111111',
				entry: { id: '33333333-3333-4333-8333-333333333333', type: 'user', content: 'updated', salience: 0.9 },
			},
		});

		expect(status).toBe(201);
		expect(body.entry.id).toBe('33333333-3333-4333-8333-333333333333');
		expect(body.entry.salience).toBe(0.9);
	});

	it('returns 409 when id collides with another agent\'s memory', async () => {
		// ON CONFLICT WHERE guard fires — SQL returns no rows.
		queueSql([{ user_id: 'u1' }], []);
		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { id: '44444444-4444-4444-8444-444444444444', content: 'x' } },
		});
		expect(status).toBe(409);
		expect(body.error).toBe('id_conflict');
	});

	it('normalizes unknown entry.type to "project"', async () => {
		queueSql(
			[{ user_id: 'u1' }],
			[
				{
					id: 'm1',
					agent_id: '11111111-1111-4111-8111-111111111111',
					type: 'project',
					content: 'x',
					tags: [],
					context: {},
					salience: 0.5,
					created_at: new Date(),
					expires_at: null,
				},
			],
		);

		const { status, body } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { type: 'bogus-type', content: 'x' } },
		});

		expect(status).toBe(201);
		expect(body.entry.type).toBe('project');
	});

	it('truncates content longer than 10,000 characters', async () => {
		const huge = 'x'.repeat(20_000);
		let capturedContent;

		sqlMock.mockReset();
		let call = 0;
		sqlMock.mockImplementation((_strings, ...values) => {
			call += 1;
			if (call === 1) return Promise.resolve([{ user_id: 'u1' }]);
			// The INSERT carries the truncated content; later calls (re-index reset,
			// brain-sign signature update) must not clobber what we captured.
			if (capturedContent === undefined) {
				capturedContent = values.find((v) => typeof v === 'string' && v.length >= 10_000);
			}
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

		const { status } = await invoke({
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { agentId: '11111111-1111-4111-8111-111111111111', entry: { content: huge } },
		});

		expect(status).toBe(201);
		expect(capturedContent).toBeDefined();
		expect(capturedContent.length).toBe(10_000);
	});
});

// ── DELETE ────────────────────────────────────────────────────────────────

describe('DELETE /api/agent-memory/:id', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
	});

	it('deletes the memory row and returns { ok: true }', async () => {
		queueSql([{ id: 'mem-1', user_id: 'u1' }], []); // lookup, delete
		const { status, body } = await invoke({
			method: 'DELETE',
			url: '/api/agent-memory/55555555-5555-4555-8555-555555555555',
		});
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true });
	});

	it('returns 404 when the memory does not exist', async () => {
		queueSql([]); // no row found
		const { status } = await invoke({ method: 'DELETE', url: '/api/agent-memory/66666666-6666-4666-8666-666666666666' });
		expect(status).toBe(404);
	});

	it('returns 403 when memory belongs to another user', async () => {
		queueSql([{ id: 'mem-1', user_id: 'other' }]);
		const { status, body } = await invoke({
			method: 'DELETE',
			url: '/api/agent-memory/55555555-5555-4555-8555-555555555555',
		});
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});
});

// ── Method routing ────────────────────────────────────────────────────────

describe('method routing', () => {
	it('PUT returns 405', async () => {
		const { status } = await invoke({ method: 'PUT', url: '/api/agent-memory' });
		expect(status).toBe(405);
	});

	it('OPTIONS returns 204 with CORS headers', async () => {
		const { status, res } = await invoke({
			method: 'OPTIONS',
			headers: { origin: 'http://localhost:3000' },
		});
		expect(status).toBe(204);
		expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
		expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
	});
});
