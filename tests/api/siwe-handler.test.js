// Tests for the SIWE HTTP endpoints: GET nonce, POST verify.
// api/auth/siwe/[action].js — dispatcher uses req.query.action.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-siwe-handler-secret-at-32chars';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const sqlState = { queue: [], calls: [] };

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		const next = sqlState.queue.shift();
		if (next instanceof Error) throw next;
		return next;
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/auth.js', () => ({
	createSession: vi.fn(async () => 'siwe-session-token'),
	destroySession: vi.fn(async () => {}),
	sessionCookie: vi.fn((token) => `__Host-sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`),
}));

vi.mock('../../api/_lib/email.js', () => ({
	sendWelcomeEmail: vi.fn(async () => {}),
}));

const ethersState = {
	recovered: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
};

vi.mock('ethers', () => ({
	verifyMessage: vi.fn(() => ethersState.recovered),
	getAddress: vi.fn((addr) => addr),
}));

// Control CSRF: mock hmacSha256 to return a predictable value and
// constantTimeEquals to always compare correctly.
vi.mock('../../api/_lib/crypto.js', () => ({
	randomToken: vi.fn((n) => 'A'.repeat(n > 24 ? 32 : 28)), // alphanum-safe filler
	hmacSha256: vi.fn(async (_secret, msg) => `hmac(${msg})`),
	constantTimeEquals: vi.fn((a, b) => a === b),
}));

