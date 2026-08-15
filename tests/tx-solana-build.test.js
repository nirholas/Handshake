// Endpoint tests for POST /api/tx/solana/build-transfer and /build-swap — the
// two handlers the chat wallet tools call to assemble an unsigned transaction
// before a user signs it in their wallet.
//
// Three classes of regression are pinned here, all found by probing the live
// handlers:
//
// 1. Token-2022. $THREE, and every pump.fun-era mint, is owned by the Token-2022
//    program. The builder hardcoded the original token program, so getMint threw
//    TokenInvalidAccountOwnerError and a user trying to send the platform's own
//    coin got a 500. The mint's owning program is resolved from the chain now,
//    and the transfer instruction is TransferChecked (Token-2022 mints with a
//    transfer-fee extension reject the unchecked variant).
//
// 2. Caller input answered as caller input. A malformed address, a non-mint, a
//    program-derived owner, and an oversized memo were each an unhandled throw
//    inside the handler, so every one of them surfaced as a 500 + Sentry capture
//    + ops alert for what is plainly a 400.
//
// 3. The Jupiter endpoint. build-swap called quote-api.jup.ag/v6, a host that no
//    longer resolves; the bare `fetch failed` was then misread by wrap()'s
//    classifier as a database outage and answered 503 "database temporarily
//    unavailable". It routes through the shared lite-api client now, and a
//    network failure is caught at the boundary as a 502.
//
// The RPC connection and the Jupiter client are mocked; http.js (wrap/json/
// cors/method), the zod schemas, and the real @solana/spl-token instruction
// builders all run for real, so the wire contract is genuinely exercised.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WALLET_A = 'CAfLDxzVGURoHbeZoWsU7APuwCTUBK3v4u8LY6EjSstp';
const WALLET_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// Off the ed25519 curve: a program-derived address has no associated token
// account and no keypair, so it can be neither sender nor recipient here.
const PDA = '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z';
const WSOL = 'So11111111111111111111111111111111111111112';

// Program ids the assertions decode instruction owners against.
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
// SPL TransferChecked discriminator (instruction 12).
const TRANSFER_CHECKED = 12;

// ── chain state the mocked connection serves ─────────────────────────────────
let mintOwner = TOKEN_2022_PROGRAM_ID;
let mintExists = true;
let mintDecimals = 6;
let senderTokenAmount = '5000000000';
let recipientAtaExists = false;
let getAccountInfoError = null;

const BLOCKHASH = { blockhash: '7yfLFPfbbzAk52tx5BxfsDcfrneAoJfwEihVJtnkM9ph', lastValidBlockHeight: 417508552 };

const connection = {
	async getAccountInfo(pubkey) {
		if (getAccountInfoError) throw new Error(getAccountInfoError);
		const key = pubkey.toBase58();
		if (key === THREE_MINT || key === WSOL) {
			return mintExists ? { owner: mintOwner, data: Buffer.alloc(82) } : null;
		}
		// Anything else asked for here is a recipient ATA probe.
		return recipientAtaExists ? { owner: mintOwner, data: Buffer.alloc(165) } : null;
	},
	async getTokenAccountBalance() {
		if (senderTokenAmount === null) throw new Error('could not find account');
		return { value: { amount: senderTokenAmount, decimals: mintDecimals } };
	},
	async getLatestBlockhash() {
		return BLOCKHASH;
	},
};

vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => connection),
}));

// getMint reads the mint account itself; the handler only needs decimals from it.
vi.mock('@solana/spl-token', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getMint: vi.fn(async (_conn, mintPk, _commitment, programId) => {
			if (!programId.equals(mintOwner)) {
				throw new actual.TokenInvalidAccountOwnerError();
			}
			return { address: mintPk, decimals: mintDecimals };
		}),
	};
});

// Jupiter: the shared lite-api client. Tests drive its two outcomes.
const jupiterQuote = vi.fn();
const jupiterSwapTx = vi.fn();
vi.mock('../api/_lib/token/jupiter.js', () => ({
	jupiterQuote: (...a) => jupiterQuote(...a),
	jupiterSwapTx: (...a) => jupiterSwapTx(...a),
}));

