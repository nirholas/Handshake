// POST /api/knock/escrowed: the escrowed lane's refusal surface.
//
// The handler's whole job is to refuse anything the chain does not back, so the
// cases that matter are the refusals. Each one below is something a caller can
// really do, and getting any of them wrong means either delivering a message
// nobody paid for or telling somebody who did pay that they did not.
//
// Everything downstream of the seams is the real handler: the real zod schema,
// the real ordering of checks, the real escrow verifier decoding real
// program-layout bytes. Only the two boundaries are stubbed, the database and
// the Solana RPC, because this suite is about the handler's decisions rather
// than about Postgres or a live cluster. The PDA derivation those bytes are
// keyed by is pinned against the compiled program in tests/knock-escrow-pda.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const OWNER_WALLET = '11111111111111111111111111111111';
const SENDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HANDLE = 'nirholas';
const NONCE = 7;
const PRICE = '50000';
// From tests/knock-escrow-pda.test.js, which pins these against the program.
const KNOCK_PDA = '8WvZ64SL6JNss232BC78aapB2M6MjE95f9LtWfYYRn5t';
const DOOR_PDA = 'DMDKj3mSoM5rjsftGAhSbLbrAWMwmFxEkHDLsx997vk8';
const DISC_KNOCK = 'f9c621b06c558191';
const PROGRAM = 'uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7';

const state = {
	door: null,
	payout: null,
	account: null,
	accountOwner: PROGRAM,
	existingByEscrow: null,
	delivered: [],
	checkDoorThrows: null,
};

vi.mock('../api/_lib/knock/store.js', () => ({
	publicDoorByHandle: async () => state.door,
	payoutFor: async () => state.payout,
	findByEscrowKnock: async () => state.existingByEscrow,
}));

vi.mock('../api/_lib/knock/deliver.js', () => ({
	checkDoor: async (userId, input) => {
		if (state.checkDoorThrows) throw state.checkDoorThrows;
		return { clean: { message: input.message, senderName: input.from, subject: input.subject ?? null } };
	},
	deliverKnock: async (args) => {
		state.delivered.push(args);
		return { knock: { id: 'knock-row-1' }, duplicate: false };
	},
}));

vi.mock('../api/_lib/knock/receipt.js', () => ({ receiptUrl: (id) => `/knock/receipt/${id}` }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.9',
	limits: { knockSendIp: async () => ({ success: true }) },
}));

vi.mock('../api/_lib/solana/rpc-fallback.js', () => ({
	rpcFallbackFromEnv: () => ({
		withFallback: (fn) =>
			fn({
				async getAccountInfo() {
					if (!state.account) return null;
					return { data: state.account, owner: { toBase58: () => state.accountOwner } };
				},
			}),
	}),
}));

const { default: handler } = await import('../api/knock/escrowed.js');
const { sha256 } = await import('../api/_lib/knock/escrow.js');

/** A KnockRecord laid out exactly as the program writes one. */
function knockAccount({
	messageHash,
	amount = 50_000n,
	state: knockState = 0,
	expiresAt = Math.floor(Date.now() / 1000) + 3600,
} = {}) {
	const buf = Buffer.alloc(205);
	Buffer.from(DISC_KNOCK, 'hex').copy(buf, 0);
	new PublicKey(DOOR_PDA).toBuffer().copy(buf, 8);
	new PublicKey(SENDER).toBuffer().copy(buf, 40);
	new PublicKey(USDC).toBuffer().copy(buf, 72);
	buf.writeBigUInt64LE(amount, 104);
	buf.writeUInt16LE(250, 112);
	buf.writeBigUInt64LE(BigInt(NONCE), 114);
	Buffer.from(messageHash).copy(buf, 122);
	buf.writeBigInt64LE(BigInt(expiresAt - 3600), 186);
	buf.writeBigInt64LE(BigInt(expiresAt), 194);
	buf[202] = knockState;
	return buf;
}

function call(body) {
	const req = {
		method: 'POST',
		url: '/api/knock/escrowed',
		headers: { 'content-type': 'application/json', origin: 'https://three.ws' },
		body,
		socket: { remoteAddress: '203.0.113.9' },
	};
	const res = {
		statusCode: 0,
		payload: null,
		headers: {},
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[String(k).toLowerCase()];
		},
		writeHead(code) {
			this.statusCode = code;
			return this;
		},
		get headersSent() {
			return false;
		},
		get writableEnded() {
			return false;
		},
		end(chunk) {
			if (chunk) {
				try {
					this.payload = JSON.parse(String(chunk));
				} catch {
					this.payload = String(chunk);
				}
			}
			return this;
		},
	};
	return handler(req, res).then(() => ({ status: res.statusCode, body: res.payload }));
}

const MESSAGE = 'two questions about the facilitator, happy to pay for the time';
const goodBody = {
	to: HANDLE,
	from: 'Ada (research agent)',
	message: MESSAGE,
	sender_wallet: SENDER,
	nonce: NONCE,
};

