// The self-hosted facilitator must be able to settle a payment built by the
// REFERENCE x402 SVM client, not just by our own ring builder.
//
// Found while running the phase-4 inference settlement proof
// (scripts/inference-settlement-proof.mjs): @x402/svm attaches an SPL Memo to
// every `exact` payment it builds, and our anti-drain gate allowed only
// ComputeBudget, AssociatedToken and SPL Token instructions. Every standards-
// built payment was therefore refused with `program_not_allowed:MemoSq4…`,
// including payments from our own buyer path (api/_lib/x402/a2a-client.js
// delegates to that library). The ring builder emits no memo, which is why the
// gap survived: nothing we built ourselves ever hit it.
//
// Memo owns no accounts and moves no lamports, so accepting it costs the
// facilitator nothing. The rest of the gate must stay exactly as strict.

import { describe, it, expect } from 'vitest';
import {
	Keypair, PublicKey, TransactionMessage, TransactionInstruction,
	VersionedTransaction, SystemProgram, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const { validateRingTransaction } = await import('../api/_lib/x402/self-facilitator.js');

const MEMO_V2 = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_V1 = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
const BLOCKHASH = '11111111111111111111111111111111';

const buyer = Keypair.generate();
const treasury = Keypair.generate();
const mint = new PublicKey(USDC);
const payTo = treasury.publicKey;
const requirement = {
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	asset: USDC,
	payTo: payTo.toBase58(),
	amount: '1000000',
};
const allowlist = new Set([requirement.payTo]);

function memoIx(programId, text) {
	return new TransactionInstruction({
		keys: [],
		programId,
		data: Buffer.from(text, 'utf8'),
	});
}

// A self-paid transfer with `extra` instructions spliced in ahead of it, which
// is the shape @x402/svm produces (compute budget, memo, then the transfer).
function buildTx(extra = []) {
	const senderAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const receiverAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
	const instructions = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }),
		...extra,
		createTransferCheckedInstruction(
			senderAta, mint, receiverAta, buyer.publicKey,
			BigInt(requirement.amount), 6, [], TOKEN_PROGRAM_ID,
		),
	];
	const msg = new TransactionMessage({
		payerKey: buyer.publicKey,
		recentBlockhash: BLOCKHASH,
		instructions,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign([buyer]);
	return Buffer.from(vtx.serialize()).toString('base64');
}

const validate = (txBase64) => validateRingTransaction({
	txBase64, requirement, feePayerPubkey: null, allowlist,
});

describe('facilitator gate: SPL Memo interop', () => {
	it('settles a payment carrying a memo, the shape the reference client builds', () => {
		const v = validate(buildTx([memoIx(MEMO_V2, 'x402-payment:0xdeadbeef')]));
		expect(v.ok).toBe(true);
		expect(v.decoded.payer).toBe(buyer.publicKey.toBase58());
		expect(String(v.decoded.amountAtomic)).toBe(requirement.amount);
	});

	it('accepts the legacy memo program id too', () => {
		expect(validate(buildTx([memoIx(MEMO_V1, 'legacy')])).ok).toBe(true);
	});

	it('is unchanged for a payment with no memo', () => {
		expect(validate(buildTx()).ok).toBe(true);
	});

	it('does not let a memo smuggle in a second transfer', () => {
		const senderAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const receiverAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const second = createTransferCheckedInstruction(
			senderAta, mint, receiverAta, buyer.publicKey, 1n, 6, [], TOKEN_PROGRAM_ID,
		);
		const v = validate(buildTx([memoIx(MEMO_V2, 'note'), second]));
		expect(v.ok).toBe(false);
	});

	it('still forbids a System instruction sitting next to a memo', () => {
		const drain = SystemProgram.transfer({
			fromPubkey: buyer.publicKey,
			toPubkey: treasury.publicKey,
			lamports: 1,
		});
		const v = validate(buildTx([memoIx(MEMO_V2, 'note'), drain]));
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('system_instruction_forbidden');
	});

	it('still forbids an unrelated program next to a memo', () => {
		const stray = new TransactionInstruction({
			keys: [],
			programId: Keypair.generate().publicKey,
			data: Buffer.from([1, 2, 3]),
		});
		const v = validate(buildTx([memoIx(MEMO_V2, 'note'), stray]));
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/^program_not_allowed:/);
	});
});
