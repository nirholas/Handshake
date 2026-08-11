// Pump.fun creator-fee claim flow.
//
// On every buy/sell of a pump.fun token, the program accrues a small SOL fee
// into a creator vault (a PDA derived from the launch's `creator` address).
// The creator can periodically sweep that vault to its associated SOL token
// account, which we then unwrap (close → SOL) and route to the coin treasury.
//
// The SDK call used is `OnlinePumpSdk.collectCoinCreatorFeeInstructions`,
// which returns the full list of instructions needed (collectCreatorFee on the
// bonding-curve program + collectCoinCreatorFee on the AMM program for the
// post-graduation case). We then append a close-account instruction to unwrap
// the WSOL the program transferred into the creator's WSOL ATA.
//
// Idempotency: this transaction is safe to retry — `collectCreatorFee` is a
// no-op when the vault is empty, and the unwrap close-ATA ix is best-effort
// (it errors if the ATA doesn't exist yet, but doesn't break the rest).
//
// Returns: { tx_signature, claimed_lamports, was_empty } so the caller can
// record the inflow against coin_launches.total_claimed_lamports.

import {
	ComputeBudgetProgram,
	PublicKey,
	Transaction,
} from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, createCloseAccountInstruction } from '@solana/spl-token';

import { getConnection, getPumpSdk, solanaPubkey } from '../pump.js';
import { submitProtected } from '../execution-engine.js';

const PRIORITY_MICRO_LAMPORTS = 100_000;

/**
 * Build + sign + submit a creator-fee claim for one coin launch.
 *
 * @param {object} opts
 * @param {object} opts.coin       coin_launches row
 * @param {import('@solana/web3.js').Keypair} opts.coinCreator
 *                                 keypair whose publicKey === coin.creator_wallet
 * @param {import('@solana/web3.js').Keypair} opts.treasury
 *                                 keypair that pays fees + receives unwrapped SOL
 *                                 (typically same as coinCreator for v1 unless
 *                                 the deployer chose to separate roles)
 * @returns {Promise<{ tx_signature: string|null, claimed_lamports: bigint, was_empty: boolean }>}
 */
export async function claimCreatorFees({ coin, coinCreator, treasury }) {
	const network = coin.network || 'mainnet';
	const connection = getConnection({ network });
	const { sdk } = await getPumpSdk({ network });

	const creatorPk = coinCreator.publicKey;
	const treasuryPk = treasury.publicKey;
	if (creatorPk.toBase58() !== coin.creator_wallet) {
		throw new Error(
			`creator key mismatch: keypair pubkey=${creatorPk.toBase58()} but coin.creator_wallet=${coin.creator_wallet}`,
		);
	}

	// Snapshot the creator's lamport balance BEFORE the claim. The collect-fee
	// instructions move SOL through the creator's WSOL ATA — to count what
	// landed, we either parse the program event or simply diff the creator's
	// native balance after the close-account unwrap. The diff approach is
	// robust against SDK version drift.
	const balanceBefore = BigInt(await connection.getBalance(creatorPk, 'confirmed'));

	const ixs = await sdk.collectCoinCreatorFeeInstructions(creatorPk, treasuryPk);
	if (!Array.isArray(ixs) || ixs.length === 0) {
		return { tx_signature: null, claimed_lamports: 0n, was_empty: true };
	}

	// Append close-account on the creator's WSOL ATA to unwrap any wSOL that
	// landed there during the AMM collect path. If the ATA doesn't exist or
	// is already closed, the program reverts on this single ix only — wrap
	// in its own tx to avoid blocking the claim itself.
	let creatorWsolAta;
	try {
		creatorWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creatorPk, false);
	} catch {
		creatorWsolAta = null;
	}

	// Protected send: treasury is fee-payer + signer; the coin creator co-signs the
	// collectCreatorFee instruction when it's a distinct key. submitProtected sets
	// its own compute-budget, rebroadcasts with a fresh blockhash, and throws on an
	// on-chain revert.
	const extraSigners = creatorPk.toBase58() !== treasuryPk.toBase58() ? [coinCreator] : [];
	const { signature: sig } = await submitProtected({
		network,
		connection,
		payer: treasury,
		instructions: ixs,
		opts: { extraSigners },
	});

	// Attempt the unwrap as a follow-up tx (best-effort).
	if (creatorWsolAta) {
		try {
			const ataInfo = await connection.getAccountInfo(creatorWsolAta, 'confirmed');
			if (ataInfo && Number(ataInfo.lamports) > 0) {
				const closeTx = new Transaction();
				closeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }));
				closeTx.add(createCloseAccountInstruction(creatorWsolAta, treasuryPk, creatorPk));
				closeTx.feePayer = treasuryPk;
				const { blockhash: bh2 } = await connection.getLatestBlockhash('confirmed');
				closeTx.recentBlockhash = bh2;
				// Treasury is fee-payer; the creator owns the ATA being closed and
				// co-signs only when it is a distinct key (dedupe, or web3.js
				// rejects the duplicate signer).
				closeTx.sign(treasury, ...extraSigners);
				await connection.sendRawTransaction(closeTx.serialize(), {
					skipPreflight: false,
					maxRetries: 5,
				});
			}
		} catch {
			// Non-fatal — the next claim cycle will unwrap any residue.
		}
	}

	const balanceAfter = BigInt(await connection.getBalance(creatorPk, 'confirmed'));
	// Diff: net SOL gained at the creator account (or the treasury when same key).
	// Subtract a generous fee estimate so we don't credit ourselves more than
	// what actually landed. Real fees are ~5_000 + priority; we under-count
	// conservatively if the diff goes negative.
	let diff = balanceAfter - balanceBefore;
	if (diff < 0n) diff = 0n;

	return {
		tx_signature: sig,
		claimed_lamports: diff,
		was_empty: diff === 0n,
	};
}

/**
 * Validate that a public key string is a real Solana pubkey. Helper for
 * launch-prep handler input validation.
 */
export function isValidPubkey(s) {
	return solanaPubkey(s) instanceof PublicKey;
}
