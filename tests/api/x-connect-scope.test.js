// What /api/auth/x/connect actually asks X for.
//
// tests/api/x-scopes.test.js pins the scope sets themselves; this pins the one
// place they reach the user: the authorize URL their browser is sent to. The
// promise the seeding card makes ("it cannot post as you") is only true if the
// `scope` parameter on that redirect carries no write scope, so that parameter
// is asserted directly rather than the helper that builds it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const authState = { session: { id: 'user-1' } };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: {
		X_OAUTH_CLIENT_ID: 'test-client-id',
		X_OAUTH_CLIENT_SECRET: 'test-client-secret',
		APP_ORIGIN: 'https://three.ws',
		JWT_SECRET: 'test-jwt-secret-value-long-enough',
	},
}));

const { default: handler } = await import('../../api/auth/x/[action].js');
const { X_SCOPE_SETS } = await import('../../api/_lib/x-scopes.js');

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		headersSent: false,
		writableEnded: false,
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload ?? null; },
	};
}

async function connect(query = '') {
	const req = {
		method: 'GET',
		url: `/api/auth/x/connect${query}`,
		headers: {},
		socket: {},
		query: { action: 'connect' },
	};
	const res = mockRes();
	await handler(req, res);
	const location = res.headers.location ? new URL(res.headers.location) : null;
	return { res, location, scope: location?.searchParams.get('scope') ?? null };
}

beforeEach(() => {
	authState.session = { id: 'user-1' };
});

describe('GET /api/auth/x/connect', () => {
	it('sends a browser to X with only read scopes when the seeding card asks', async () => {
		const { res, location, scope } = await connect('?scope=read');
		expect(res.statusCode).toBe(302);
		expect(location.host).toBe('twitter.com');
		expect(scope.split(' ')).toEqual([...X_SCOPE_SETS.read]);
		expect(scope).not.toMatch(/\.write/);
	});

	it('still asks for the full set by default, so posting surfaces are unaffected', async () => {
		const { scope } = await connect();
		expect(scope.split(' ')).toEqual([...X_SCOPE_SETS.full]);
		expect(scope).toContain('tweet.write');
	});

	it('treats an unrecognised scope name as the full set rather than a narrower one', async () => {
		const { scope } = await connect('?scope=readonly');
		expect(scope.split(' ')).toEqual([...X_SCOPE_SETS.full]);
	});

	it('keeps PKCE and the signed state cookie on the read-only path', async () => {
		const { res, location } = await connect('?scope=read&agent_id=agent-9');
		expect(location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(location.searchParams.get('code_challenge')).toBeTruthy();
		expect(location.searchParams.get('state')).toBeTruthy();
		expect(String(res.headers['set-cookie'])).toMatch(/^__Host-xoa=/);
	});

	it('requires a session before starting any authorization', async () => {
		authState.session = null;
		const { res } = await connect('?scope=read');
		expect(res.statusCode).toBe(401);
	});
});
