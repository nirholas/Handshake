// Unit tests for the gasless (platform-sponsored) purchase transaction builder.
//
// Runs fully offline: real @solana/web3.js + @solana/spl-token, a fake RPC
// connection that returns a fixed blockhash, and `decimals` passed in so no
// on-chain getMint call is needed. Proves the platform is the fee-payer, that
// it pre-signs, that the buyer's authority is an unsigned slot, and that the
// fee split / reference key land in the compiled message.

import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import {
	buildGaslessPurchaseTx,
	resolveMarketplacePayer,
	_resetMarketplacePayerCache,
} from '../../api/_lib/solana/gasless-tx.js';

const PAYER = Keypair.generate();
const BUYER = Keypair.generate();
const SELLER = Keypair.generate();
const TREASURY = Keypair.generate();
const MINT = Keypair.generate(); // stand-in SPL mint
const REFERENCE = Keypair.generate().publicKey;

// A valid base58 32-byte string to stand in for a recent blockhash.
const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const fakeConnection = {
	getLatestBlockhash: async () => ({ blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1 }),
};

function setPayerEnv() {
	process.env.MARKETPLACE_PAYER_KEYPAIR = Buffer.from(PAYER.secretKey).toString('base64');
	_resetMarketplacePayerCache();
}

function clearPayerEnv() {
	delete process.env.MARKETPLACE_PAYER_KEYPAIR;
	delete process.env.PLATFORM_TREASURY_KEYPAIR;
	delete process.env.TREASURY_KEYPAIR;
	_resetMarketplacePayerCache();
}

const baseArgs = {
	connection: fakeConnection,
	buyerPublicKey: BUYER.publicKey.toBase58(),
	recipient: SELLER.publicKey.toBase58(),
	mint: MINT.publicKey.toBase58(),
	reference: REFERENCE.toBase58(),
	decimals: 6,
};

describe('buildGaslessPurchaseTx', () => {
	beforeEach(() => setPayerEnv());

	it('returns null when no payer keypair is configured', async () => {
		clearPayerEnv();
		const out = await buildGaslessPurchaseTx({ ...baseArgs, creatorAtomics: 1_000_000n });
		expect(out).toBeNull();
	});

	it('makes the platform payer the fee-payer and pre-signs it', async () => {
		const out = await buildGaslessPurchaseTx({ ...baseArgs, creatorAtomics: 1_000_000n });
		expect(out).not.toBeNull();
		expect(out.gasless).toBe(true);
		expect(out.feePayer).toBe(PAYER.publicKey.toBase58());

		const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, 'base64'));
		// Fee-payer is always the first static account key.
		expect(tx.message.staticAccountKeys[0].equals(PAYER.publicKey)).toBe(true);
		// The payer's signature slot is filled; the buyer's is still all-zero.
		const payerSig = tx.signatures[0];
		expect(payerSig.some((b) => b !== 0)).toBe(true);
	});

	it('leaves the buyer authority as an unsigned required signer', async () => {
		const out = await buildGaslessPurchaseTx({ ...baseArgs, creatorAtomics: 1_000_000n });
		const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, 'base64'));
		const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
		const buyerIdx = keys.indexOf(BUYER.publicKey.toBase58());
		expect(buyerIdx).toBeGreaterThan(0); // present, but not the fee-payer
		expect(buyerIdx).toBeLessThan(tx.message.header.numRequiredSignatures); // still a signer
		// Only the payer has signed so far.
		expect(tx.signatures[buyerIdx].every((b) => b === 0)).toBe(true);
	});

	it('includes the Solana Pay reference key in the message', async () => {
		const out = await buildGaslessPurchaseTx({ ...baseArgs, creatorAtomics: 1_000_000n });
		const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, 'base64'));
		expect(tx.message.staticAccountKeys.some((k) => k.equals(REFERENCE))).toBe(true);
	});

	it('adds a second transfer leg only when a platform fee applies', async () => {
		const single = await buildGaslessPurchaseTx({ ...baseArgs, creatorAtomics: 1_000_000n });
		const txSingle = VersionedTransaction.deserialize(Buffer.from(single.transaction, 'base64'));
		expect(txSingle.message.compiledInstructions).toHaveLength(1);

		const split = await buildGaslessPurchaseTx({
			...baseArgs,
			creatorAtomics: 900_000n,
			platformFeeAtomics: 100_000n,
			platformFeeWallet: TREASURY.publicKey.toBase58(),
		});
		const txSplit = VersionedTransaction.deserialize(Buffer.from(split.transaction, 'base64'));
		expect(txSplit.message.compiledInstructions).toHaveLength(2);
		// The treasury fee wallet's ATA owner is present in the account keys.
		expect(txSplit.message.staticAccountKeys.length).toBeGreaterThan(
			txSingle.message.staticAccountKeys.length,
		);
	});

	it('closes a split transaction with the reference-carrying seller leg', async () => {
		// @solana/pay's validateTransfer only inspects the LAST instruction and
		// requires the reference to ride it, so the fee leg must come first. With
		// the order flipped, confirm rejects a paid purchase as "invalid references".
		const split = await buildGaslessPurchaseTx({
			...baseArgs,
			creatorAtomics: 900_000n,
			platformFeeAtomics: 100_000n,
			platformFeeWallet: TREASURY.publicKey.toBase58(),
		});
		const tx = VersionedTransaction.deserialize(Buffer.from(split.transaction, 'base64'));
		const keys = tx.message.staticAccountKeys;
		const last = tx.message.compiledInstructions[tx.message.compiledInstructions.length - 1];
		expect(keys[last.accountKeyIndexes[last.accountKeyIndexes.length - 1]].equals(REFERENCE)).toBe(true);

		const sellerAta = getAssociatedTokenAddressSync(MINT.publicKey, SELLER.publicKey);
		expect(last.accountKeyIndexes.some((i) => keys[i].equals(sellerAta))).toBe(true);
	});
});

describe('resolveMarketplacePayer', () => {
	it('falls back to PLATFORM_TREASURY_KEYPAIR when the dedicated var is unset', async () => {
		clearPayerEnv();
		process.env.PLATFORM_TREASURY_KEYPAIR = Buffer.from(PAYER.secretKey).toString('base64');
		_resetMarketplacePayerCache();
		const kp = await resolveMarketplacePayer();
		expect(kp).not.toBeNull();
		expect(kp.publicKey.equals(PAYER.publicKey)).toBe(true);
		clearPayerEnv();
	});
});