let session = { id: 'u1' };
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// Keep a 5xx from reaching the real Sentry / ops-alert sinks.
vi.mock('../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));

import handler from '../api/tx/solana/[action].js';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

function req(action, body) {
	return {
		method: 'POST',
		url: `/api/tx/solana/${action}?action=${action}`,
		headers: { 'content-type': 'application/json' },
		socket: {},
		query: { action },
		body,
	};
}

async function call(action, body) {
	const res = mockRes();
	await handler(req(action, body), res);
	return res;
}

// Decode a base64 legacy transaction into the program id + first data byte of
// each instruction, which is all these assertions need.
function decodeInstructions(base64) {
	const raw = Buffer.from(base64, 'base64');
	const sigCount = raw[0];
	const msg = raw.subarray(1 + 64 * sigCount);
	let i = 3; // message header
	const readCompactU16 = () => {
		let value = 0;
		let shift = 0;
		for (;;) {
			const byte = msg[i++];
			value |= (byte & 0x7f) << shift;
			if (!(byte & 0x80)) break;
			shift += 7;
		}
		return value;
	};
	const keyCount = readCompactU16();
	const keys = [];
	for (let k = 0; k < keyCount; k++) {
		keys.push(new PublicKey(msg.subarray(i + 32 * k, i + 32 * (k + 1))).toBase58());
	}
	i += 32 * keyCount + 32; // account keys + recent blockhash
	const ixCount = readCompactU16();
	const out = [];
	for (let n = 0; n < ixCount; n++) {
		const programIndex = msg[i++];
		i += readCompactU16(); // account indexes
		const dataLen = readCompactU16();
		const data = msg.subarray(i, i + dataLen);
		i += dataLen;
		out.push({ program: keys[programIndex], data });
	}
	return out;
}

beforeEach(() => {
	mintOwner = TOKEN_2022_PROGRAM_ID;
	mintExists = true;
	mintDecimals = 6;
	senderTokenAmount = '5000000000';
	recipientAtaExists = false;
	getAccountInfoError = null;
	session = { id: 'u1' };
	jupiterQuote.mockReset();
	jupiterSwapTx.mockReset();
	vi.clearAllMocks();
});

describe('POST /api/tx/solana/[action] routing and auth', () => {
	it('404s an action that is not in the dispatch table', async () => {
		const res = await call('build-nothing', {});
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});

	it('401s build-transfer without a session', async () => {
		session = null;
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1 });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});

	it('401s build-swap without a session', async () => {
		session = null;
		const res = await call('build-swap', { sender: WALLET_A, inputMint: WSOL, outputMint: THREE_MINT, amount: 1 });
		expect(res.statusCode).toBe(401);
		expect(res.json.error).toBe('unauthorized');
	});
});

describe('build-transfer', () => {
	it('builds a native SOL transfer with exact lamports and no float drift', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 0.1 });
		expect(res.statusCode).toBe(200);
		expect(res.json.blockhash).toBe(BLOCKHASH.blockhash);
		expect(res.json.lastValidBlockHeight).toBe(BLOCKHASH.lastValidBlockHeight);

		const ixs = decodeInstructions(res.json.transaction);
		expect(ixs).toHaveLength(1);
		expect(ixs[0].program).toBe('11111111111111111111111111111111');
		// SystemProgram.transfer: u32 instruction index 2, then u64 lamports.
		expect(ixs[0].data.readUInt32LE(0)).toBe(2);
		expect(ixs[0].data.readBigUInt64LE(4)).toBe(100_000_000n);
	});

	it('appends a memo instruction when one is supplied', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 0.001, memo: 'gm' });
		expect(res.statusCode).toBe(200);
		const ixs = decodeInstructions(res.json.transaction);
		expect(ixs).toHaveLength(2);
		expect(ixs[1].program).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
		expect(ixs[1].data.toString('utf8')).toBe('gm');
	});

	it('builds a Token-2022 transfer for $THREE against the Token-2022 program', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1.5, token: THREE_MINT });
		expect(res.statusCode).toBe(200);

		const ixs = decodeInstructions(res.json.transaction);
		// The recipient has no ATA in this fixture, so one is created first.
		expect(ixs.map((ix) => ix.program)).toEqual([ATA_PROGRAM, TOKEN_2022_PROGRAM_ID.toBase58()]);
		const transfer = ixs[1];
		expect(transfer.data[0]).toBe(TRANSFER_CHECKED);
		expect(transfer.data.readBigUInt64LE(1)).toBe(1_500_000n);
		expect(transfer.data[9]).toBe(mintDecimals);
	});

	it('omits the create-ATA instruction when the recipient already holds the token', async () => {
		recipientAtaExists = true;
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(200);
		const ixs = decodeInstructions(res.json.transaction);
		expect(ixs).toHaveLength(1);
		expect(ixs[0].program).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
	});

	it('still builds against the original token program for a classic mint', async () => {
		mintOwner = TOKEN_PROGRAM_ID;
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(200);
		const ixs = decodeInstructions(res.json.transaction);
		expect(ixs.at(-1).program).toBe(TOKEN_PROGRAM_ID.toBase58());
	});

	it('400s a malformed sender address instead of throwing', async () => {
		const res = await call('build-transfer', { sender: 'not-a-pubkey', recipient: WALLET_B, amount: 1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(res.json.issues[0].path).toEqual(['sender']);
	});

	it('400s a malformed recipient address', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: 'zzz', amount: 1 });
		expect(res.statusCode).toBe(400);
		expect(res.json.issues[0].path).toEqual(['recipient']);
	});

	it('400s an address that exists but is not an SPL mint', async () => {
		mintOwner = new PublicKey('11111111111111111111111111111111');
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_mint');
	});

	it('400s a mint that does not exist on this network', async () => {
		mintExists = false;
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_mint');
	});

	it('400s a program-derived sender, which has no associated token account', async () => {
		const res = await call('build-transfer', { sender: PDA, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_owner');
		expect(res.json.error_description).toContain('sender');
	});

	it('400s before signing when the sender holds too little of the token', async () => {
		senderTokenAmount = '100';
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('insufficient_balance');
	});

	it('400s an amount that rounds to zero at the mint precision', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1e-9, token: THREE_MINT });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_amount');
	});

	it('400s a memo larger than the memo program accepts', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, memo: 'x'.repeat(600) });
		expect(res.statusCode).toBe(400);
		expect(res.json.issues[0].path).toEqual(['memo']);
	});

	it('400s a network outside the supported enum', async () => {
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, network: 'testnet' });
		expect(res.statusCode).toBe(400);
		expect(res.json.issues[0].path).toEqual(['network']);
	});

	it('502s an RPC outage rather than reporting it as a caller fault', async () => {
		getAccountInfoError = 'fetch failed';
		const res = await call('build-transfer', { sender: WALLET_A, recipient: WALLET_B, amount: 1, token: THREE_MINT });
		expect(res.statusCode).toBe(502);
		expect(res.json.error).toBe('upstream_error');
	});
});

