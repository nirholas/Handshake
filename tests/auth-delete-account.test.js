// DELETE /api/auth/me: account deletion.
//
// The /settings Danger Zone shipped calling this endpoint while the `me` action
// only accepted GET, so "Permanently delete" always failed with the generic
// "contact support" alert. These tests pin the behavior it needs: three gates
// (session, CSRF, typed confirmation) before any write, a soft delete that also
// retires the account's public content, and a cleared session cookie.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.APP_ORIGIN = 'https://three.ws';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const statements = [];
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
	statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
	if (text.includes('select username from users')) return [{ username: 'ada' }];
	// Neon's HTTP driver resolves every query to a plain rows array: a statement
	// with no RETURNING yields [] and carries no `.count` field. Mocking a
	// `.count` is what let the handler ship reporting every deletion as having
	// retired 0 avatars, 0 agents, and 0 widgets, so this mock refuses to invent
	// one and the handler has to count `returning id` rows like production does.
	if (/returning id/i.test(text)) return [{ id: 'row-1' }, { id: 'row-2' }];
	return [];
});
vi.mock('../api/_lib/db.js', () => ({ sql: (strings, ...values) => sqlMock(strings, ...values) }));

const getSessionUser = vi.fn();
vi.mock('../api/_lib/auth.js', async () => {
	const actual = await vi.importActual('../api/_lib/auth.js');
	return {
		...actual,
		getSessionUser: (...args) => getSessionUser(...args),
		hasSessionCookie: () => true,
		createSession: vi.fn(async () => 'sess-token'),
		destroySession: vi.fn(async () => {}),
		sessionCookie: vi.fn(() => '__Host-sid=; Path=/; Max-Age=0'),
	};
});

const requireCsrf = vi.fn(async () => true);
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...args) => requireCsrf(...args) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
const logAudit = vi.fn();
vi.mock('../api/_lib/audit.js', () => ({ logAudit: (...args) => logAudit(...args) }));
vi.mock('../api/_lib/email.js', () => ({
	sendPasswordResetEmail: vi.fn(async () => {}),
	sendVerificationEmail: vi.fn(async () => {}),
}));
vi.mock('../api/_lib/seed-default-agent.js', () => ({ seedDefaultAgent: vi.fn() }));
vi.mock('../api/_lib/usage.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../api/_lib/legal.js', () => ({
	tosAcceptanceFromBody: vi.fn(() => null),
	recordTosAcceptance: vi.fn(),
	TOS_VERSION: 2,
}));

const { default: handler } = await import('../api/auth/[action].js');

function makeReq(body, headers = {}) {
	return {
		method: 'DELETE',
		url: '/api/auth/me',
		query: { action: 'me' },
		headers: { 'content-type': 'application/json', origin: 'https://three.ws', ...headers },
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
	logAudit.mockClear();
	requireCsrf.mockClear();
	requireCsrf.mockResolvedValue(true);
	getSessionUser.mockReset();
	getSessionUser.mockResolvedValue({ id: 'user-1', email: 'ada@example.com' });
});

describe('DELETE /api/auth/me', () => {
	it('rejects an anonymous caller before touching the database', async () => {
		getSessionUser.mockResolvedValue(null);
		const res = makeRes();
		await handler(makeReq({ confirm: 'delete my account' }), res);
		expect(res.statusCode).toBe(401);
		expect(written('update users set deleted_at')).toHaveLength(0);
	});

	it('rejects a request without a CSRF token', async () => {
		requireCsrf.mockImplementation(async (_req, res) => {
			res.statusCode = 403;
			res.end(JSON.stringify({ error: 'csrf_missing' }));
			return false;
		});
		const res = makeRes();
		await handler(makeReq({ confirm: 'delete my account' }), res);
		expect(res.statusCode).toBe(403);
		expect(written('update users set deleted_at')).toHaveLength(0);
	});

	it('rejects a request without the typed confirmation phrase', async () => {
		const res = makeRes();
		await handler(makeReq({}), res);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('confirmation_required');
		expect(written('update users set deleted_at')).toHaveLength(0);
	});

	it('soft-deletes the account, retires its content, and clears the cookie', async () => {
		const res = makeRes();
		await handler(makeReq({ confirm: 'Delete My Account' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ ok: true, deleted: { avatars: 2, agents: 2, widgets: 2 } });
		expect(written('update avatars set deleted_at')).toHaveLength(1);
		expect(written('update agent_identities set deleted_at')).toHaveLength(1);
		expect(written('update widgets set deleted_at')).toHaveLength(1);
		expect(written('update sessions set revoked_at')).toHaveLength(1);
		expect(written('update oauth_refresh_tokens set revoked_at')).toHaveLength(1);
		expect(res.getHeader('set-cookie')).toMatch(/Max-Age=0/);
	});

	it('counts retired content from RETURNING rows, not a driver row-count field', async () => {
		const res = makeRes();
		await handler(makeReq({ confirm: 'delete my account' }), res);
		// Every content sweep must ask for its rows back. Without RETURNING the
		// tally silently reads undefined and both the response and the audit row
		// claim nothing was retired.
		for (const fragment of [
			'update avatars set deleted_at',
			'update agent_identities set deleted_at',
			'update widgets set deleted_at',
		]) {
			expect(written(fragment)[0].text).toContain('returning id');
		}
		expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
			action: 'delete_account',
			meta: expect.objectContaining({ avatars: 2, agents: 2, widgets: 2 }),
		}));
	});

	it('releases the username so the /u/ handle is not held forever', async () => {
		const res = makeRes();
		await handler(makeReq({ confirm: 'delete my account' }), res);
		const [userUpdate] = written('update users set deleted_at');
		expect(userUpdate.text).toContain('username = null');
		expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
			action: 'delete_account',
			meta: expect.objectContaining({ released_username: 'ada' }),
		}));
	});

	it('retires content before the identity so a mid-flight failure is retryable', async () => {
		const res = makeRes();
		await handler(makeReq({ confirm: 'delete my account' }), res);
		const order = statements.map((s) => s.text);
		expect(order.findIndex((t) => t.includes('update avatars set deleted_at')))
			.toBeLessThan(order.findIndex((t) => t.includes('update users set deleted_at')));
	});

	it('still answers GET /api/auth/me with the session user', async () => {
		const res = makeRes();
		const req = makeReq(undefined);
		req.method = 'GET';
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.json().user).toMatchObject({ id: 'user-1' });
	});
});
