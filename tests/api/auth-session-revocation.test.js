// Session revocation tallies: DELETE /api/auth/sessions ("log out everywhere
// else") and POST /api/auth/logout-everywhere.
//
// Both reported their result from a `.count` property on the query result. The
// Neon HTTP driver resolves a query to a plain rows array and never sets that
// property, so `revoked` was always undefined: JSON.stringify dropped the key
// and the settings page's "log out everywhere" answered a bare `{}`. These
// tests pin the tally to rows returned by RETURNING, which is what the driver
// actually gives back.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.APP_ORIGIN = 'https://three.ws';
process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const statements = [];
// Rows the mock hands back for a statement that asked for them. Mirrors the
// real driver: no RETURNING means an empty array and no row-count field.
const RETURNED_ROWS = [{ id: 'sess-2' }, { id: 'sess-3' }, { id: 'sess-4' }];
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
	const flat = text.replace(/\s+/g, ' ').trim();
	statements.push({ text: flat, values });
	if (/^select id, user_agent, ip/i.test(flat)) {
		return [
			{ id: 'sess-1', user_agent: 'curl', ip: '127.0.0.1', created_at: 'now', last_seen_at: 'now', expires_at: 'later' },
			{ id: 'sess-2', user_agent: 'firefox', ip: '127.0.0.2', created_at: 'now', last_seen_at: 'now', expires_at: 'later' },
		];
	}
	if (/returning id/i.test(flat)) return RETURNED_ROWS;
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (strings, ...values) => sqlMock(strings, ...values) }));

const getSessionUser = vi.fn();
vi.mock('../../api/_lib/auth.js', async () => {
	const actual = await vi.importActual('../../api/_lib/auth.js');
	return {
		...actual,
		getSessionUser: (...args) => getSessionUser(...args),
		hasSessionCookie: () => true,
		createSession: vi.fn(async () => 'new-token'),
		destroySession: vi.fn(async () => {}),
		rotateSession: vi.fn(async () => 'rotated-token'),
		// Mirrors the real signature: clearing returns an ARRAY (current + legacy
		// cookie names), issuing returns a single string. Handlers spread the
		// clear form, so a mock that always returns a string would spread it
		// character by character and silently pass a broken assertion.
		sessionCookie: vi.fn((token, opts) => (opts?.clear
			? ['__Host-sid=; Path=/; Max-Age=0', 'sid=; Path=/; Max-Age=0']
			: `__Host-sid=${token}; Path=/; HttpOnly; Secure`)),
	};
});

const requireCsrf = vi.fn(async () => true);
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: (...args) => requireCsrf(...args) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		registerIp: vi.fn(async () => ({ success: true })),
		authIpCaptcha: vi.fn(async () => ({ success: true })),
		forgotPasswordEmail: vi.fn(async () => ({ success: true })),
		verifyEmailIp: vi.fn(async () => ({ success: true })),
		resendVerifyUser: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '127.0.0.1',
}));
vi.mock('../../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../../api/_lib/email.js', () => ({
	sendPasswordResetEmail: vi.fn(async () => {}),
	sendVerificationEmail: vi.fn(async () => {}),
}));
vi.mock('../../api/_lib/seed-default-agent.js', () => ({ seedDefaultAgent: vi.fn() }));
vi.mock('../../api/_lib/usage.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../api/_lib/legal.js', () => ({
	tosAcceptanceFromBody: vi.fn(() => null),
	recordTosAcceptance: vi.fn(),
	TOS_VERSION: 2,
}));

const { default: sessionsHandler } = await import('../../api/auth/sessions/[action].js');
const { default: authHandler } = await import('../../api/auth/[action].js');

function makeReq({ method, url, query = {}, body }) {
	return {
		method,
		url,
		query,
		headers: { 'content-type': 'application/json', origin: 'https://three.ws', 'user-agent': 'vitest' },
		socket: { remoteAddress: '127.0.0.1' },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

const written = (fragment) => statements.filter((s) => s.text.includes(fragment));

beforeEach(() => {
	statements.length = 0;
	sqlMock.mockClear();
	requireCsrf.mockClear();
	requireCsrf.mockResolvedValue(true);
	getSessionUser.mockReset();
	getSessionUser.mockResolvedValue({ id: 'user-1', sid: 'sess-1', email: 'ada@example.com' });
});

describe('DELETE /api/auth/sessions', () => {
	it('reports how many other sessions it revoked', async () => {
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'DELETE', url: '/api/auth/sessions' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ revoked: RETURNED_ROWS.length });
	});

	it('asks the revoke statement for its rows back', async () => {
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'DELETE', url: '/api/auth/sessions' }), res);
		const [revoke] = written('update sessions set revoked_at');
		expect(revoke.text).toContain('returning id');
	});

	it('rotates the current session so a stolen copy of this cookie dies too', async () => {
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'DELETE', url: '/api/auth/sessions' }), res);
		const cookies = [].concat(res.getHeader('set-cookie'));
		expect(cookies.some((c) => c.includes('__Host-sid=rotated-token'))).toBe(true);
	});

	it('refuses without a CSRF token and writes nothing', async () => {
		requireCsrf.mockResolvedValue(false);
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'DELETE', url: '/api/auth/sessions' }), res);
		expect(written('update sessions set revoked_at')).toHaveLength(0);
	});

	it('refuses an anonymous caller with 401', async () => {
		getSessionUser.mockResolvedValue(null);
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'DELETE', url: '/api/auth/sessions' }), res);
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('unauthenticated');
	});
});

describe('GET /api/auth/sessions', () => {
	it('lists live sessions and flags the current one', async () => {
		const res = makeRes();
		await sessionsHandler(makeReq({ method: 'GET', url: '/api/auth/sessions' }), res);
		expect(res.statusCode).toBe(200);
		const { sessions } = res.json();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toMatchObject({ id: 'sess-1', is_current: true });
		expect(sessions[1]).toMatchObject({ id: 'sess-2', is_current: false });
	});
});

describe('POST /api/auth/logout-everywhere', () => {
	it('reports how many sessions it revoked and clears the cookie', async () => {
		const res = makeRes();
		await authHandler(makeReq({ method: 'POST', url: '/api/auth/logout-everywhere', query: { action: 'logout-everywhere' } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true, revoked: RETURNED_ROWS.length });
		const cookies = [].concat(res.getHeader('set-cookie'));
		expect(cookies.some((c) => c.includes('__Host-sid='))).toBe(true);
	});

	it('revokes the OAuth refresh tokens alongside the browser sessions', async () => {
		const res = makeRes();
		await authHandler(makeReq({ method: 'POST', url: '/api/auth/logout-everywhere', query: { action: 'logout-everywhere' } }), res);
		expect(written('update oauth_refresh_tokens set revoked_at')).toHaveLength(1);
	});

	it('refuses an anonymous caller with 401', async () => {
		getSessionUser.mockResolvedValue(null);
		const res = makeRes();
		await authHandler(makeReq({ method: 'POST', url: '/api/auth/logout-everywhere', query: { action: 'logout-everywhere' } }), res);
		expect(res.statusCode).toBe(401);
		expect(written('update sessions set revoked_at')).toHaveLength(0);
	});
});
