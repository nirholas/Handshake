// Public wallet-read balance path: caching + graceful 429 handling.
// Covers the fix where a rate-limited Solana RPC must surface
// balance_error: 'rpc_rate_limited' (so the card shows "Balance unavailable")
// instead of a misleading 0, and where a cached balance is reused within the
// TTL window rather than re-hitting the RPC on every poll.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';

// Real, valid base58 pubkeys — the handler runs them through the real
// PublicKey constructor before the (mocked) getBalance, so placeholder strings
// would throw there instead of exercising the balance path.
const addr = () => Keypair.generate().publicKey.toBase58();

// Shared, mutable RPC stub state — defined before vi.mock so the (lazy) mock
// factory closes over it, matching the pattern in solana-wallet-import.test.js.
const rpcState = { lamports: 0, calls: 0, err: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.queue.length ? sqlState.queue.shift() : [])),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })), walletRead: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { JWT_SECRET: 'test-secret-please-do-not-use-in-production-ever', APP_ORIGIN: 'http://localhost' },
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => {
	const conn = () => ({
		getBalance: async () => {
			rpcState.calls++;
			if (rpcState.err) throw rpcState.err;
			return rpcState.lamports;
		},
	});
	return { solanaConnection: () => conn(), solanaPublicConnection: () => conn() };
});

vi.mock('../../api/_lib/agent-wallet.js', () => ({
	generateSolanaAgentWallet: vi.fn(async () => ({ address: 'x', encrypted_secret: 'y' })),
}));

const { default: handler } = await import('../../api/agents/solana-wallet.js');

function makeReq(url) {
	const r = Readable.from([]);
	r.method = 'GET';
	r.url = url;
	r.headers = { host: 'localhost', origin: 'http://localhost' };
	return r;
}
function makeRes() {
	return {
		statusCode: 200, headers: {}, body: '', writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(c) { if (c !== undefined) this.body += c; this.writableEnded = true; },
	};
}
async function read(address, network = 'mainnet') {
	// Unique address per call keeps the shared cache from leaking across tests.
	sqlState.queue.push([{ id: 'agent-1', meta: { solana_address: address } }]);
	const req = makeReq(`/api/agents/agent-1/solana?network=${network}`);
	const res = makeRes();
	await handler(req, res, 'agent-1');
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	rpcState.lamports = 0;
	rpcState.calls = 0;
	rpcState.err = null;
	sqlState.queue = [];
});

describe('GET /api/agents/:id/solana — public balance read', () => {
	it('returns the live balance and chain metadata', async () => {
		rpcState.lamports = 2_500_000_000;
		const { status, body } = await read(addr());
		expect(status).toBe(200);
		expect(body.data.balance).toBe(2.5);
		expect(body.data.lamports).toBe(2_500_000_000);
		expect(body.data.balance_error).toBeUndefined();
	});

	it('surfaces balance_error=rpc_rate_limited when the RPC 429s on every attempt', async () => {
		rpcState.err = new Error('failed to get balance: 429 Too Many Requests: max usage reached');
		const { status, body } = await read(addr());
		expect(status).toBe(200); // graceful — never 500s
		expect(body.data.balance).toBeNull();
		expect(body.data.balance_error).toBe('rpc_rate_limited');
	});

	it('classifies non-rate-limit RPC failures as rpc_error', async () => {
		rpcState.err = new Error('fetch failed: ECONNREFUSED');
		const { body } = await read(addr());
		expect(body.data.balance).toBeNull();
		expect(body.data.balance_error).toBe('rpc_error');
	});

	it('serves the second read from cache without re-hitting the RPC', async () => {
		rpcState.lamports = 1_000_000_000;
		const wallet = addr();
		const first = await read(wallet);
		const callsAfterFirst = rpcState.calls;
		expect(first.body.data.balance).toBe(1);
		expect(callsAfterFirst).toBeGreaterThan(0);

		const second = await read(wallet);
		expect(second.body.data.balance).toBe(1);
		expect(rpcState.calls).toBe(callsAfterFirst); // no additional RPC call
	});
});
