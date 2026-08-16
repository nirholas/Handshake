// The /api/rider/* pass surface: shared payment policy plus all four handlers.
//
// This surface shipped with three defects that only a test at the handler
// boundary catches:
//   1. /api/rider/check answered from the on-chain balance alone, so a wallet
//      that BOUGHT a pass (and therefore sent its $THREE away) read as having
//      none. rider_passes had a writer and no reader at all.
//   2. /api/rider/firebase read RIDER_FIREBASE_* env vars that api/_lib/env.js
//      never declared, so it always returned 200 with an all-null config that
//      crashes initializeApp() on the client.
//   3. /api/rider/webhook wrote one row per qualifying transfer, so a single
//      batch transaction paying from two wallets tripped the UNIQUE index on
//      tx_signature, 500'd, and sent Helius into a redelivery loop.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qualifyingPayments, REQUIRED_AMOUNT } from '../api/_lib/rider.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const VAULT = 'ThreeVau1t1111111111111111111111111111111111';
const WALLET_A = 'So11111111111111111111111111111111111111112';
const WALLET_B = 'Sysvar1nstructions1111111111111111111111111';

// ── module doubles ──────────────────────────────────────────────────────────

const dbState = { rows: [], writes: [], fail: null };
vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		if (dbState.fail) throw dbState.fail;
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (/insert into rider_passes/.test(q)) {
			dbState.writes.push({ wallet: values[0], amount: values[1], signature: values[2] });
			return [];
		}
		if (/from rider_passes/.test(q)) {
			return dbState.rows.filter((r) => r.wallet_address === values[0]);
		}
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const rpcState = { accounts: [], fail: null };
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({
		getParsedTokenAccountsByOwner: async () => {
			if (rpcState.fail) throw rpcState.fail;
			return { value: rpcState.accounts };
		},
	}),
}));

const { default: checkHandler } = await import('../api/rider/check.js');
const { default: firebaseHandler } = await import('../api/rider/firebase.js');
const { default: infoHandler } = await import('../api/rider/info.js');
const { default: webhookHandler } = await import('../api/rider/webhook.js');

// ── http doubles ────────────────────────────────────────────────────────────

function makeRes() {
	return {
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
}

async function callGet(handler, path, query = {}) {
	const res = makeRes();
	await handler({ method: 'GET', url: path, headers: {}, query }, res);
	return res;
}

async function postWebhook(body, { authorization } = {}) {
	const res = makeRes();
	const headers = { 'content-type': 'application/json' };
	if (authorization) headers.authorization = authorization;
	await webhookHandler({ method: 'POST', url: '/api/rider/webhook', headers, body }, res);
	return res;
}

function tokenAccount(uiAmount) {
	return { account: { data: { parsed: { info: { tokenAmount: { uiAmount } } } } } };
}

beforeEach(() => {
	dbState.rows = [];
	dbState.writes = [];
	dbState.fail = null;
	rpcState.accounts = [];
	rpcState.fail = null;
	delete process.env.RIDER_VAULT_ADDRESS;
	delete process.env.RIDER_HELIUS_WEBHOOK_SECRET;
	delete process.env.RIDER_FIREBASE_API_KEY;
	delete process.env.RIDER_FIREBASE_PROJECT_ID;
	delete process.env.RIDER_FIREBASE_AUTH_DOMAIN;
});

// ── qualifyingPayments ──────────────────────────────────────────────────────

describe('qualifyingPayments', () => {
	const opts = { vaultAddress: VAULT, mint: MINT };

	it('accepts a transfer at the threshold and reports the sender', () => {
		const out = qualifyingPayments(
			[{ signature: 'sig1', tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: REQUIRED_AMOUNT }] }],
			opts,
		);
		expect(out).toEqual([{ wallet: WALLET_A, amount: REQUIRED_AMOUNT, signature: 'sig1' }]);
	});

	it('credits every sender in one batch transaction', () => {
		const out = qualifyingPayments(
			[{
				signature: 'batch',
				tokenTransfers: [
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 9000 },
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_B, tokenAmount: 8000 },
				],
			}],
			opts,
		);
		expect(out.map((p) => p.wallet).sort()).toEqual([WALLET_A, WALLET_B].sort());
		expect(out.every((p) => p.signature === 'batch')).toBe(true);
	});

	it('sums a wallet split across several legs of one transaction', () => {
		const out = qualifyingPayments(
			[{
				signature: 'split',
				tokenTransfers: [
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 5000 },
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 3000 },
				],
			}],
			opts,
		);
		expect(out).toEqual([{ wallet: WALLET_A, amount: 8000, signature: 'split' }]);
	});

	it('drops short payments, other mints, other destinations and failed transactions', () => {
		const out = qualifyingPayments(
			[
				{ signature: 'short', tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 7999 }] },
				{ signature: 'other-mint', tokenTransfers: [{ mint: 'NotTheThreeMint1111111111111111111111111111', toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 50000 }] },
				{ signature: 'other-dest', tokenTransfers: [{ mint: MINT, toUserAccount: WALLET_B, fromUserAccount: WALLET_A, tokenAmount: 50000 }] },
				{ signature: 'failed', transactionError: { InstructionError: [0, 'Custom'] }, tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 50000 }] },
				{ signature: 'no-sender', tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, tokenAmount: 50000 }] },
			],
			opts,
		);
		expect(out).toEqual([]);
	});

	it('returns nothing for a non-array body or an unset vault', () => {
		expect(qualifyingPayments(null, opts)).toEqual([]);
		expect(qualifyingPayments({ signature: 'x' }, opts)).toEqual([]);
		expect(qualifyingPayments([{ signature: 's', tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 50000 }] }], { vaultAddress: '', mint: MINT })).toEqual([]);
	});
});

