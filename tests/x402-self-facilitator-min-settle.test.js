// Tests for the anti fee-burn minimum-settle guard in settleRingPayment
// (api/_lib/x402/self-facilitator.js).
//
// The self-hosted facilitator co-signs sponsor-mode settles, burning ~5000
// lamports of OUR SOL per broadcast. A dust transfer (e.g. 1 atomic) to an
// allowlisted payTo is otherwise a valid settle, so spamming them pumps the
// sponsor down toward its SOL floor and halts the paid economy. The guard
// rejects sponsor-mode settles below MIN_SPONSOR_SETTLE_ATOMIC before co-sign,
// while exempting self-pay settles (which pay their own fee and cost us nothing).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	Keypair,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
} from '@solana/spl-token';

const { settleRingPayment } = await import('../api/_lib/x402/self-facilitator.js');

const DECIMALS = 6;

// Build a buyer-signed ring transfer. When `sponsor` is provided the fee payer is
// the sponsor (authority != fee payer → sponsor mode); otherwise the buyer is the
// fee payer (self-pay).
function buildPayment({ amount, sponsor } = {}) {
	const buyer = Keypair.generate();
	const recipientOwner = Keypair.generate();
	const mint = Keypair.generate().publicKey;
	const feePayerKey = sponsor ? sponsor.publicKey : buyer.publicKey;

	const sourceAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
	const destAta = getAssociatedTokenAddressSync(mint, recipientOwner.publicKey);
	const transferIx = createTransferCheckedInstruction(
		sourceAta, mint, destAta, buyer.publicKey, amount, DECIMALS,
	);
	const message = new TransactionMessage({
		payerKey: feePayerKey,
		recentBlockhash: '11111111111111111111111111111111',
		instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), transferIx],
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);
	tx.sign([buyer]); // sponsor slot (if any) is co-signed later, past the guard

	return {
		payTo: recipientOwner.publicKey.toBase58(),
		requirement: {
			network: 'solana',
			asset: mint.toBase58(),
			amount: String(amount),
			payTo: recipientOwner.publicKey.toBase58(),
		},
		paymentPayload: { transaction: Buffer.from(tx.serialize()).toString('base64') },
	};
}

let prevPayTo;
beforeEach(() => {
	prevPayTo = process.env.X402_PAY_TO_SOLANA;
});
afterEach(() => {
	if (prevPayTo === undefined) delete process.env.X402_PAY_TO_SOLANA;
	else process.env.X402_PAY_TO_SOLANA = prevPayTo;
});

describe('settleRingPayment minimum-settle guard', () => {
	it('rejects a sub-minimum sponsor-mode dust settle before co-sign / RPC', async () => {
		const sponsor = Keypair.generate();
		const p = buildPayment({ amount: 1n, sponsor });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		// getBalance must never be reached — the guard short-circuits first.
		const conn = {
			getBalance: async () => { throw new Error('should not be called'); },
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
			feePayer: sponsor,
		});
		expect(res.success).toBe(false);
		expect(res.reason).toMatch(/^amount_below_min_settle:1</);
	});

	it('does NOT apply the minimum to a self-pay dust settle (buyer pays its own fee)', async () => {
		const p = buildPayment({ amount: 1n });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		// Self-pay is exempt from the min guard, so it proceeds to the SOL floor
		// check — which fails here (balance 0), proving the guard did not fire.
		const conn = {
			getBalance: async () => 0,
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.success).toBe(false);
		expect(res.reason).toMatch(/^fee_wallet_below_floor:/);
	});
});
