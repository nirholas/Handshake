import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// CSRF is exercised by its own dedicated suite; isolate these handler-logic
// tests from the double-submit-token check (session-cookie mutations now
// require it — bearer callers stay exempt in the handler itself).
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: () => true }));

const getSessionUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
}));

const mcpUserMock = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { mcpUser: (...a) => mcpUserMock(...a) },
}));

const dispatchMock = vi.fn();
vi.mock('../api/_mcp/dispatch.js', () => ({
	dispatch: (...a) => dispatchMock(...a),
}));

// env throws if required vars are missing — stub before the handler imports it.
vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://test', MCP_RESOURCE: 'http://test' },
}));

const { default: handler } = await import('../api/developer/mcp-test.js');

// ── Test helpers ──────────────────────────────────────────────────────────

function mkReq({ method = 'POST', url = '/api/developer/mcp-test', headers = {}, body = null } = {}) {
	return {
		method,
		url,
		headers: { 'content-type': 'application/json', ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
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
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(body) { this.body = body; this.writableEnded = true; },
	};
}

const parseBody = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	mcpUserMock.mockReset().mockResolvedValue({ success: true, limit: 1200, remaining: 1199, reset: Date.now() + 60_000 });
	dispatchMock.mockReset();
});

// api_keys.id is a uuid column and the handler guards on that before querying,
// so the fixtures have to be real uuids.
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_KEY_ID = '44444444-4444-4444-8444-444444444444';

const okKey = { id: KEY_ID, scope: 'avatars:read profile', revoked_at: null, expires_at: null };

function dispatchHappyPath() {
	dispatchMock.mockImplementation((msg) => {
		if (msg.method === 'initialize')
			return Promise.resolve({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: '3d-agent-mcp' } } });
		if (msg.method === 'tools/list')
			return Promise.resolve({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'render_avatar' }, { name: 'list_my_avatars' }] } });
		return Promise.resolve(null);
	});
}

// ── Auth & method ───────────────────────────────────────────────────────────

describe('mcp-test auth & method', () => {
	it('rejects non-POST with 405', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('returns 401 without a session', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);
		expect(res.statusCode).toBe(401);
	});

	it('returns 429 when the user is rate limited', async () => {
		mcpUserMock.mockResolvedValue({ success: false, limit: 1200, remaining: 0, reset: Date.now() + 60_000 });
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);
		expect(res.statusCode).toBe(429);
	});
});

// ── Key validation ──────────────────────────────────────────────────────────

describe('mcp-test key validation', () => {
	it('returns 400 when keyId is missing', async () => {
		const res = mkRes();
		await handler(mkReq({ body: {} }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('bad_request');
	});

	it('returns 404 for a malformed keyId without querying Postgres', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { keyId: 'not-a-uuid' } }), res);
		// api_keys.id is a uuid column: handing it a non-uuid used to surface
		// Postgres error 22P02 to the dashboard as a 500.
		expect(res.statusCode).toBe(404);
		expect(parseBody(res).error).toBe('not_found');
		expect(sqlMock).not.toHaveBeenCalled();
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it('returns 404 when the key is not owned by the caller', async () => {
		sqlMock.mockResolvedValue([]); // no row
		const res = mkRes();
		await handler(mkReq({ body: { keyId: UNKNOWN_KEY_ID } }), res);
		expect(res.statusCode).toBe(404);
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it('returns 400 for a revoked key', async () => {
		sqlMock.mockResolvedValue([{ ...okKey, revoked_at: new Date().toISOString() }]);
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('revoked');
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it('returns 400 for an expired key', async () => {
		sqlMock.mockResolvedValue([{ ...okKey, expires_at: new Date(Date.now() - 1000).toISOString() }]);
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('expired');
		expect(dispatchMock).not.toHaveBeenCalled();
	});
});

// ── Handshake ───────────────────────────────────────────────────────────────

describe('mcp-test handshake', () => {
	it('runs initialize → tools/list and returns tools + scopes', async () => {
		sqlMock.mockResolvedValue([okKey]);
		dispatchHappyPath();
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);

		expect(res.statusCode).toBe(200);
		const body = parseBody(res);
		expect(body.ok).toBe(true);
		expect(body.protocolVersion).toBe('2025-06-18');
		expect(body.tools).toEqual([{ name: 'render_avatar' }, { name: 'list_my_avatars' }]);
		expect(body.scopes).toEqual(['avatars:read', 'profile']);

		// dispatch ran with the key's real scope, not a hardcoded all-scopes string.
		expect(dispatchMock).toHaveBeenCalledTimes(2);
		const [, auth] = dispatchMock.mock.calls[0];
		expect(auth).toMatchObject({ userId: 'user-1', scope: 'avatars:read profile', source: 'apikey' });
	});

	it('surfaces a dispatch error as ok:false without throwing', async () => {
		sqlMock.mockResolvedValue([okKey]);
		dispatchMock.mockImplementation((msg) =>
			Promise.resolve(
				msg.method === 'initialize'
					? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } }
					: null,
			),
		);
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);

		expect(res.statusCode).toBe(200);
		const body = parseBody(res);
		expect(body.ok).toBe(false);
		expect(body.error.message).toBe('boom');
		// tools/list is not attempted once initialize fails.
		expect(dispatchMock).toHaveBeenCalledTimes(1);
	});

	it('reports an empty scopes array for a no-scope key', async () => {
		sqlMock.mockResolvedValue([{ ...okKey, scope: '' }]);
		dispatchHappyPath();
		const res = mkRes();
		await handler(mkReq({ body: { keyId: KEY_ID } }), res);
		expect(parseBody(res).scopes).toEqual([]);
	});
});
