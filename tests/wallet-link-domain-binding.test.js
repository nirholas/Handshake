// The wallet-link handlers bind a signed message to this deployment's own
// domain, with a localhost escape hatch for local development.
//
// That escape hatch used to be gated on VERCEL_ENV. Production runs on Cloud
// Run, which never sets VERCEL_ENV, so the gate read "this is local dev" on the
// live site and a link message signed for `localhost` satisfied the domain and
// URI checks there. The gate is now anchored to the deployment's own
// APP_ORIGIN, so it can only open where the deployment really is local. Same
// fix as api/auth/siwe/[action].js and api/auth/siws/[action].js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bs58 from 'bs58';

process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';
process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { walletLink: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'user-1', email: 'sol-abc@wallet.local' })),
}));
// The nonce store is the step right after the domain/URI checks: reaching it
// proves the message cleared the domain binding.
const consumeNonce = vi.fn(async () => null);
vi.mock('../api/auth/wallets/_link-nonces.js', () => ({
	NONCE_TTL_SEC: 300,
	issueNonce: vi.fn(async () => 'nonce0000000000'),
	consumeNonce: (...args) => consumeNonce(...args),
}));

const { default: handler } = await import('../api/auth/wallets/[action].js');

// Synthetic 32-byte key, base58-encoded the way a real Solana address is. The
// parser decodes and length-checks it, so a hand-typed string will not do.
const SOLANA_ADDRESS = bs58.encode(new Uint8Array(32).fill(7));

function siwsMessage({ domain, uri }) {
	return [
		`${domain} wants you to sign in with your Solana account:`,
		SOLANA_ADDRESS,
		``,
		`Link this wallet to three.ws account sol-abc@wallet.local`,
		``,
		`URI: ${uri}`,
		`Version: 1`,
		`Chain ID: mainnet`,
		`Nonce: nonce0000000000`,
		`Issued At: ${new Date().toISOString()}`,
		`Expiration Time: ${new Date(Date.now() + 300_000).toISOString()}`,
	].join('\n');
}

function makeReq(message) {
	return {
		method: 'POST',
		url: '/api/auth/wallets/link-solana',
		query: { action: 'link-solana' },
		headers: { 'content-type': 'application/json' },
		socket: { remoteAddress: '127.0.0.1' },
		body: JSON.stringify({ message, signature: 'c2lnbmF0dXJl' }),
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => {
		r._h[k] = v;
	};
	r.getHeader = (k) => r._h[k];
	r.end = (b) => {
		r._b = b;
	};
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

const originalNodeEnv = process.env.NODE_ENV;
const originalAppOrigin = process.env.PUBLIC_APP_ORIGIN;

beforeEach(() => {
	consumeNonce.mockClear();
});
afterEach(() => {
	process.env.NODE_ENV = originalNodeEnv;
	process.env.PUBLIC_APP_ORIGIN = originalAppOrigin;
	delete process.env.VERCEL_ENV;
});

describe('POST /api/auth/wallets/link-solana: domain binding', () => {
	it('rejects a localhost-signed message on a production deployment', async () => {
		process.env.NODE_ENV = 'production';
		process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'localhost:3000', uri: 'http://localhost:3000' })), res);

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_domain');
		expect(consumeNonce).not.toHaveBeenCalled();
	});

	it('rejects a localhost-signed message on a non-production deployment served from the real origin', async () => {
		// Preview and staging deployments are not production, but they are not
		// localhost either: the escape hatch must stay shut for them.
		delete process.env.NODE_ENV;
		process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'localhost:3000', uri: 'http://localhost:3000' })), res);

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_domain');
		expect(consumeNonce).not.toHaveBeenCalled();
	});

	it('accepts a localhost-signed message when the deployment itself is localhost', async () => {
		delete process.env.NODE_ENV;
		process.env.PUBLIC_APP_ORIGIN = 'http://localhost:3000';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'localhost:3000', uri: 'http://localhost:3000' })), res);

		// Past the domain and URI checks, into the nonce step.
		expect(consumeNonce).toHaveBeenCalledWith('nonce0000000000', 'user-1');
		expect(res.json().error).toBe('invalid_nonce');
	});

	it('always accepts a message signed for the deployment origin', async () => {
		process.env.NODE_ENV = 'production';
		process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'three.ws', uri: 'https://three.ws' })), res);

		expect(consumeNonce).toHaveBeenCalledWith('nonce0000000000', 'user-1');
		expect(res.json().error).toBe('invalid_nonce');
	});

	it('rejects a foreign domain outright', async () => {
		process.env.NODE_ENV = 'production';
		process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'evil.example', uri: 'https://evil.example' })), res);

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_domain');
		expect(consumeNonce).not.toHaveBeenCalled();
	});

	it('rejects a URI whose origin is not the deployment origin', async () => {
		process.env.NODE_ENV = 'production';
		process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

		const res = makeRes();
		await handler(makeReq(siwsMessage({ domain: 'three.ws', uri: 'https://evil.example/callback' })), res);

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_uri');
		expect(consumeNonce).not.toHaveBeenCalled();
	});
});
