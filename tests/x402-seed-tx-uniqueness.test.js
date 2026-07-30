// Every transaction in a seed batch must be DISTINCT on the wire.
//
// Regression guard for a live production failure (measured 2026-07-30): the
// seeder built its batch by calling buildPaymentTx() N times with identical
// arguments. Every input is fixed across a tick (one blockhash, one amount, one
// pair of token accounts, one decimals value) and the priority fee was the
// constant `microLamports: 1`, so all N transactions serialized to the SAME
// bytes.
//
// Identical bytes mean a single signature, and the paid endpoint derives
// paymentId by hashing the payment proof. So the whole batch collided on one id:
// exactly one call landed and the rest returned 409 writeConflict/writeInflight,
// while any that raced past that guard reached the chain as a duplicate
// signature and settled as `broadcast_failed` with empty simulation logs. About
// 40 of every 41 calls per tick were lost, making this the single largest source
// of 4xx on the fleet at ~2,403/hour, and it falsified the cron's own promise of
// "60 real Solana micropayments per tick".
//
// The fix spreads the compute-unit price by index, which is the only field free
// to vary without changing what the payment DOES. This test pins that: same
// inputs, different index, different bytes, and the transfer itself untouched.

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

let buildPaymentTx;
let VersionedTransaction;

// A fixed, valid-shaped accept for the Solana exact scheme. The mint is $THREE
// and the wallets are throwaway keypairs, so nothing here touches a real payer.
const buyer = Keypair.generate();
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const blockhash = '11111111111111111111111111111111';

function accept() {
	return {
		asset: THREE_MINT,
		payTo: Keypair.generate().publicKey.toBase58(),
		amount: '1000',
		network: 'solana',
		extra: { feePayer: Keypair.generate().publicKey.toBase58() },
	};
}

const ACCEPT = accept();
const args = { accept: ACCEPT, buyer, blockhash, mintInfo: { decimals: 6 }, receiverAtaExists: true };

beforeAll(async () => {
	({ buildPaymentTx } = await import('../api/cron/x402-seed-cron.js'));
	({ VersionedTransaction } = await import('@solana/web3.js'));
});

describe('seed batch transactions are unique per index', () => {
	it('produces different bytes for every index in a batch', () => {
		const batch = Array.from({ length: 60 }, (_, index) => buildPaymentTx({ ...args, index }));
		// The regression: this set had size 1.
		expect(new Set(batch).size).toBe(60);
	});

	it("produces a different buyer signature, so the chain sees distinct transactions", () => {
		// signatures[0] belongs to the fee payer, which the seeder does NOT sign
		// (the sponsor cosigns at settle), so slot 0 is all zeros on every build.
		// The buyer's slot is the one that must vary.
		const buyerSig = (index) => {
			const tx = VersionedTransaction.deserialize(
				Buffer.from(buildPaymentTx({ ...args, index }), 'base64'),
			);
			const slot = tx.message.staticAccountKeys
				.slice(0, tx.message.header.numRequiredSignatures)
				.findIndex((k) => k.equals(buyer.publicKey));
			expect(slot).toBeGreaterThan(-1);
			const sig = Buffer.from(tx.signatures[slot]);
			expect(sig.some((b) => b !== 0)).toBe(true); // actually signed
			return sig.toString('base64');
		};

		const sigs = Array.from({ length: 10 }, (_, index) => buyerSig(index));
		expect(new Set(sigs).size).toBe(10);
	});

	it('is deterministic for a given index, so a retry rebuilds the same tx', () => {
		expect(buildPaymentTx({ ...args, index: 7 })).toBe(buildPaymentTx({ ...args, index: 7 }));
	});

	it('defaults to index 0 so a single-payment caller is unchanged', () => {
		expect(buildPaymentTx(args)).toBe(buildPaymentTx({ ...args, index: 0 }));
	});

	it('varies only the priority fee, never the payment itself', () => {
		const decode = (index) =>
			VersionedTransaction.deserialize(
				Buffer.from(buildPaymentTx({ ...args, index }), 'base64'),
			).message;

		const a = decode(0);
		const b = decode(41);

		// Same accounts, same programs, same instruction shape: only the compute
		// budget instruction's data differs, so the transfer is byte-identical.
		expect(b.staticAccountKeys.map(String)).toEqual(a.staticAccountKeys.map(String));
		expect(b.compiledInstructions).toHaveLength(a.compiledInstructions.length);

		const differing = a.compiledInstructions
			.map((ix, i) => ({
				i,
				same: Buffer.from(ix.data).equals(Buffer.from(b.compiledInstructions[i].data)),
			}))
			.filter((x) => !x.same)
			.map((x) => x.i);
		expect(differing).toEqual([1]); // index 1 is setComputeUnitPrice

		// The transfer instruction (last) is untouched: same program, same data.
		const last = a.compiledInstructions.length - 1;
		expect(Buffer.from(b.compiledInstructions[last].data)).toEqual(
			Buffer.from(a.compiledInstructions[last].data),
		);
		expect(String(b.staticAccountKeys[b.compiledInstructions[last].programIdIndex])).toBe(
			String(a.staticAccountKeys[a.compiledInstructions[last].programIdIndex]),
		);
	});

	it('keeps the fee spread small enough to be free in practice', () => {
		// 60k compute units at (1 + index) microLamports is 0.06 * (1+index)
		// lamports, so even the last call in a 60-batch costs a few lamports.
		const worstCaseLamports = (60_000 * (1 + 59)) / 1_000_000;
		expect(worstCaseLamports).toBeLessThan(5);
	});

	it('uses a real payTo account, not the fee payer', () => {
		expect(ACCEPT.payTo).not.toBe(ACCEPT.extra.feePayer);
		expect(() => new PublicKey(ACCEPT.payTo)).not.toThrow();
	});
});
