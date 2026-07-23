// Regression guard for the 2026-07-23 audit finding (login CSRF):
// POST /api/auth/privy/verify SETS a session cookie but ran with no Origin /
// Referer check, so attacker content on any credentialed-allowlisted origin
// (the default CORS allowlist covers whole partner fleets) could POST their
// own Privy token through the victim's browser and plant a session for the
// attacker's account. The handler must now reject non-same-site requests
// before any token verification happens.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.APP_ORIGIN = 'https://three.ws';
process.env.PRIVY_APP_ID = 'privy-test-app-id';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

const verifyPrivyToken = vi.fn();

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const sqlMock = vi.fn(async (strings, ..._values) => {
	const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (text.includes('insert into users')) return [{ id: 'user-1', inserted: true }];
	if (text.includes('select id, email, display_name')) {
		return [{
			id: 'user-1',
			email: 'privy-abc@privy.local',
			display_name: 'abc',
			plan: 'free',
			avatar_url: null,
			created_at: new Date('2026-07-23T00:00:00Z'),
		}];
	}
	return [];
});
vi.mock('../api/_lib/db.js', () => ({ sql: (strings, ...values) => sqlMock(strings, ...values) }));

vi.mock('../api/_lib/auth.js', async () => {
	const actual = await vi.importActual('../api/_lib/auth.js');
	return {
		...actual,
		verifyPrivyToken: (...args) => verifyPrivyToken(...args),
		createSession: vi.fn(async () => 'sess-token'),
		destroySession: vi.fn(async () => {}),
		sessionCookie: vi.fn(() => '__Host-sid=sess-token; Path=/; HttpOnly; Secure; SameSite=Lax'),
	};
});
vi.mock('../api/_lib/privy.js', () => ({
	fetchPrivyWallets: vi.fn(async () => []),
	extractIdentity: vi.fn(() => ({ email: null })),
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/seed-default-agent.js', () => ({ seedDefaultAgent: vi.fn() }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/legal.js', () => ({
	tosAcceptanceFromBody: vi.fn(() => null),
	recordTosAcceptance: vi.fn(),
}));

const { default: handler } = await import('../api/auth/privy/verify.js');

function makeReq(headers = {}) {
	return {
		method: 'POST',
		url: '/api/auth/privy/verify',
		headers: { 'content-type': 'application/json', ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		body: JSON.stringify({ token: 'privy.jwt.token' }),
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

beforeEach(() => {
	verifyPrivyToken.mockReset();
	verifyPrivyToken.mockResolvedValue({ sub: 'did:privy:abc123' });
});

describe('POST /api/auth/privy/verify — login-CSRF gate', () => {
	it('rejects a cross-site Origin before verifying the token', async () => {
		const res = makeRes();
		await handler(makeReq({ origin: 'https://evil.example' }), res);
		expect(res.statusCode).toBe(403);
		expect(verifyPrivyToken).not.toHaveBeenCalled();
		expect(res._h['set-cookie']).toBeUndefined();
	});

	it('rejects a credentialed-allowlisted partner Origin too', async () => {
		const res = makeRes();
		await handler(makeReq({ origin: 'https://gateway-prod-ibm-us-east-otter.seismic.com' }), res);
		expect(res.statusCode).toBe(403);
		expect(verifyPrivyToken).not.toHaveBeenCalled();
	});

	it('rejects requests with no Origin and no Referer', async () => {
		const res = makeRes();
		await handler(makeReq(), res);
		expect(res.statusCode).toBe(403);
		expect(verifyPrivyToken).not.toHaveBeenCalled();
	});

	it('accepts a same-site Origin and issues the session', async () => {
		const res = makeRes();
		await handler(makeReq({ origin: 'https://three.ws' }), res);
		expect(verifyPrivyToken).toHaveBeenCalledWith('privy.jwt.token');
		expect(res.statusCode).toBe(200);
		expect(res._h['set-cookie']).toMatch(/__Host-sid=/);
	});

	it('accepts a same-site Referer when Origin is absent', async () => {
		const res = makeRes();
		await handler(makeReq({ referer: 'https://three.ws/login' }), res);
		expect(res.statusCode).toBe(200);
	});
});
