// Tests for the wallet-fee-governor hook in settleRingPayment
// (api/_lib/x402/self-facilitator.js `feeMeter`).
//
// The hook is the enforcement point of the wallet fee governor: it runs after
// the hard SOL floor passes, sees the wallet that will ACTUALLY pay this
// transaction's fee (payer in self-pay, sponsor in sponsor mode), and a
// { ok:false } verdict refuses the settle before any co-sign or broadcast.
// A hook fault must fail OPEN — pacing must never become an outage.

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

// Build a buyer-signed ring transfer. When `sponsor` is provided the fee payer
// is the sponsor (authority != fee payer → sponsor mode); otherwise the buyer
// is the fee payer (self-pay).
function buildPayment({ amount, sponsor } = {}) {
	const buyer = Keypair.generate();
	const recipientOwner = Keypair.generate();
	const mint = Keypair.generate().publicKey;
	process.env.X402_ASSET_MINT_SOLANA = mint.toBase58();
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
	tx.sign([buyer]);

	return {
		buyer,
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
let prevAssetMint;
beforeEach(() => {
	prevPayTo = process.env.X402_PAY_TO_SOLANA;
	prevAssetMint = process.env.X402_ASSET_MINT_SOLANA;
});
afterEach(() => {
	if (prevPayTo === undefined) delete process.env.X402_PAY_TO_SOLANA;
	else process.env.X402_PAY_TO_SOLANA = prevPayTo;
	if (prevAssetMint === undefined) delete process.env.X402_ASSET_MINT_SOLANA;
	else process.env.X402_ASSET_MINT_SOLANA = prevAssetMint;
});

const FUNDED = 1_000_000_000; // 1 SOL, comfortably above the 0.02 default floor

describe('settleRingPayment wallet fee meter', () => {
	it('refuses before broadcast when the meter says the budget is spent', async () => {
		const p = buildPayment({ amount: 5000n });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => FUNDED,
			sendRawTransaction: async () => { throw new Error('should not be called'); },
		};
		const seen = [];
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
			feeMeter: async (args) => {
				seen.push(args);
				return { ok: false, reason: 'fee_runway_exhausted:1+2>3' };
			},
		});
		expect(res.success).toBe(false);
		expect(res.reason).toBe('fee_runway_exhausted:1+2>3');
		expect(res.feePayer).toBe(p.buyer.publicKey.toBase58());
		// Self-pay: the metered wallet is the buyer, with its live balance and
		// the fee estimate the settle would burn.
		expect(seen).toHaveLength(1);
		expect(seen[0].feeWalletB58).toBe(p.buyer.publicKey.toBase58());
		expect(seen[0].solLamports).toBe(FUNDED);
		expect(seen[0].selfPay).toBe(true);
		expect(seen[0].estFeeLamports).toBeGreaterThan(0);
	});

	it('meters the SPONSOR wallet on sponsor-mode settles', async () => {
		const sponsor = Keypair.generate();
		const p = buildPayment({ amount: 5000n, sponsor });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => FUNDED,
			sendRawTransaction: async () => { throw new Error('should not be called'); },
		};
		const seen = [];
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
			feePayer: sponsor,
			feeMeter: async (args) => {
				seen.push(args);
				return { ok: false, reason: 'fee_runway_exhausted:9+1>9' };
			},
		});
		expect(res.success).toBe(false);
		expect(seen[0].feeWalletB58).toBe(sponsor.publicKey.toBase58());
		expect(seen[0].selfPay).toBe(false);
		expect(res.feePayer).toBe(sponsor.publicKey.toBase58());
	});

	it('fails OPEN when the meter itself throws — the settle proceeds', async () => {
		const p = buildPayment({ amount: 5000n });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => FUNDED,
			// The settle got PAST the meter and reached broadcast: prove it by
			// failing there with a sentinel.
			sendRawTransaction: async () => { throw new Error('meter_did_not_block'); },
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
			feeMeter: async () => { throw new Error('meter down'); },
		});
		expect(res.success).toBe(false);
		expect(res.reason).toMatch(/^broadcast_failed:.*meter_did_not_block/);
	});

	it('an admitting meter does not alter the settle path', async () => {
		const p = buildPayment({ amount: 5000n });
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => FUNDED,
			sendRawTransaction: async () => { throw new Error('reached_broadcast'); },
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
			feeMeter: async () => ({ ok: true, reason: null }),
		});
		expect(res.reason).toMatch(/^broadcast_failed:.*reached_broadcast/);
	});
});
