// Atomic pump.fun creator-fee collection via a Jito bundle.
//
// Ported from nirholas/atomic's collect-jito.js. Single tx in the bundle:
//   1. Funder pays fee + tip
//   2. Creator signs `collectCoinCreatorFee` (drains pump.fun's vault to creator)
//   3. Creator signs a SystemProgram transfer of the freshly-collected SOL
//      to a safe DESTINATION wallet
//
// All three steps live in one tx, so even if the creator key is leaked /
// shared, no other holder of that key can interleave a tx between the
// collect and the drain.

import {
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';

import { bs58encode, getConnection, keypairFromSecret } from './solana.js';
import { randomTipAccount, submitBundle, waitForSignatures } from './jito.js';

// Rent-exempt minimum for a bare system account. Leaving exactly this in
// the creator keeps the account alive without locking up unnecessary SOL.
const RENT_EXEMPT_LAMPORTS = 890_880;

export async function atomicCollect({
	funderSecret,
	creatorSecret,
	destination,
	jitoTipSol = 0.005,
	priorityMicroLamports = 3_000_000,
	bufferLamports = RENT_EXEMPT_LAMPORTS,
	minVaultSol = 0.001,
}) {
	if (!destination) throw new Error('atomicCollect: destination is required');
	const destinationPk = new PublicKey(destination);
	const funder = keypairFromSecret(funderSecret);
	const creator = keypairFromSecret(creatorSecret);

	const pumpSdkPkg = await import('@nirholas/pump-sdk');
	const OnlinePumpSdk = pumpSdkPkg.OnlinePumpSdk || pumpSdkPkg.default?.OnlinePumpSdk;
	if (!OnlinePumpSdk) {
		throw new Error('@nirholas/pump-sdk: OnlinePumpSdk export missing');
	}
	const conn = getConnection();
	const sdk = new OnlinePumpSdk(conn);

	const vaultBalance = await sdk.getCreatorVaultBalance(creator.publicKey);
	const vaultLamports = Number(vaultBalance);
	if (vaultLamports < Math.floor(minVaultSol * LAMPORTS_PER_SOL)) {
		return {
			ok: false,
			code: 'vault_too_small',
			vaultSol: vaultLamports / LAMPORTS_PER_SOL,
			minSol: minVaultSol,
		};
	}

	const creatorPreBal = await conn.getBalance(creator.publicKey, 'confirmed');
	const transferAmount = creatorPreBal + vaultLamports - bufferLamports;
	if (transferAmount <= 0) {
		return {
			ok: false,
			code: 'nothing_to_drain',
			vaultSol: vaultLamports / LAMPORTS_PER_SOL,
			creatorPreBalSol: creatorPreBal / LAMPORTS_PER_SOL,
		};
	}

	const funderBal = await conn.getBalance(funder.publicKey, 'confirmed');
	const needed = (jitoTipSol + 0.002) * LAMPORTS_PER_SOL;
	if (funderBal < needed) {
		const err = new Error(
			`Funder needs >= ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL; has ${(funderBal / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
		);
		err.code = 'insufficient_funds';
		throw err;
	}

	const tipAccount = randomTipAccount();
	const collectIxs = await sdk.collectCoinCreatorFeeInstructions(creator.publicKey, funder.publicKey);
	const { blockhash } = await conn.getLatestBlockhash('confirmed');

	const msg = new TransactionMessage({
		payerKey: funder.publicKey,
		recentBlockhash: blockhash,
		instructions: [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
			ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
			SystemProgram.transfer({
				fromPubkey: funder.publicKey,
				toPubkey: tipAccount,
				lamports: Math.floor(jitoTipSol * LAMPORTS_PER_SOL),
			}),
			...collectIxs,
			SystemProgram.transfer({
				fromPubkey: creator.publicKey,
				toPubkey: destinationPk,
				lamports: transferAmount,
			}),
		],
	}).compileToV0Message();

	const tx = new VersionedTransaction(msg);
	tx.sign([funder, creator]);

	// Simulate first so we surface program errors before paying the tip.
	const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false });
	if (sim.value.err) {
		return {
			ok: false,
			code: 'simulation_failed',
			err: sim.value.err,
			logs: sim.value.logs,
		};
	}

	const bundle = [bs58encode(tx.serialize())];
	const { bundleId, explorer } = await submitBundle(bundle);
	const sig = bs58encode(tx.signatures[0]);
	const wait = await waitForSignatures(conn, [sig], { timeoutMs: 60_000, intervalMs: 2_000 });

	return {
		ok: wait.ok,
		bundleId,
		bundleExplorer: explorer,
		signature: sig,
		statuses: wait.statuses,
		err: wait.err,
		creator: creator.publicKey.toBase58(),
		destination,
		drainedLamports: transferAmount,
		drainedSol: transferAmount / LAMPORTS_PER_SOL,
		vaultLamports,
		vaultSol: vaultLamports / LAMPORTS_PER_SOL,
		txExplorer: `https://solscan.io/tx/${sig}`,
	};
}
