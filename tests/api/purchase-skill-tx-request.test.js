// Tests for /api/purchase/skill — the Solana Pay TRANSACTION request that a
// mobile wallet hits after scanning a skill-purchase QR.
//
// Runs fully offline: real @solana/web3.js + @solana/spl-token, a fake RPC that
// returns a fixed blockhash, and an in-memory skill_purchases row. The two things
// that matter here are (a) the endpoint never invents a purchase — it only serves
// a pending row an authenticated checkout already created — and (b) the built
// transaction has the exact shape api/_lib/purchase-confirm.js validates: the
// reference-carrying creator leg LAST.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const PAYER = Keypair.generate();
const BUYER = Keypair.generate();
const SELLER = Keypair.generate();
const TREASURY = Keypair.generate();
const MINT = Keypair.generate();
const REFERENCE = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// One pending purchase row, mutated per test.
let purchaseRow = null;
const sqlMock = vi.fn(async (strings) => {
	const text = strings.join('?').toLowerCase();
	if (text.includes('from skill_purchases')) return purchaseRow ? [purchaseRow] : [];
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let payoutAddress = SELLER.publicKey.toBase58();
const logEventMock = vi.fn(async () => {});
vi.mock('../../api/_lib/purchase-confirm.js', () => ({
	logEvent: (...a) => logEventMock(...a),
	resolvePayoutAddress: async () => payoutAddress,
}));

vi.mock('../../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({
		getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
	}),
}));

let payerConfigured = true;
vi.mock('../../api/_lib/solana/gasless-tx.js', () => ({
	resolveMarketplacePayer: async () => (payerConfigured ? PAYER : null),
}));

const rateLimitResult = { success: true, limit: 240, remaining: 239, reset: Date.now() + 60_000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: { publicIp: async () => rateLimitResult },
}));

function basePurchase(overrides = {}) {
	return {
		reference: REFERENCE,
		status: 'pending',
		expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
		agent_id: '11111111-1111-4111-8111-111111111111',
		skill: 'market-scan',
		kind: 'purchase',
		amount: '1000000',
		currency_mint: MINT.publicKey.toBase58(),
		chain: 'solana',
		platform_fee_amount: '0',
		platform_fee_wallet: null,
		mint_decimals: 6,
		agent_name: 'Scout',
		...overrides,
	};
}

function makeReq({ method = 'GET', query = `?reference=${REFERENCE}`, body = null } = {}) {
	const buf = Buffer.from(body == null ? '' : JSON.stringify(body), 'utf8');
	const stream = Readable.from([buf]);
	stream.method = method;
	stream.url = `/api/purchase/skill${query}`;
	stream.headers = {
		'content-type': 'application/json',
		'content-length': String(buf.length),
	};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function call(opts) {
	const handler = (await import('../../api/purchase/skill.js')).default;
	const res = makeRes();
	await handler(makeReq(opts), res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

beforeEach(() => {
	purchaseRow = basePurchase();
	payoutAddress = SELLER.publicKey.toBase58();
	payerConfigured = true;
	sqlMock.mockClear();
	logEventMock.mockClear();
});

describe('GET /api/purchase/skill', () => {
	it('returns the Solana Pay label and icon for a known reference', async () => {
		const { res, body } = await call({ method: 'GET' });
		expect(res.statusCode).toBe(200);
		expect(body.label).toContain('market-scan');
		expect(body.icon).toMatch(/^https?:\/\/.+\.svg$/);
	});

	it('rejects a malformed reference with a JSON 400', async () => {
		const { res, body } = await call({ method: 'GET', query: '?reference=not-base58!' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.message).toBeTruthy();
	});

	it('404s a reference with no purchase behind it', async () => {
		purchaseRow = null;
		const { res, body } = await call({ method: 'GET' });
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('POST /api/purchase/skill', () => {
	it('builds a platform-sponsored transfer whose last leg carries the reference', async () => {
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(200);
		expect(body.message).toContain('market-scan');

		const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
		expect(tx.feePayer.equals(PAYER.publicKey)).toBe(true);
		// Platform pre-signed as fee payer; the buyer's authority slot is still open.
		expect(tx.signatures.find((s) => s.publicKey.equals(PAYER.publicKey))?.signature).not.toBeNull();
		expect(tx.signatures.find((s) => s.publicKey.equals(BUYER.publicKey))?.signature ?? null).toBeNull();

		const last = tx.instructions[tx.instructions.length - 1];
		expect(last.keys[last.keys.length - 1].pubkey.equals(new PublicKey(REFERENCE))).toBe(true);
		const sellerAta = getAssociatedTokenAddressSync(MINT.publicKey, SELLER.publicKey);
		expect(last.keys.some((k) => k.pubkey.equals(sellerAta))).toBe(true);
		// Idempotent ATA creation for the seller rides ahead of the transfer.
		expect(tx.instructions).toHaveLength(2);
		expect(logEventMock).toHaveBeenCalledWith(REFERENCE, 'transaction_request_built', expect.any(Object));
	});

	it('puts the treasury fee leg before the reference-carrying creator leg', async () => {
		purchaseRow = basePurchase({
			platform_fee_amount: '100000',
			platform_fee_wallet: TREASURY.publicKey.toBase58(),
		});
		const { body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
		const treasuryAta = getAssociatedTokenAddressSync(MINT.publicKey, TREASURY.publicKey);
		const feeIdx = tx.instructions.findIndex(
			(ix) => ix.keys.length === 4 && ix.keys.some((k) => k.pubkey.equals(treasuryAta)),
		);
		expect(feeIdx).toBeGreaterThan(-1);
		expect(feeIdx).toBeLessThan(tx.instructions.length - 1);

		const last = tx.instructions[tx.instructions.length - 1];
		expect(last.keys[last.keys.length - 1].pubkey.equals(new PublicKey(REFERENCE))).toBe(true);
	});

	it('makes the buyer the fee payer when no marketplace payer is configured', async () => {
		payerConfigured = false;
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(200);
		const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
		expect(tx.feePayer.equals(BUYER.publicKey)).toBe(true);
	});

	it('rejects a body with no wallet account', async () => {
		const { res, body } = await call({ method: 'POST', body: {} });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects an account that is not a base58 public key', async () => {
		const { res, body } = await call({ method: 'POST', body: { account: 'definitely not a key' } });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('410s an expired pending purchase', async () => {
		purchaseRow = basePurchase({ expires_at: new Date(Date.now() - 60_000).toISOString() });
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(410);
		expect(body.error).toBe('purchase_expired');
	});

	it('409s a purchase that is already paid', async () => {
		purchaseRow = basePurchase({ status: 'confirmed' });
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(409);
		expect(body.error).toBe('already_confirmed');
	});

	it('rejects a non-Solana purchase', async () => {
		purchaseRow = basePurchase({ chain: 'base' });
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_chain');
	});

	it('412s when the agent owner has no payout wallet', async () => {
		payoutAddress = null;
		const { res, body } = await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		expect(res.statusCode).toBe(412);
		expect(body.error).toBe('creator_wallet_missing');
	});

	it('never writes a purchase row of its own', async () => {
		await call({ method: 'POST', body: { account: BUYER.publicKey.toBase58() } });
		for (const callArgs of sqlMock.mock.calls) {
			expect(callArgs[0].join(' ').toLowerCase()).not.toContain('insert into skill_purchases');
		}
	});
});