// ── GET /api/rider/check ────────────────────────────────────────────────────

describe('GET /api/rider/check', () => {
	it('rejects a missing address', async () => {
		const res = await callGet(checkHandler, '/api/rider/check', {});
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('validation_error');
	});

	it('rejects a repeated address param instead of throwing on it', async () => {
		// `?address=a&address=b` arrives as an array; calling .trim() on it used to
		// throw a TypeError and answer 500.
		const res = await callGet(checkHandler, '/api/rider/check', { address: ['nope', 'also-nope'] });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('validation_error');
	});

	it('rejects a non-base58 address', async () => {
		const res = await callGet(checkHandler, '/api/rider/check', { address: 'not-a-solana-address' });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error_description).toMatch(/invalid Solana address/);
	});

	it('grants a holder pass from the on-chain balance', async () => {
		rpcState.accounts = [tokenAccount(1234.5)];
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ has_pass: true, holder_pass: true, paid_pass: false, balance: 1234.5, required_amount: REQUIRED_AMOUNT });
	});

	it('grants a paid pass to a wallet that spent its $THREE on the vault', async () => {
		rpcState.accounts = [];
		dbState.rows = [{ wallet_address: WALLET_A, amount_paid: '8000', tx_signature: 'sig1', created_at: new Date() }];
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ has_pass: true, holder_pass: false, paid_pass: true, balance: 0, amount_paid: 8000, tx_signature: 'sig1' });
	});

	it('reports no pass when neither source grants one', async () => {
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ has_pass: false, holder_pass: false, paid_pass: false });
	});

	it('answers 502 rather than a false negative when the RPC read fails', async () => {
		rpcState.fail = new Error('failed to fetch https://mainnet.helius-rpc.com/?api-key=secret');
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(502);
		expect(res.payload.error).toBe('rpc_unavailable');
		// The RPC URL carries the Helius key; it must never reach the caller.
		expect(JSON.stringify(res.payload)).not.toMatch(/api-key/);
	});

	it('still answers 200 on an RPC failure when a recorded payment already proves the pass', async () => {
		rpcState.fail = new Error('rpc down');
		dbState.rows = [{ wallet_address: WALLET_A, amount_paid: '8000', tx_signature: 'sig1', created_at: new Date() }];
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ has_pass: true, paid_pass: true, balance: null });
	});

	it('still answers 200 on a database failure when the balance already proves the pass', async () => {
		dbState.fail = new Error('db down');
		rpcState.accounts = [tokenAccount(10)];
		const res = await callGet(checkHandler, '/api/rider/check', { address: WALLET_A });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ has_pass: true, holder_pass: true, paid_pass: false });
	});
});

// ── GET /api/rider/info ─────────────────────────────────────────────────────

