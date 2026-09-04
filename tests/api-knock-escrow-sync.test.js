// POST /api/knock/escrow-sync: keeping the cache honest about the chain.
//
// The escrow_* columns are a cache of what the program recorded, and nothing
// ever tells this server that a settlement happened: the transactions are
// signed by wallets we do not hold. So the only correct behaviour is to look,
// and to write back exactly what was found. These tests are about the two ways
// that goes wrong. Writing a state the chain did not record would let a caller
// mark their own knock refunded; refusing to write one it did record leaves a
// refunded knock sitting in an inbox looking like money on the table.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const PROGRAM = 'uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7';
const KNOCK = '8WvZ64SL6JNss232BC78aapB2M6MjE95f9LtWfYYRn5t';
const DOOR = 'DMDKj3mSoM5rjsftGAhSbLbrAWMwmFxEkHDLsx997vk8';
const SENDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const state = { row: null, account: null, accountOwner: PROGRAM, rpcThrows: false, updates: [] };

vi.mock('../api/_lib/knock/store.js', () => ({
	findByEscrowKnock: async () => state.row,
	updateEscrowState: async (knock, next) => {
		state.updates.push([knock, next]);
		return { id: 'row-1', escrow_knock: knock, escrow_state: next };
	},
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.9',
	limits: { knockSendIp: async () => ({ success: true }) },
}));

vi.mock('../api/_lib/solana/rpc-fallback.js', () => ({
	rpcFallbackFromEnv: () => ({
		withFallback: (fn) => {
			if (state.rpcThrows) throw new Error('every provider refused');
			return fn({
				async getAccountInfo() {
					if (!state.account) return null;
					return { data: state.account, owner: { toBase58: () => state.accountOwner } };
				},
			});
		},
	}),
}));

const { default: handler } = await import('../api/knock/escrow-sync.js');

function knockAccount({ knockState = 0, expiresAt = Math.floor(Date.now() / 1000) + 3600 } = {}) {
	const buf = Buffer.alloc(205);
	Buffer.from('f9c621b06c558191', 'hex').copy(buf, 0);
	new PublicKey(DOOR).toBuffer().copy(buf, 8);
	new PublicKey(SENDER).toBuffer().copy(buf, 40);
	new PublicKey(USDC).toBuffer().copy(buf, 72);
	buf.writeBigUInt64LE(50_000n, 104);
	buf.writeUInt16LE(250, 112);
	buf.writeBigUInt64LE(7n, 114);
	buf.writeBigInt64LE(BigInt(expiresAt - 3600), 186);
	buf.writeBigInt64LE(BigInt(expiresAt), 194);
	buf[202] = knockState;
	return buf;
}

function call(body) {
	const req = {
		method: 'POST',
		url: '/api/knock/escrow-sync',
		headers: { 'content-type': 'application/json', origin: 'https://three.ws' },
		body,
		socket: { remoteAddress: '203.0.113.9' },
	};
	const res = {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		writeHead(code) { this.statusCode = code; return this; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		end(chunk) {
			if (chunk) {
				try { this.payload = JSON.parse(String(chunk)); } catch { this.payload = String(chunk); }
			}
			return this;
		},
	};
	return handler(req, res).then(() => ({ status: res.statusCode, body: res.payload }));
}

beforeEach(() => {
	state.row = { id: 'row-1', escrow_knock: KNOCK, escrow_state: 'pending' };
	state.account = knockAccount();
	state.accountOwner = PROGRAM;
	state.rpcThrows = false;
	state.updates = [];
});

describe('POST /api/knock/escrow-sync', () => {
	it('writes back a settlement the chain recorded', async () => {
		state.account = knockAccount({ knockState: 1 });
		const out = await call({ knock: KNOCK });
		expect(out.status).toBe(200);
		expect(out.body.state).toBe('answered');
		expect(out.body.changed).toBe(true);
		expect(state.updates).toEqual([[KNOCK, 'answered']]);
	});

	it('writes nothing when the chain agrees with the cache', async () => {
		const out = await call({ knock: KNOCK });
		expect(out.body.state).toBe('pending');
		expect(out.body.changed).toBe(false);
		expect(state.updates).toHaveLength(0);
	});

	it('reports an expired escrow as expired while it is still pending', async () => {
		state.account = knockAccount({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
		const out = await call({ knock: KNOCK });
		expect(out.body.state).toBe('pending');
		expect(out.body.expired).toBe(true);
	});

	it('refuses an escrow this platform never delivered against', async () => {
		state.row = null;
		const out = await call({ knock: KNOCK });
		expect(out.status).toBe(404);
		expect(out.body.error).toBe('unknown_escrow');
		expect(state.updates).toHaveLength(0);
	});

	it('changes nothing when an account is owned by another program', async () => {
		// A lookalike account is not evidence about our escrow, so the cached
		// state has to survive it untouched rather than being reset to pending.
		state.row.escrow_state = 'answered';
		state.accountOwner = '11111111111111111111111111111111';
		const out = await call({ knock: KNOCK });
		expect(out.status).toBe(200);
		expect(out.body.state).toBe('answered');
		expect(out.body.changed).toBe(false);
		expect(state.updates).toHaveLength(0);
	});

	it('leaves the cache alone when no RPC will answer', async () => {
		state.rpcThrows = true;
		const out = await call({ knock: KNOCK });
		expect(out.status).toBe(503);
		expect(out.body.error).toBe('chain_unreachable');
		expect(state.updates).toHaveLength(0);
	});
});
