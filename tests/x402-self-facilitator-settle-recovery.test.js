// Regression: settleRingPayment must recover SUCCESS when a broadcast surfaces a
// bare "Transaction simulation failed" (web3.js dropping the structured preflight
// cause on some RPCs, incl. our own maxRetries resend racing the first landing) but
// the signature already landed on-chain with no error. The x402 authorization is
// single-use, so a landed signature IS this payment's own settlement. Failing
// closed there 502'd payments that had actually settled, the dominant settle_failed
// 502 wave observed in production 2026-07-21.
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
import bs58 from 'bs58';

const { settleRingPayment } = await import('../api/_lib/x402/self-facilitator.js');

const DECIMALS = 6;

// Self-pay settle (buyer is fee payer) so the sponsor min-settle / SOL-floor guards
// are exempt and the flow reaches sendRawTransaction with a minimal conn mock.
function buildSelfPay(amount = 10_000) {
	const buyer = Keypair.generate();
	const recipientOwner = Keypair.generate();
	const mint = Keypair.generate().publicKey;
	// The facilitator only settles mints the platform issues 402s for (env-pinned
	// after the 2026-07-23 audit); model this synthetic mint as configured.
	process.env.X402_ASSET_MINT_SOLANA = mint.toBase58();
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
		sig: bs58.encode(tx.signatures[0]),
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

describe('settleRingPayment already-landed recovery', () => {
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

	it('recovers success when broadcast says "simulation failed" but the signature landed with no error', async () => {
		const p = buildSelfPay();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		let probedSig = null;
		let historySearched = false;
		const conn = {
			getBalance: async () => 1_000_000_000,
			sendRawTransaction: async () => {
				throw new Error('Transaction simulation failed. Message: Transaction simulation failed. Logs: [].');
			},
			getSignatureStatuses: async (sigs, opts) => {
				probedSig = sigs[0];
				historySearched = opts?.searchTransactionHistory === true;
				return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
			},
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.success).toBe(true);
		expect(res.replayed).toBe(true);
		expect(res.transaction).toBe(p.sig);
		expect(probedSig).toBe(p.sig);
		expect(historySearched).toBe(true); // must search history so an aged-out landing is still found
	});

	it('recovers success when the RPC reply was unparseable and the signature landed', async () => {
		// A fallback endpoint answering in a non-standard shape makes web3.js throw a
		// superstruct union error instead of anything mentioning simulation. That
		// message never matched the old probe condition, so the settle was reported
		// failed WITHOUT ever asking the chain — 502ing a payment that had settled.
		const p = buildSelfPay();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		let probed = false;
		const conn = {
			getBalance: async () => 1_000_000_000,
			sendRawTransaction: async () => {
				throw new Error('Expected the value to satisfy a union of `type | type`, but received: [object Object]');
			},
			getSignatureStatuses: async () => {
				probed = true;
				return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
			},
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(probed).toBe(true);
		expect(res.success).toBe(true);
		expect(res.replayed).toBe(true);
		expect(res.transaction).toBe(p.sig);
	});

	it('skips the probe for a blockhash rejection, which proves the tx never landed', async () => {
		const p = buildSelfPay();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		let probed = false;
		const conn = {
			getBalance: async () => 1_000_000_000,
			sendRawTransaction: async () => {
				throw new Error('Simulation failed. Message: Transaction simulation failed: Blockhash not found. Logs: [].');
			},
			getSignatureStatuses: async () => {
				probed = true;
				return { value: [null] };
			},
			simulateTransaction: async () => ({ value: { err: 'BlockhashNotFound', logs: [] } }),
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(probed).toBe(false); // no wasted round trip on a provably-never-landed tx
		expect(res.success).toBe(false);
	});

	it('names the structured cause that web3.js drops from an empty-log preflight failure', async () => {
		// "Transaction simulation failed. Logs: []" reached production logs with no
		// cause at all (63 rows in 3 h, none diagnosable). The cause lives in
		// res.error.data.err, which web3.js discards — re-simulating on the failure
		// path is the only way to recover it.
		const p = buildSelfPay();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => 1_000_000_000,
			sendRawTransaction: async () => {
				throw new Error('Simulation failed. Message: Transaction simulation failed. Logs: [].');
			},
			getSignatureStatuses: async () => ({ value: [null] }),
			simulateTransaction: async () => ({
				value: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [] },
			}),
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.success).toBe(false);
		expect(res.reason).toMatch(/^broadcast_failed:/);
		expect(res.reason).toContain('InsufficientFundsForRent');
	});

	it('still fails closed when the signature did NOT land (a genuine simulation fault)', async () => {
		const p = buildSelfPay();
		process.env.X402_PAY_TO_SOLANA = p.payTo;
		const conn = {
			getBalance: async () => 1_000_000_000,
			sendRawTransaction: async () => {
				throw new Error('Transaction simulation failed. Logs: [].');
			},
			getSignatureStatuses: async () => ({ value: [null] }),
		};
		const res = await settleRingPayment({
			paymentPayload: p.paymentPayload,
			requirement: p.requirement,
			conn,
		});
		expect(res.success).toBe(false);
		expect(res.reason).toMatch(/^broadcast_failed:/);
		expect(res.reason).not.toMatch(/already_processed/);
	});
});