describe('build-swap', () => {
	const swapBody = { sender: WALLET_A, inputMint: WSOL, outputMint: THREE_MINT, amount: 0.01 };

	it('returns the Jupiter transaction with a human-readable output amount', async () => {
		jupiterQuote.mockResolvedValue({ outAmount: '123456789', priceImpactPct: '0.12' });
		jupiterSwapTx.mockResolvedValue('BASE64SWAPTX');

		const res = await call('build-swap', swapBody);
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({
			transaction: 'BASE64SWAPTX',
			network: 'mainnet',
			inputAmount: 0.01,
			outputMint: THREE_MINT,
			priceImpactPct: '0.12',
		});
		expect(res.json.outputAmount).toBeCloseTo(123.456789, 6);
	});

	it('scales the quote amount by the input mint decimals', async () => {
		jupiterQuote.mockResolvedValue({ outAmount: '1', priceImpactPct: '0' });
		jupiterSwapTx.mockResolvedValue('tx');
		await call('build-swap', swapBody);
		expect(jupiterQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: '10000' }));
	});

	it('422s when Jupiter has no route for the pair', async () => {
		jupiterQuote.mockRejectedValue(Object.assign(new Error('jupiter 400'), { status: 400, code: 'jupiter_error' }));
		const res = await call('build-swap', swapBody);
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('no_route');
	});

	it('422s when Jupiter answers a quote but cannot build the transaction', async () => {
		jupiterQuote.mockResolvedValue({ outAmount: '1', priceImpactPct: '0' });
		jupiterSwapTx.mockRejectedValue(Object.assign(new Error('jupiter 422'), { status: 422, code: 'jupiter_error' }));
		const res = await call('build-swap', swapBody);
		expect(res.statusCode).toBe(422);
		expect(res.json.error).toBe('swap_failed');
	});

	it('502s a Jupiter network failure instead of reporting a database outage', async () => {
		jupiterQuote.mockRejectedValue(new TypeError('fetch failed'));
		const res = await call('build-swap', swapBody);
		expect(res.statusCode).toBe(502);
		expect(res.json.error).toBe('upstream_error');
	});

	it('400s a swap whose input and output mints are the same', async () => {
		const res = await call('build-swap', { ...swapBody, outputMint: WSOL });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_route');
		expect(jupiterQuote).not.toHaveBeenCalled();
	});

	it('400s a malformed mint before any upstream call', async () => {
		const res = await call('build-swap', { ...swapBody, inputMint: 'zzz' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('validation_error');
		expect(jupiterQuote).not.toHaveBeenCalled();
	});

	it('400s a slippage outside the accepted range', async () => {
		const res = await call('build-swap', { ...swapBody, slippageBps: 99999 });
		expect(res.statusCode).toBe(400);
		expect(res.json.issues[0].path).toEqual(['slippageBps']);
	});
});
