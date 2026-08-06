import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// A 402 on the PAID replay (not the probe) means the endpoint refused the proof
// we just built: the quote moved between probe and replay, or the requirements
// were re-issued. payX402 used to report that as terminal `http_402` and drop the
// call, which is what the autonomous log recorded across skill-marketplace,
// club-cover and billboard. The signed transfer is never broadcast when verify
// refuses, so no money moved and one retry against a FRESHLY fetched challenge
// is safe.
//
// These tests drive the real payX402 against a local 402 server: the Solana
// transfer is genuinely built and signed (valid base58 keys below), but the mock
// never touches a chain, so nothing is broadcast and nothing is spent.

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { payX402 } = await import('../api/_lib/x402/pay.js');

const payTo = Keypair.generate().publicKey.toBase58();
const feePayer = Keypair.generate().publicKey.toBase58();

function accept(amount) {
	return {
		scheme: 'exact',
		network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
		asset: USDC,
		payTo,
		amount: String(amount),
		extra: { name: 'USDC', decimals: 6, feePayer },
	};
}

// Per-test script: how many PAID replays answer 402 before the endpoint accepts.
let paidReplays402 = 0;
// Quote handed out by the challenge. Bumped by the server to model a re-price.
let quote = 1000;
// Observed traffic, so a test can assert how many probes and paid attempts ran.
let probes = 0;
let paidAttempts = 0;

let server;
let origin;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const paymentHeader = req.headers['x-payment'];
		if (!paymentHeader) {
			probes++;
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ x402Version: 2, accepts: [accept(quote)] }));
			return;
		}
		paidAttempts++;
		if (paidReplays402 > 0) {
			paidReplays402--;
			// Re-price on refusal so the retry has to read the FRESH challenge to
			// pay the right amount. A retry that replayed the cached requirements
			// would keep paying the stale quote and 402 forever.
			quote += 500;
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ x402Version: 2, accepts: [accept(quote)], error: 'requirements_changed' }));
			return;
		}
		const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json');
		res.setHeader(
			'x-payment-response',
			Buffer.from(JSON.stringify({ success: true, transaction: `SIG_${decoded.accepted.amount}` })).toString('base64'),
		);
		res.end(JSON.stringify({ ok: true, paidAmount: decoded.accepted.amount }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	paidReplays402 = 0;
	quote = 1000;
	probes = 0;
	paidAttempts = 0;
});

// A buyer keypair is enough: buildPaymentTx only needs a signer, a blockhash and
// the mint decimals, and self-pay skips the sponsor co-sign entirely.
const buyer = Keypair.generate();
const payCtx = {
	buyer,
	conn: { getAccountInfo: async () => ({ lamports: 1 }) },
	blockhash: '11111111111111111111111111111111',
	mintInfo: { decimals: 6 },
	selfPay: true,
};

describe('payX402 402-on-replay handling', () => {
	it('leaves a call that settles on the first replay untouched', async () => {
		const r = await payX402({ url: `${origin}/ok`, method: 'GET', ...payCtx, remainingCap: 100_000 });
		expect(r.paid).toBe(true);
		expect(r.status).toBe(200);
		expect(r.amountAtomic).toBe(1000);
		expect(r.retriedAfter402).toBe(false);
		// Exactly one probe and one paid attempt: no extra traffic for working routes.
		expect(probes).toBe(1);
		expect(paidAttempts).toBe(1);
	});

	it('re-fetches the challenge and settles the re-quoted amount after one 402', async () => {
		paidReplays402 = 1;
		const r = await payX402({ url: `${origin}/requote`, method: 'GET', ...payCtx, remainingCap: 100_000 });
		expect(r.paid).toBe(true);
		expect(r.status).toBe(200);
		expect(r.retriedAfter402).toBe(true);
		// The retry paid the NEW quote, which is only possible by re-reading the
		// challenge rather than replaying the stale requirements.
		expect(r.amountAtomic).toBe(1500);
		expect(r.responseBody.paidAmount).toBe('1500');
		expect(probes).toBe(2);
		expect(paidAttempts).toBe(2);
	});

	it('gives up after exactly one retry when the endpoint 402s again', async () => {
		paidReplays402 = 5;
		const r = await payX402({ url: `${origin}/always402`, method: 'GET', ...payCtx, remainingCap: 100_000 });
		expect(r.paid).toBe(false);
		expect(r.status).toBe(402);
		expect(r.errorMsg).toBe('http_402');
		expect(r.retriedAfter402).toBe(true);
		// Bounded: two paid attempts total, never a retry storm.
		expect(paidAttempts).toBe(2);
	});

	it('re-applies the spend cap to the re-quoted amount instead of overpaying', async () => {
		paidReplays402 = 1;
		// The first quote (1000) fits the cap; the re-quote (1500) does not.
		const r = await payX402({ url: `${origin}/requote`, method: 'GET', ...payCtx, remainingCap: 1200 });
		expect(r.paid).toBe(false);
		expect(r.skipped).toBe(true);
		expect(r.errorMsg).toBe('cap_would_exceed');
		expect(r.amountAtomic).toBe(1500);
		// The over-cap re-quote was refused before a second payment was sent.
		expect(paidAttempts).toBe(1);
	});

	it('re-runs the recipient gate against the re-fetched accept', async () => {
		paidReplays402 = 1;
		const seen = [];
		const r = await payX402({
			url: `${origin}/requote`, method: 'GET', ...payCtx, remainingCap: 100_000,
			onAccept: (a) => {
				seen.push(Number(a.amount));
				// Refuse the re-quoted challenge: an allowlist must judge the accept
				// actually being paid, not only the first one.
				return seen.length > 1 ? { abort: true, reason: 'requote_refused' } : null;
			},
		});
		expect(seen).toEqual([1000, 1500]);
		expect(r.paid).toBe(false);
		expect(r.refusedByHook).toBe(true);
		expect(r.errorMsg).toBe('requote_refused');
		expect(paidAttempts).toBe(1);
	});
});