beforeEach(() => {
	state.door = {
		user_id: 'user-1',
		username: HANDLE,
		display_name: 'nirholas',
		price_atomics: PRICE,
		escrow_enabled: true,
		escrow_window_hours: 24,
	};
	state.payout = { pay_to_solana: OWNER_WALLET };
	state.account = knockAccount({ messageHash: sha256(MESSAGE) });
	state.accountOwner = PROGRAM;
	state.existingByEscrow = null;
	state.delivered = [];
	state.checkDoorThrows = null;
});

describe('POST /api/knock/escrowed', () => {
	it('delivers a message backed by a live escrow, and says when it expires', async () => {
		const out = await call(goodBody);
		expect(out.status).toBe(201);
		expect(out.body.ok).toBe(true);
		expect(out.body.escrow.knock).toBe(KNOCK_PDA);
		expect(out.body.escrow.program).toBe(PROGRAM);
		expect(out.body.escrow.amount_atomics).toBe('50000');
		expect(out.body.escrow.state).toBe('pending');
		expect(out.body.escrow.expires_in_seconds).toBeGreaterThan(0);
		expect(out.body.receipt).toBe('/knock/receipt/knock-row-1');

		// The delivery carries the escrow through, so the inbox can show a
		// countdown and the row can be reconciled against the chain later.
		expect(state.delivered).toHaveLength(1);
		expect(state.delivered[0].payment).toMatchObject({
			escrowKnock: KNOCK_PDA,
			escrowState: 'pending',
			network: 'solana',
			asset: USDC,
		});
	});

	it('answers 402, not 500, when no escrow exists', async () => {
		state.account = null;
		const out = await call(goodBody);
		expect(out.status).toBe(402);
		expect(out.body.error).toBe('knock_not_found');
		// The caller is told which account to go and fund.
		expect(out.body.knock).toBe(KNOCK_PDA);
		expect(state.delivered).toHaveLength(0);
	});

	it('refuses a message the sender did not escrow, so a payment cannot be reused', async () => {
		state.account = knockAccount({ messageHash: sha256('a much smaller favour') });
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('message_mismatch');
		expect(state.delivered).toHaveLength(0);
	});

	it('refuses an escrow that already settled', async () => {
		state.account = knockAccount({ messageHash: sha256(MESSAGE), state: 1 });
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('already_settled');
	});

	it('refuses an expired escrow, because that money is owed back', async () => {
		state.account = knockAccount({
			messageHash: sha256(MESSAGE),
			expiresAt: Math.floor(Date.now() / 1000) - 5,
		});
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('window_closed');
	});

	it('refuses an escrow below the door price', async () => {
		state.account = knockAccount({ messageHash: sha256(MESSAGE), amount: 10_000n });
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('underpaid');
	});

	it('refuses an account owned by another program', async () => {
		state.accountOwner = '11111111111111111111111111111111';
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('wrong_program');
	});

	it('checks the door BEFORE the chain, so a doomed message never reports a good escrow', async () => {
		const refusal = Object.assign(new Error('this door is full for today'), {
			code: 'door_full',
			status: 429,
		});
		state.checkDoorThrows = refusal;
		state.account = null; // would be a 402 if the chain were consulted first
		const out = await call(goodBody);
		// The door's own refusal wins, and it is the door's status the caller
		// sees, not a payment error about an escrow that was never the problem.
		expect(out.status).toBe(429);
		expect(out.body.error).toBe('door_full');
		expect(state.delivered).toHaveLength(0);
	});

	it('points a caller at the right lane when the door does not take escrow', async () => {
		state.door.escrow_enabled = false;
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('escrow_not_enabled');
		expect(out.body.endpoint).toContain('/api/x402/knock');
	});

	it('refuses a door with no Solana address, which has no on-chain door at all', async () => {
		state.payout = { pay_to_solana: null };
		const out = await call(goodBody);
		expect(out.status).toBe(409);
		expect(out.body.error).toBe('no_payout_wallet');
	});

	it('404s an unknown handle', async () => {
		state.door = null;
		const out = await call(goodBody);
		expect(out.status).toBe(404);
		expect(out.body.error).toBe('no_door');
	});

	it('returns the original delivery when one escrow is replayed', async () => {
		state.existingByEscrow = { id: 'knock-row-1' };
		const out = await call(goodBody);
		expect(out.status).toBe(200);
		expect(out.body.duplicate).toBe(true);
		expect(out.body.knock_id).toBe('knock-row-1');
		// One escrow buys one message: no second delivery is staged.
		expect(state.delivered).toHaveLength(0);
	});

	it('accepts a nonce sent as a string, which is how a JSON client avoids u64 loss', async () => {
		const out = await call({ ...goodBody, nonce: String(NONCE) });
		expect(out.status).toBe(201);
		expect(out.body.escrow.knock).toBe(KNOCK_PDA);
	});
});
