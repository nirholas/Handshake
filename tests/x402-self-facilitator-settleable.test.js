// Tests for the settleability gate in verifyRingPayment
// (api/_lib/x402/self-facilitator.js).
//
// The paid flow is verify → run handler → settle. A static decode alone
// (validateRingTransaction) proves a payment is SHAPED right but not that it can
// actually settle, so a buyer could sign a well-formed TransferChecked from a
// ZERO-balance ATA, pass verify, make the expensive handler run (burning upstream
// provider spend), and only then have settle revert `insufficient funds`. The gate
// simulates the transaction on /verify and rejects anything that cannot settle,
// with a source-balance fallback when simulation RPC is unavailable and a
// fail-closed result when neither can run.

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

const { verifyRingPayment } = await import('../api/_lib/x402/self-facilitator.js');

const DECIMALS = 6;
const AMOUNT_ATOMIC = 1000n; // 0.001 USDC

// Build a real, buyer-signed SELF-PAY ring transaction: fee payer == the USDC
// authority, so no sponsor key is needed and validateRingTransaction accepts it as
// long as payTo is allowlisted. Returns the payment payload + requirement the
// facilitator consumes.
function buildSelfPayPayment({ amount = AMOUNT_ATOMIC } = {}) {
	const buyer = Keypair.generate();
	const recipientOwner = Keypair.generate();
	const mint = Keypair.generate().publicKey;

	const sourceAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
	const destAta = getAssociatedTokenAddressSync(mint, recipientOwner.publicKey);

	const transferIx = createTransferCheckedInstruction(
		sourceAta, mint, destAta, buyer.publicKey, amount, DECIMALS,
	);
	const message = new TransactionMessage({
		payerKey: buyer.publicKey,
		recentBlockhash: '11111111111111111111111111111111',
		instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), transferIx],
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);
	tx.sign([buyer]);

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

describe('verifyRingPayment settleability gate', () => {
	it('rejects a payment whose simulation reverts (zero-balance source ATA)', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		// Simulation of a transfer from an unfunded ATA returns an InstructionError.
		const conn = {
			simulateTransaction: async () => ({ value: { err: { InstructionError: [1, { Custom: 1 }] } } }),
			getTokenAccountBalance: async () => { throw new Error('should not be called'); },
		};
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.isValid).toBe(false);
		expect(res.invalidReason).toMatch(/^simulation_failed:/);
	});

	it('accepts a payment whose simulation succeeds (funded)', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
			getTokenAccountBalance: async () => { throw new Error('should not be called'); },
		};
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.isValid).toBe(true);
		expect(res.payer).toBeTruthy();
		expect(res.asset).toBe(p.requirement.asset);
	});

	it('falls back to a source-balance read when simulation is unavailable — rejects a zero balance', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			simulateTransaction: async () => { throw new Error('rpc down'); },
			getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
		};
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.isValid).toBe(false);
		expect(res.invalidReason).toMatch(/^insufficient_source_balance:/);
	});

	it('falls back to a source-balance read when simulation is unavailable — accepts a sufficient balance', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			simulateTransaction: async () => { throw new Error('rpc down'); },
			getTokenAccountBalance: async () => ({ value: { amount: String(AMOUNT_ATOMIC) } }),
		};
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.isValid).toBe(true);
	});

	it('fails CLOSED when neither simulation nor balance read is available', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			simulateTransaction: async () => { throw new Error('rpc down'); },
			getTokenAccountBalance: async () => { throw new Error('rpc down'); },
		};
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.isValid).toBe(false);
		expect(res.invalidReason).toMatch(/^settle_precheck_unavailable:/);
	});

	it('still rejects a malformed static shape before ever simulating', async () => {
		const p = buildSelfPayPayment();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		let simulated = false;
		const conn = {
			simulateTransaction: async () => { simulated = true; return { value: { err: null } }; },
			getTokenAccountBalance: async () => ({ value: { amount: '0' } }),
		};
		// payTo not in the allowlist → static validation must fail, no RPC touched.
		const res = await verifyRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: { ...p.requirement, payTo: Keypair.generate().publicKey.toBase58() },
			conn,
		});
		expect(res.isValid).toBe(false);
		expect(simulated).toBe(false);
	});
});
