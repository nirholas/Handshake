// The autonomous loop must never attempt a payment the payer's USDC float
// cannot fund.
//
// Regression guard for a live production failure: the ring payer's USDC balance
// hit $0 while the daily spend cap still had headroom, so every tick probed,
// signed, and POSTed a payment for each ready entry — and the facilitator failed
// every one at settle with `broadcast_failed:Simulation failed`. 1,262 failures
// in 24h, roughly one per minute, indefinitely. The daily cap bounds what we're
// *allowed* to spend; only the token balance bounds what we're *able* to.
//
// readPayerUsdcAtomic() is the preflight read that closes the gap. Its contract:
//   • a real balance            → that balance, in atomic units (6dp)
//   • a wallet with no ATA      → 0 (never held USDC ⇒ holds no USDC)
//   • an undeterminable balance → null ("unknown", callers must NOT gate on it)
//
// The null-vs-zero distinction is the load-bearing part: a transient RPC blip
// must not read as "empty wallet" and silently halt the whole ring.
//
// The Connection is a stub — these assert the branch logic, not Solana.

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';

let readPayerUsdcAtomic;
let PAYER;

beforeAll(async () => {
	// The module reads USDC_MINT from env at import time.
	process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	process.env.CRON_SECRET = 'test-secret';
	PAYER = Keypair.generate().publicKey;
	({ readPayerUsdcAtomic } = await import('../api/cron/x402-autonomous-loop.js'));
});

/** Stub Connection. `account` = what getAccountInfo yields; `balance` = getTokenAccountBalance. */
function stubConn({ account = {}, balance, accountThrows, balanceThrows } = {}) {
	return {
		async getAccountInfo() {
			if (accountThrows) throw accountThrows;
			return account;
		},
		async getTokenAccountBalance() {
			if (balanceThrows) throw balanceThrows;
			return balance;
		},
	};
}

describe('readPayerUsdcAtomic — the spend-path preflight', () => {
	it('returns the balance in atomic units when the payer holds USDC', async () => {
		const conn = stubConn({ balance: { value: { amount: '12500000', decimals: 6 } } });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBe(12_500_000);
	});

	it('returns 0 for a funded-but-drained ATA (the exact production condition)', async () => {
		const conn = stubConn({ balance: { value: { amount: '0', decimals: 6 } } });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBe(0);
	});

	it('returns 0 when the wallet has no token account at all', async () => {
		// getAccountInfo yields null for a missing account — it does not throw.
		// Detecting the no-ATA case structurally (rather than by pattern-matching
		// getTokenAccountBalance's error string, whose wording differs per RPC
		// provider) is what makes this branch reliable.
		const conn = stubConn({ account: null });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBe(0);
	});

	it('returns null (unknown, do not gate) when the RPC read fails', async () => {
		const conn = stubConn({ accountThrows: new Error('503 Service Unavailable') });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBeNull();
	});

	it('returns null when the balance call fails after the account resolves', async () => {
		const conn = stubConn({ balanceThrows: new Error('rpc timeout') });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBeNull();
	});

	it('returns null on an unparseable amount rather than treating it as empty', async () => {
		const conn = stubConn({ balance: { value: { amount: 'not-a-number' } } });
		await expect(readPayerUsdcAtomic(conn, PAYER)).resolves.toBeNull();
	});

	it('never confuses "unknown" with "empty"', async () => {
		// The whole point: 0 halts the spend path, null leaves it open. If a
		// transient failure ever returned 0, one RPC blip would silently stop the
		// ring; if a genuinely empty wallet ever returned null, the doomed-payment
		// storm this guard exists to prevent would come straight back.
		const empty = await readPayerUsdcAtomic(stubConn({ account: null }), PAYER);
		const unknown = await readPayerUsdcAtomic(stubConn({ accountThrows: new Error('boom') }), PAYER);
		expect(empty).toBe(0);
		expect(unknown).toBeNull();
		expect(empty).not.toBe(unknown);
	});
});
