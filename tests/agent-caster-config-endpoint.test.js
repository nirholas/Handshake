// POST /api/agent/caster-config mints a live API key for the screen-caster
// service, so its auth contract is the whole security story: it must accept a
// real session (the shape mismatch that made it answer 401 to every caller is
// the regression this file pins), demand the `profile` scope from bearer
// callers, CSRF-guard the cookie lane, and refuse a malformed agent id before
// the uuid column can raise a 500.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
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
	hasScope: (granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	},
}));

const csrfOk = { value: true };
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfOk.value) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_missing' }));
		return false;
	}),
}));

const rlOk = { value: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: rlOk.value, reset: 1_000 })) },
	clientIp: () => '203.0.113.7',
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: handler } = await import('../api/agent/caster-config.js');

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mkReq({ headers = {}, body = null, method = 'POST' } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url: '/api/agent/caster-config',
		headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	csrfOk.value = true;
	rlOk.value = true;
});

describe('POST /api/agent/caster-config', () => {
	it('mints a scoped key for an agent the session user owns', async () => {
		sqlQueue = [
			[{ id: AGENT, name: 'Anchor', display_name: 'Anchor' }],
			[{ id: 'key-1', created_at: new Date('2026-08-10T00:00:00Z') }],
		];
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT } }), res);

		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.keyId).toBe('key-1');
		expect(out.scope).toBe('agents:read agents:write');
		expect(out.prefix).toMatch(/^sk_live_.{6}$/);
		// The plaintext token is returned exactly once, inside the copyable env
		// block, and never round-trips through the database.
		expect(out.envBlock).toContain(`AGENT_ID=${AGENT}`);
		const token = out.envBlock.match(/AGENT_BEARER_TOKEN=(\S+)/)[1];
		expect(token.startsWith('sk_live_')).toBe(true);
		expect(out.dockerCmd).toContain('three-ws/agent-screen-caster');

		// Only the hash reaches storage.
		const insert = sqlMock.mock.calls[1];
		expect(insert.slice(1)).toContain('user-1');
		expect(JSON.stringify(insert.slice(1))).not.toContain(token);
	});

	it('accepts a bearer token carrying the profile scope', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('sk_live_whatever');
		authenticateBearerMock.mockResolvedValue({ userId: 'user-2', scope: 'profile agents:read' });
		sqlQueue = [
			[{ id: AGENT, name: 'Anchor', display_name: null }],
			[{ id: 'key-2', created_at: new Date('2026-08-10T00:00:00Z') }],
		];
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT }, headers: { authorization: 'Bearer sk_live_whatever' } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).keyId).toBe('key-2');
	});

	it('rejects a bearer token without the profile scope', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('sk_live_narrow');
		authenticateBearerMock.mockResolvedValue({ userId: 'user-3', scope: 'agents:read' });
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT } }), res);
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('insufficient_scope');
	});

	it('answers 401 when there is no session and no bearer', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT } }), res);
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});

	it('rejects a malformed agentId with a 400 instead of letting the uuid column raise', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { agentId: 'not-a-uuid' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		// Nothing was queried: the guard runs before the database.
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses to mint a key for an agent the caller does not own', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT } }), res);
		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('forbidden');
		// Ownership failed, so no key row was written.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('does not mint a key when the CSRF guard fails', async () => {
		csrfOk.value = false;
		const res = mkRes();
		await handler(mkReq({ body: { agentId: AGENT } }), res);
		expect(res.statusCode).toBe(403);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects any method other than POST', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});
});
