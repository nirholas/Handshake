import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

// The autonomous payer used to sign every payment in a tick against ONE
// blockhash fetched at tick start. A long tick ages that hash past the ~60-90s
// broadcast window and the facilitator (which cannot re-sign: the buyer
// signature covers the message, blockhash included) dies with
// broadcast_failed cause:BlockhashNotFound. payX402 now reads the signing
// blockhash through a TTL cache and force-refreshes it on the post-402 retry.
// These tests decode the actually-signed transaction out of the X-PAYMENT
// envelope and assert which blockhash it carries. Nothing is broadcast.

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { payX402 } = await import('../api/_lib/x402/pay.js');

const payTo = Keypair.generate().publicKey.toBase58();

function accept(amount) {
	return {
		scheme: 'exact',
		network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
		asset: USDC,
		payTo,
		amount: String(amount),
		extra: { name: 'USDC', decimals: 6 },
	};
}

// Valid 32-byte base58 strings: any pubkey qualifies as a blockhash shape.
const STALE_TICK_HASH = Keypair.generate().publicKey.toBase58();
const freshHashes = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

let paidReplays402 = 0;
// recentBlockhash of every signed transaction the server received, in order.
let signedWith = [];

let server;
let origin;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const paymentHeader = req.headers['x-payment'];
		if (!paymentHeader) {
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ x402Version: 2, accepts: [accept(1000)] }));
			return;
		}
		const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
		const vtx = VersionedTransaction.deserialize(Buffer.from(decoded.payload.transaction, 'base64'));
		signedWith.push(vtx.message.recentBlockhash);
		if (paidReplays402 > 0) {
			paidReplays402--;
			res.statusCode = 402;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ x402Version: 2, accepts: [accept(1000)], error: 'requirements_changed' }));
			return;
		}
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	paidReplays402 = 0;
	signedWith = [];
});

const buyer = Keypair.generate();

function ctx({ hashes }) {
	let i = 0;
	return {
		buyer,
		conn: {
			getAccountInfo: async () => ({ lamports: 1 }),
			getLatestBlockhash: async () => ({ blockhash: hashes[Math.min(i++, hashes.length - 1)] }),
		},
		blockhash: STALE_TICK_HASH,
		mintInfo: { decimals: 6 },
		selfPay: true,
	};
}

describe('payX402 blockhash freshness', () => {
	it('signs with an RPC-fresh blockhash, not the caller-supplied tick hash, once the cache is stale', async () => {
		const r = await payX402({ url: `${origin}/ok`, method: 'GET', ...ctx({ hashes: freshHashes }), remainingCap: 100_000 });
		expect(r.paid).toBe(true);
		expect(signedWith).toHaveLength(1);
		// The tick-wide hash is only the fetch-failure fallback; a reachable RPC
		// always wins. (The shared cache may still hold a young hash seeded by a
		// sibling test in this process, so assert against the stale hash, not for
		// one specific fresh value.)
		expect(signedWith[0]).not.toBe(STALE_TICK_HASH);
	});

	it('force-refreshes the blockhash on the post-402 retry instead of re-signing the refused one', async () => {
		paidReplays402 = 1;
		const ownHashes = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
		const r = await payX402({ url: `${origin}/requote`, method: 'GET', ...ctx({ hashes: ownHashes }), remainingCap: 100_000 });
		expect(r.paid).toBe(true);
		expect(r.retriedAfter402).toBe(true);
		expect(signedWith).toHaveLength(2);
		// The retry MUST have hit the RPC again: forceFresh bypasses the TTL cache
		// (whatever a sibling test left in it), so the second signed tx wears a
		// hash from THIS test's mock RPC, distinct from the refused attempt's.
		expect(ownHashes).toContain(signedWith[1]);
		expect(signedWith[1]).not.toBe(signedWith[0]);
		expect(signedWith[1]).not.toBe(STALE_TICK_HASH);
	});

	it('still pays when the RPC blockhash fetch fails (cached or caller-supplied fallback)', async () => {
		const failingCtx = {
			buyer,
			conn: {
				getAccountInfo: async () => ({ lamports: 1 }),
				getLatestBlockhash: async () => { throw new Error('rpc down'); },
			},
			blockhash: STALE_TICK_HASH,
			mintInfo: { decimals: 6 },
			selfPay: true,
		};
		const r = await payX402({ url: `${origin}/ok`, method: 'GET', ...failingCtx, remainingCap: 100_000 });
		expect(r.paid).toBe(true);
		expect(signedWith).toHaveLength(1);
		// A stale attempt beats no attempt; the facilitator side still has its
		// preflight-off resend for provably-unlanded blockhash misses.
	});
});
