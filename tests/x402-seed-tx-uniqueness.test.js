// Every transaction in a seed batch must be DISTINCT on the wire.
//
// Regression guard for a live production failure (measured 2026-07-30): the
// seeder built its batch by calling the payment builder N times with identical
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
// The seeder now delegates to the ONE shared ring builder,
// api/_lib/x402/pay.js buildPaymentTx, and passes the batch position as `nonce`.
// ringFeeConfig maps each nonce to a distinct (priority price, CU limit) pair;
// both are free to vary without changing what the payment DOES: unused compute
// is never billed, and in sponsor mode the priority fee floors to zero lamports.
// This test pins the batch-uniqueness contract against that shared builder:
// same inputs, different nonce, different bytes, and the transfer untouched.

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

let buildPaymentTx;
let ringFeeConfig;
let expectedFeeLamports;
let ringMaxFeePerTxLamports;
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
	({ buildPaymentTx, ringFeeConfig, expectedFeeLamports, ringMaxFeePerTxLamports } = await import('../api/_lib/x402/pay.js'));
	({ VersionedTransaction } = await import('@solana/web3.js'));
});

describe('seed batch transactions are unique per nonce', () => {
	it('produces different bytes for every nonce in a batch', () => {
		const batch = Array.from({ length: 60 }, (_, nonce) => buildPaymentTx({ ...args, nonce }));
		// The regression: this set had size 1.
		expect(new Set(batch).size).toBe(60);
	});

	it("produces a different buyer signature, so the chain sees distinct transactions", () => {
		// signatures[0] belongs to the fee payer, which the seeder does NOT sign
		// (the sponsor cosigns at settle), so slot 0 is all zeros on every build.
		// The buyer's slot is the one that must vary.
		const buyerSig = (nonce) => {
			const tx = VersionedTransaction.deserialize(
				Buffer.from(buildPaymentTx({ ...args, nonce }), 'base64'),
			);
			const slot = tx.message.staticAccountKeys
				.slice(0, tx.message.header.numRequiredSignatures)
				.findIndex((k) => k.equals(buyer.publicKey));
			expect(slot).toBeGreaterThan(-1);
			const sig = Buffer.from(tx.signatures[slot]);
			expect(sig.some((b) => b !== 0)).toBe(true); // actually signed
			return sig.toString('base64');
		};

		const sigs = Array.from({ length: 10 }, (_, nonce) => buyerSig(nonce));
		expect(new Set(sigs).size).toBe(10);
	});

	it('is deterministic for a given nonce, so a retry rebuilds the same tx', () => {
		expect(buildPaymentTx({ ...args, nonce: 7 })).toBe(buildPaymentTx({ ...args, nonce: 7 }));
	});

	it('defaults to nonce 0 so a single-payment caller is unchanged', () => {
		expect(buildPaymentTx(args)).toBe(buildPaymentTx({ ...args, nonce: 0 }));
	});

	it('varies only the compute-budget instructions, never the payment itself', () => {
		const decode = (nonce) =>
			VersionedTransaction.deserialize(
				Buffer.from(buildPaymentTx({ ...args, nonce }), 'base64'),
			).message;

		const a = decode(0);
		const b = decode(41);

		// Same accounts, same programs, same instruction shape: only the two
		// compute-budget instructions (limit, price) may differ, so the transfer
		// is byte-identical.
		expect(b.staticAccountKeys.map(String)).toEqual(a.staticAccountKeys.map(String));
		expect(b.compiledInstructions).toHaveLength(a.compiledInstructions.length);

		const differing = a.compiledInstructions
			.map((ix, i) => ({
				i,
				same: Buffer.from(ix.data).equals(Buffer.from(b.compiledInstructions[i].data)),
			}))
			.filter((x) => !x.same)
			.map((x) => x.i);
		// Instructions 0 and 1 are setComputeUnitLimit and setComputeUnitPrice;
		// the nonce spread may touch either or both, nothing else.
		expect(differing.length).toBeGreaterThan(0);
		expect(differing.every((i) => i === 0 || i === 1)).toBe(true);

		// The transfer instruction (last) is untouched: same program, same data.
		const last = a.compiledInstructions.length - 1;
		expect(Buffer.from(b.compiledInstructions[last].data)).toEqual(
			Buffer.from(a.compiledInstructions[last].data),
		);
		expect(String(b.staticAccountKeys[b.compiledInstructions[last].programIdIndex])).toBe(
			String(a.staticAccountKeys[a.compiledInstructions[last].programIdIndex]),
		);
	});

	it('keeps the fee spread under the ring per-transaction ceiling', () => {
		// Sponsor-mode ringFeeConfig keeps the priority fee at zero lamports by
		// construction (price slots are capped so price x limit floors to 0), so
		// the worst case is the 2-signature base fee, exactly at the ceiling.
		for (const nonce of [0, 1, 10, 41, 59, 119]) {
			const { microLamports, cuLimit } = ringFeeConfig(nonce, { selfPay: false });
			const fee = expectedFeeLamports({ selfPay: false, priorityMicrolamports: microLamports, cuLimit });
			expect(fee).toBeLessThanOrEqual(ringMaxFeePerTxLamports());
		}
	});

	it('uses a real payTo account, not the fee payer', () => {
		expect(ACCEPT.payTo).not.toBe(ACCEPT.extra.feePayer);
		expect(() => new PublicKey(ACCEPT.payTo)).not.toThrow();
	});
});