describe('GET /api/rider/info', () => {
	it('advertises the same amount the webhook accepts, and closes payments with no vault', async () => {
		const res = await callGet(infoHandler, '/api/rider/info');
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ token_mint: MINT, token_symbol: '$THREE', required_amount: REQUIRED_AMOUNT, vault_address: null, accepting_payments: false });
	});

	it('opens payments once the vault is configured', async () => {
		process.env.RIDER_VAULT_ADDRESS = VAULT;
		const res = await callGet(infoHandler, '/api/rider/info');
		expect(res.payload).toMatchObject({ vault_address: VAULT, accepting_payments: true });
	});
});

// ── GET /api/rider/firebase ─────────────────────────────────────────────────

describe('GET /api/rider/firebase', () => {
	it('fails closed with 503 instead of serving an all-null config', async () => {
		const res = await callGet(firebaseHandler, '/api/rider/firebase');
		expect(res.statusCode).toBe(503);
		expect(res.payload.error).toBe('not_configured');
	});

	it('serves the configured client config', async () => {
		process.env.RIDER_FIREBASE_API_KEY = 'test-api-key';
		process.env.RIDER_FIREBASE_PROJECT_ID = 'rider-test';
		process.env.RIDER_FIREBASE_AUTH_DOMAIN = 'rider-test.firebaseapp.com';
		const res = await callGet(firebaseHandler, '/api/rider/firebase');
		expect(res.statusCode).toBe(200);
		expect(res.payload).toMatchObject({ apiKey: 'test-api-key', projectId: 'rider-test', authDomain: 'rider-test.firebaseapp.com', storageBucket: null });
	});
});

// ── POST /api/rider/webhook ─────────────────────────────────────────────────

describe('POST /api/rider/webhook', () => {
	const payment = (wallet, amount, signature) => ({
		signature,
		tokenTransfers: [{ mint: MINT, toUserAccount: VAULT, fromUserAccount: wallet, tokenAmount: amount }],
	});

	it('fails closed with 503 when the shared secret is unset', async () => {
		const res = await postWebhook([payment(WALLET_A, 8000, 'sig1')], { authorization: 'Bearer anything' });
		expect(res.statusCode).toBe(503);
		expect(dbState.writes).toEqual([]);
	});

	it('rejects a wrong or missing secret', async () => {
		process.env.RIDER_HELIUS_WEBHOOK_SECRET = 'right';
		process.env.RIDER_VAULT_ADDRESS = VAULT;
		expect((await postWebhook([], { authorization: 'Bearer wrong' })).statusCode).toBe(401);
		expect((await postWebhook([])).statusCode).toBe(401);
		expect(dbState.writes).toEqual([]);
	});

	it('reports 503 rather than a phantom success when the vault is unset', async () => {
		process.env.RIDER_HELIUS_WEBHOOK_SECRET = 'right';
		const res = await postWebhook([payment(WALLET_A, 8000, 'sig1')], { authorization: 'Bearer right' });
		expect(res.statusCode).toBe(503);
		expect(res.payload.error).toBe('not_configured');
	});

	it('rejects a body that is not an array', async () => {
		process.env.RIDER_HELIUS_WEBHOOK_SECRET = 'right';
		process.env.RIDER_VAULT_ADDRESS = VAULT;
		const res = await postWebhook({ not: 'an array' }, { authorization: 'Bearer right' });
		expect(res.statusCode).toBe(400);
		expect(res.payload.error).toBe('validation_error');
	});

	it('grants a pass per paying wallet, including two payers in one transaction', async () => {
		process.env.RIDER_HELIUS_WEBHOOK_SECRET = 'right';
		process.env.RIDER_VAULT_ADDRESS = VAULT;
		const res = await postWebhook(
			[{
				signature: 'batch',
				tokenTransfers: [
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_A, tokenAmount: 8000 },
					{ mint: MINT, toUserAccount: VAULT, fromUserAccount: WALLET_B, tokenAmount: 12000 },
				],
			}],
			{ authorization: 'Bearer right' },
		);
		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual({ ok: true, granted: 2 });
		expect(dbState.writes.map((w) => w.wallet).sort()).toEqual([WALLET_A, WALLET_B].sort());
	});

	it('writes nothing for a payload with no qualifying transfer', async () => {
		process.env.RIDER_HELIUS_WEBHOOK_SECRET = 'right';
		process.env.RIDER_VAULT_ADDRESS = VAULT;
		const res = await postWebhook([payment(WALLET_A, 10, 'sig1')], { authorization: 'Bearer right' });
		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual({ ok: true, granted: 0 });
		expect(dbState.writes).toEqual([]);
	});
});
