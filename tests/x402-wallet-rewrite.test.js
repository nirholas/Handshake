// @vitest-environment jsdom
// public/x402.js reads location.origin at import time, so this suite runs under
// a DOM environment.
import { describe, it, expect } from 'vitest';
import {
	Keypair,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

import { classifyWalletTxMutation } from '../public/x402.js';

// Regression guard for the /club "transaction modification" checkout failure:
// wallets with auto priority fees or transaction protection (Phantom, Solflare)
// rewrite the prepared payment before signing. The self-hosted facilitator
// settles ComputeBudget-only rewrites fine (validateRingTransaction accepts any
// compute-budget set within its fee caps and never pins the blockhash), so the
// modal must not bounce those buyers. Everything else must stay blocked with a
// named reason, because the facilitator deterministically rejects it.

const feePayer = Keypair.generate().publicKey;
const buyer = Keypair.generate().publicKey;
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const guardProgram = Keypair.generate().publicKey;
const BLOCKHASH_A = '9SKUcvUFmCzhu9nRCYX3et4vinLLNPTVQhh6BLNRSTgV';
const BLOCKHASH_B = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const computeBudgetProgram = new PublicKey('ComputeBudget111111111111111111111111111111');

// Hand-encoded ComputeBudget instructions (tag 2 = SetComputeUnitLimit u32,
// tag 3 = SetComputeUnitPrice u64). web3.js's ComputeBudgetProgram encoder
// trips over jsdom's foreign-realm Buffers, and the wire bytes are trivial.
function setComputeUnitLimit(units) {
	const data = Buffer.alloc(5);
	data[0] = 2;
	data.writeUInt32LE(units, 1);
	return new TransactionInstruction({ programId: computeBudgetProgram, keys: [], data });
}

function setComputeUnitPrice(microLamports) {
	const data = Buffer.alloc(9);
	data[0] = 3;
	data.writeBigUInt64LE(BigInt(microLamports), 1);
	return new TransactionInstruction({ programId: computeBudgetProgram, keys: [], data });
}

function transferIx({ amount = 1000 } = {}) {
	const data = new Uint8Array(10);
	data[0] = 12; // TransferChecked tag
	data[1] = amount & 0xff;
	return new TransactionInstruction({
		programId: tokenProgram,
		keys: [
			{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
			{ pubkey: buyer, isSigner: true, isWritable: false },
		],
		data: Buffer.from(data),
	});
}

function buildTx({ payerKey = feePayer, recentBlockhash = BLOCKHASH_A, instructions }) {
	const message = new TransactionMessage({
		payerKey,
		recentBlockhash,
		instructions,
	}).compileToV0Message();
	return new VersionedTransaction(message);
}

describe('classifyWalletTxMutation', () => {
	// The one shared instruction set: prepare's compute budget pair + transfer.
	const transfer = transferIx();
	const preparedIxs = [
		setComputeUnitLimit(60_000),
		setComputeUnitPrice(1),
		transfer,
	];

	it('accepts an untouched transaction', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({ instructions: preparedIxs });
		expect(classifyWalletTxMutation(prepared, signed)).toBeNull();
	});

	it('accepts a wallet retuning the priority fee (ComputeBudget-only rewrite)', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({
			instructions: [
				setComputeUnitLimit(120_000),
				setComputeUnitPrice(50_000),
				transfer,
			],
		});
		expect(classifyWalletTxMutation(prepared, signed)).toBeNull();
	});

	it('accepts a wallet stripping the compute budget entirely', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({ instructions: [transfer] });
		expect(classifyWalletTxMutation(prepared, signed)).toBeNull();
	});

	it('accepts a refreshed blockhash', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({ instructions: preparedIxs, recentBlockhash: BLOCKHASH_B });
		expect(classifyWalletTxMutation(prepared, signed)).toBeNull();
	});

	it('names the program when a wallet injects guard instructions', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({
			instructions: [
				...preparedIxs,
				new TransactionInstruction({ programId: guardProgram, keys: [], data: Buffer.from([1]) }),
			],
		});
		expect(classifyWalletTxMutation(prepared, signed)).toBe(
			`it injected instructions from program ${guardProgram.toBase58()}`,
		);
	});

	it('blocks a changed transfer amount', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({
			instructions: [preparedIxs[0], preparedIxs[1], transferIx({ amount: 255 })],
		});
		expect(classifyWalletTxMutation(prepared, signed)).toBe('it changed the payment instructions');
	});

	it('blocks a swapped fee payer', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({ payerKey: buyer, instructions: preparedIxs });
		expect(classifyWalletTxMutation(prepared, signed)).toBe('it changed the transaction fee payer');
	});

	it('blocks a dropped transfer instruction', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		const signed = buildTx({ instructions: [preparedIxs[0], preparedIxs[1]] });
		expect(classifyWalletTxMutation(prepared, signed)).toBe('it added or removed payment instructions');
	});

	it('blocks an unverifiable wallet-returned object instead of throwing', () => {
		const prepared = buildTx({ instructions: preparedIxs });
		expect(classifyWalletTxMutation(prepared, {})).toBe('the rewrite could not be verified');
	});
});