const { default: handler } = await import('../../api/auth/siwe/[action].js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq({ action, method = 'GET', body = null, headers = {} } = {}) {
	const bodyStr = body ? JSON.stringify(body) : '';
	const base = Readable.from([Buffer.from(bodyStr)]);
	base.method = method;
	base.url = `/api/auth/siwe/${action}`;
	base.query = { action };
	base.headers = {
		host: 'app.test',
		...(body !== null ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return base;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(opts) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	let json = null;
	try {
		json = JSON.parse(res.body);
	} catch {
		json = res.body;
	}
	return { res, status: res.statusCode, body: json };
}

// EIP-4361 message bound to this deployment's own domain (PUBLIC_APP_ORIGIN
// above). verifyMessage mock returns the same address so signer === claimed.
const WALLET_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const TEST_NONCE = 'testNonce1234567890ab';
// Use a fresh issuedAt so the handler's anti-stale freshness check accepts it.
const ISSUED_AT = new Date().toISOString();
const siweMessage = (domain, uri) => [
	`${domain} wants you to sign in with your Ethereum account:`,
	WALLET_ADDR,
	'',
	`URI: ${uri}`,
	'Version: 1',
	'Chain ID: 1',
	`Nonce: ${TEST_NONCE}`,
	`Issued At: ${ISSUED_AT}`,
].join('\n');
const SIWE_MESSAGE = siweMessage('app.test', 'https://app.test/login');
// The same message re-pointed at localhost. A deployment whose own APP_ORIGIN
// is not localhost must refuse it.
const LOCALHOST_MESSAGE = siweMessage('localhost', 'http://localhost/login');

const FUTURE = new Date(Date.now() + 300_000).toISOString();

// The nonce handler sets CSRF cookie = `__Host-csrf-siwe=<rawToken>`.
// randomToken mock returns 'A'.repeat(32) for the raw token.
// hmacSha256 mock returns `hmac(csrf-siwe:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)`.
// For verify tests, we supply matching header + cookie.
const CSRF_RAW = 'A'.repeat(32);
const CSRF_TOKEN = `hmac(csrf-siwe:${CSRF_RAW})`;
const CSRF_COOKIE = `__Host-csrf-siwe=${CSRF_RAW}`;

function withCsrf(headers = {}) {
	return {
		'x-csrf-token': CSRF_TOKEN,
		cookie: CSRF_COOKIE,
		...headers,
	};
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
	ethersState.recovered = WALLET_ADDR;
});

// ── GET /api/auth/siwe/nonce ───────────────────────────────────────────────────

describe('GET /api/auth/siwe/nonce', () => {
	it('returns nonce, csrf, issuedAt, expiresAt, and ttl', async () => {
		sqlState.queue.push([]); // insert nonce
		const { status, body, res } = await invoke({ action: 'nonce', method: 'GET' });
		expect(status).toBe(200);
		expect(typeof body.nonce).toBe('string');
		expect(body.nonce.length).toBeGreaterThanOrEqual(22);
		expect(typeof body.csrf).toBe('string');
		expect(typeof body.issuedAt).toBe('string');
		expect(typeof body.expiresAt).toBe('string');
		expect(body.ttl).toBe(300);
	});

	it('stores the nonce in the DB', async () => {
		sqlState.queue.push([]);
		await invoke({ action: 'nonce', method: 'GET' });
		const insert = sqlState.calls.find((c) => /insert into siwe_nonces/i.test(c.query));
		expect(insert).toBeTruthy();
	});

	it('sets a CSRF cookie on the response', async () => {
		sqlState.queue.push([]);
		const { res } = await invoke({ action: 'nonce', method: 'GET' });
		const cookie = res.headers['set-cookie'];
		expect(cookie).toContain('__Host-csrf-siwe=');
		expect(cookie).toContain('HttpOnly');
	});

	it('returns 429 when rate limited', async () => {
		rlState.success = false;
		const { status, body } = await invoke({ action: 'nonce', method: 'GET' });
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── POST /api/auth/siwe/verify ─────────────────────────────────────────────────

describe('POST /api/auth/siwe/verify', () => {
	it('creates a session on valid message + signature (new wallet, new user)', async () => {
		// Nonce lookup, burn nonce, wallet lookup, user lookup, insert user, insert wallet, fetch user
		// + seedDefaultAgent (queueMicrotask): a single INSERT … WHERE NOT EXISTS
		sqlState.queue.push([{ nonce: TEST_NONCE, expires_at: FUTURE, consumed_at: null }]);
		sqlState.queue.push([{ nonce: TEST_NONCE }]); // burn RETURNING
		sqlState.queue.push([]); // no wallet
		sqlState.queue.push([]); // no existing user
		sqlState.queue.push([{ id: 'user-new', inserted: true }]); // insert user
		sqlState.queue.push([]); // insert wallet
		// seedDefaultAgent runs via queueMicrotask — one combined INSERT call
		sqlState.queue.push([]); // seedDefaultAgent: INSERT default agent (WHERE NOT EXISTS)
		sqlState.queue.push([{ id: 'user-new', email: `wallet-0xd8da@wallet.local`, display_name: '0xd8dA…6045', plan: 'free', avatar_url: null, created_at: '2024-01-01' }]);

		const { status, body, res } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf(),
		});

		expect(status).toBe(200);
		expect(body.user).toBeDefined();
		expect(body.wallet.address).toBe(WALLET_ADDR);
		const cookie = res.headers['set-cookie'];
		expect(cookie).toContain('__Host-sid=siwe-session-token');
	});

	it('returns 400 with nonce_reused when nonce was already consumed', async () => {
		sqlState.queue.push([{ nonce: TEST_NONCE, expires_at: FUTURE, consumed_at: '2024-01-01T00:00:00.000Z' }]);

		const { status, body } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf(),
		});

		expect(status).toBe(400);
		expect(body.error).toBe('nonce_reused');
	});

	it('returns 400 with invalid_nonce when nonce is not in DB', async () => {
		sqlState.queue.push([]); // no nonce row

		const { status, body } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf(),
		});

		expect(status).toBe(400);
		expect(body.error).toBe('invalid_nonce');
	});

	it('rejects a localhost-domain message on a non-localhost deployment', async () => {
		// The domain binding is what stops a signature harvested by another site
		// from being redeemed here, and /nonce is public, so anyone can mint a
		// nonce and go collect one. Gating the localhost escape hatch on
		// VERCEL_ENV left it wide open on Cloud Run, which never sets that var.
		const { status, body } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: LOCALHOST_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf(),
		});

		expect(status).toBe(400);
		expect(body.error).toBe('invalid_domain');
		// Refused before the nonce is even looked up, let alone burned.
		expect(sqlState.calls).toHaveLength(0);
	});

	it('refuses to revive a soft-deleted account for a returning wallet', async () => {
		sqlState.queue.push([{ nonce: TEST_NONCE, expires_at: FUTURE, consumed_at: null }]);
		sqlState.queue.push([{ nonce: TEST_NONCE }]); // burn RETURNING
		sqlState.queue.push([]); // no user_wallets row
		sqlState.queue.push([{ id: 'user-gone', deleted_at: '2026-01-01T00:00:00.000Z' }]);

		const { status, body, res } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf(),
		});

		expect(status).toBe(403);
		expect(body.error).toBe('account_deleted');
		expect(res.headers['set-cookie']).toBeUndefined();
		// No statement may clear deleted_at behind the user's back.
		expect(sqlState.calls.some((c) => /deleted_at = null/i.test(c.query))).toBe(false);
	});

	it('returns 403 when CSRF header is missing', async () => {
		const { status, body } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('invalid_request');
	});

	it('returns 403 when CSRF token does not match cookie', async () => {
		const { constantTimeEquals } = await import('../../api/_lib/crypto.js');
		vi.mocked(constantTimeEquals).mockReturnValueOnce(false);

		const { status, body } = await invoke({
			action: 'verify',
			method: 'POST',
			body: { message: SIWE_MESSAGE, signature: `0x${'ab'.repeat(65)}` },
			headers: withCsrf({ 'x-csrf-token': 'wrong-csrf-token' }),
		});
		expect(status).toBe(403);
		expect(body.error).toBe('invalid_request');
	});
});
