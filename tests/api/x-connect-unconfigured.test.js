// What /api/auth/x/connect does on a deployment that holds no X OAuth app.
//
// Every "Connect X" control on the site is an anchor or a `location.href`
// assignment, so this endpoint is reached by a top-level browser navigation. It
// used to answer an unconfigured deployment with a JSON 501, which put
// `{"error":"not_configured"}` in the user's address bar and lost the page they
// came from. tests/api/x-connect-scope.test.js covers the configured path; this
// file pins the refusal, and pins that API callers still get the JSON envelope.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'user-1' })),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// The whole point of this file: no client id, no client secret.
vi.mock('../../api/_lib/env.js', () => ({
	env: {
		X_OAUTH_CLIENT_ID: '',
		X_OAUTH_CLIENT_SECRET: '',
		APP_ORIGIN: 'https://three.ws',
		JWT_SECRET: 'test-jwt-secret-value-long-enough',
	},
}));

const { default: handler } = await import('../../api/auth/x/[action].js');

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
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

async function connect(query = '', headers = {}) {
	const req = {
		method: 'GET',
		url: `/api/auth/x/connect${query}`,
		headers,
		socket: {},
		query: { action: 'connect' },
	};
	const res = mockRes();
	await handler(req, res);
	return res;
}

const NAVIGATION = { 'sec-fetch-mode': 'navigate' };

describe('GET /api/auth/x/connect with no X OAuth app configured', () => {
	it('sends a browser back to the seeding card instead of rendering JSON', async () => {
		const res = await connect('?scope=read&agent_id=agent-9', NAVIGATION);
		expect(res.statusCode).toBe(302);
		const to = new URL(res.headers.location, 'https://three.ws');
		expect(to.pathname).toBe('/settings');
		expect(to.searchParams.get('tab')).toBe('connected-accounts');
		expect(to.searchParams.get('x')).toBe('unconfigured');
		expect(to.searchParams.get('agent_id')).toBe('agent-9');
		expect(res.body).toBeNull();
	});

	it('sends a posting connect back to the agent editor it started from', async () => {
		const res = await connect('?agent_id=agent-9', NAVIGATION);
		expect(res.statusCode).toBe(302);
		const to = new URL(res.headers.location, 'https://three.ws');
		expect(to.pathname).toBe('/agents/agent-9/edit');
		expect(to.searchParams.get('tab')).toBe('social');
		expect(to.searchParams.get('x')).toBe('unconfigured');
	});

	it('falls back to Settings when the connect names no agent', async () => {
		const res = await connect('', NAVIGATION);
		const to = new URL(res.headers.location, 'https://three.ws');
		expect(to.pathname).toBe('/settings');
		expect(to.searchParams.get('x')).toBe('unconfigured');
	});

	// An Accept that prefers HTML is the fallback signal for clients that send no
	// Sec-Fetch headers, so it has to redirect too.
	it('treats an HTML-preferring client with no Sec-Fetch headers as a navigation', async () => {
		const res = await connect('?scope=read', { accept: 'text/html,application/xhtml+xml' });
		expect(res.statusCode).toBe(302);
	});

	it('still answers a programmatic caller with the not_configured envelope', async () => {
		const res = await connect('?scope=read', { 'sec-fetch-mode': 'cors', accept: 'application/json' });
		expect(res.statusCode).toBe(501);
		expect(res.json).toMatchObject({ error: 'not_configured' });
		expect(res.headers.location).toBeUndefined();
	});

	it('never starts an authorization it cannot finish', async () => {
		const res = await connect('?scope=read', NAVIGATION);
		// No PKCE state cookie, so nothing is left behind for a callback that can
		// never arrive.
		expect(res.headers['set-cookie']).toBeUndefined();
		expect(String(res.headers.location)).not.toContain('twitter.com');
	});
});
