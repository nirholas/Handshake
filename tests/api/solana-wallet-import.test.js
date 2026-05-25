import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';

// ── Mocks ─────────────────────────────────────────────────────────────────
const authState = { session: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		if (sqlState.queue.length === 0) return [];
		return sqlState.queue.shift();
	}),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { JWT_SECRET: 'test-secret-please-do-not-use-in-production-ever' },
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => ({
		getBalance: vi.fn(async () => 0),
	})),
	// solanaPublicConnection is the read-only RPC fallback the handler uses
	// when the primary (private) RPC is rate-limited or returns 5xx. Stub it
	// with the same surface as the primary so the backoff wrapper has both.
	solanaPublicConnection: vi.fn(() => ({
		getBalance: vi.fn(async () => 0),
	})),
}));

vi.mock('../../api/_lib/agent-wallet.js', () => ({
	generateSolanaAgentWallet: vi.fn(async () => ({
		address: 'GeneratedAddr1111111111111111111111111111111',
		encrypted_secret: 'mocked-cipher',
	})),
}));

const { default: handler } = await import('../../api/agents/solana-wallet.js');

// ── Helpers ──────────────────────────────────────────────────────────────
function makeReq({ method = 'POST', body = null } = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = '/api/agents/agent-1/solana';
	base.headers = { host: 'localhost', 'content-type': 'application/json', origin: 'http://localhost' };
	return base;
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: '', writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(c) { if (c !== undefined) this.body += c; this.writableEnded = true; },
	};
}
async function invoke(opts) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res, 'agent-1');
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	authState.session = null;
	sqlState.queue = [];
	sqlState.calls = [];
});

describe('POST /api/agents/:id/solana — import vanity wallet', () => {
	it('rejects when unauthenticated', async () => {
		const { status, body } = await invoke({ body: { secret_key: [] } });
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects when agent not owned by user', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'someone-else', meta: {} }]);
		const { status, body } = await invoke({ body: { secret_key: Array(64).fill(0), vanity_prefix: 'AGNT' } });
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('rejects malformed secret_key', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: {} }]);
		const { status, body } = await invoke({ body: { secret_key: [1, 2, 3] } });
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/64-byte/);
	});

	it('rejects vanity_prefix that does not match keypair', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: {} }]);
		const kp = Keypair.generate();
		// pick a prefix that almost certainly isn't a real prefix of the address
		const claimedPrefix = kp.publicKey.toBase58().startsWith('Z') ? 'AAAA' : 'ZZZZ';
		const { status, body } = await invoke({
			body: { secret_key: Array.from(kp.secretKey), vanity_prefix: claimedPrefix },
		});
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/does not match/);
	});

	it('imports a valid keypair successfully', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: {} }]);
		sqlState.queue.push([]); // UPDATE result (empty)
		const kp = Keypair.generate();
		const realPrefix = kp.publicKey.toBase58().slice(0, 1); // first char is always valid
		const { status, body } = await invoke({
			body: { secret_key: Array.from(kp.secretKey), vanity_prefix: realPrefix },
		});
		expect(status).toBe(201);
		expect(body.data.address).toBe(kp.publicKey.toBase58());
		expect(body.data.vanity_prefix).toBe(realPrefix);
		expect(body.data.source).toBe('imported_vanity');
	});

	it('rejects import when agent already has a wallet', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: { solana_address: 'ExistingAddr111' } }]);
		const kp = Keypair.generate();
		const { status, body } = await invoke({
			body: { secret_key: Array.from(kp.secretKey) },
		});
		expect(status).toBe(409);
		expect(body.error).toBe('conflict');
	});
});

describe('DELETE /api/agents/:id/solana', () => {
	it('clears the wallet for the owner', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{
			id: 'agent-1', user_id: 'u1',
			meta: { solana_address: 'X', encrypted_solana_secret: 'enc', solana_vanity_prefix: 'AGNT' },
		}]);
		sqlState.queue.push([]); // UPDATE
		const { status, body } = await invoke({ method: 'DELETE' });
		expect(status).toBe(200);
		expect(body.data.ok).toBe(true);
	});
});
