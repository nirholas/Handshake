import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';

const VALID_PUBKEY = Keypair.generate().publicKey.toBase58();

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.queue.length ? sqlState.queue.shift() : [])),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
}));

const conn = {
	requestAirdrop: vi.fn(async () => 'AIRDROPSIG'.padEnd(88, 'A')),
	confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
	getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 1 }], context: { slot: 1 } })),
	getBlockHeight: vi.fn(async () => 1),
};
vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: vi.fn(() => conn),
}));

// The production path: /api/agents/:id/solana/airdrop is dispatched by
// api/agents/[id].js into the solana-wallet handler with action='airdrop'.
const { default: handler } = await import('../../api/agents/solana-wallet.js');

function makeReq() {
	const base = Readable.from([]);
	base.method = 'POST';
	base.url = '/api/agents/agent-1/solana/airdrop';
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
async function invoke() {
	const req = makeReq();
	const res = makeRes();
	await handler(req, res, 'agent-1', 'airdrop');
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	authState.session = null;
	sqlState.queue = [];
	conn.requestAirdrop.mockClear();
});

describe('POST /api/agents/:id/solana/airdrop', () => {
	it('rejects unauthenticated', async () => {
		const { status } = await invoke();
		expect(status).toBe(401);
	});
	it('rejects when not owner', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'other', meta: { solana_address: 'X' } }]);
		const { status } = await invoke();
		expect(status).toBe(403);
	});
	it('rejects when no wallet', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: {} }]);
		const { status, body } = await invoke();
		expect(status).toBe(404);
		expect(body.error_description).toMatch(/wallet/);
	});
	it('returns signature on success', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: { solana_address: VALID_PUBKEY } }]);
		const { status, body } = await invoke();
		expect(status).toBe(200);
		expect(body.data.signature).toMatch(/^AIRDROPSIG/);
		expect(body.data.network).toBe('devnet');
		expect(body.data.sol).toBe(1);
	});
	it('returns 502 when faucet fails', async () => {
		authState.session = { id: 'u1' };
		sqlState.queue.push([{ id: 'agent-1', user_id: 'u1', meta: { solana_address: VALID_PUBKEY } }]);
		conn.requestAirdrop.mockRejectedValueOnce(new Error('429 Too Many Requests'));
		const { status, body } = await invoke();
		expect(status).toBe(502);
		expect(body.error).toBe('faucet_unavailable');
	});
});
