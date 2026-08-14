// Gasless purchase transactions — the platform sponsors Solana network fees.
//
// Users hold USDC but rarely hold SOL. Forcing them to acquire SOL just to pay
// the ~0.000005 SOL signature fee is real friction at checkout. Here the
// platform's marketplace payer becomes the transaction fee-payer and co-signs
// the transaction on the backend; the buyer still authorizes the SPL token
// transfer with their own signature, but pays no network fee.
//
// The buyer receives a partially-signed `VersionedTransaction` (the payer's
// signature is already attached) and adds only their authority signature in the
// wallet. The reference key rides the seller leg so @solana/pay's findReference
// / validateTransfer can locate and verify the payment — see
// api/_lib/purchase-confirm.js, which validates the exact split this builds.
//
// The payer keypair is one of the monitored signers (`marketplace-payer` in
// api/_lib/solana-signers.js). If it runs dry every gasless purchase silently
// breaks, so the balance-check cron watches it. When no payer is configured the
// builder returns null and callers fall back to a buyer-pays transaction.

import {
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	getMint,
} from '@solana/spl-token';

import { decodeSecretKey } from '../solana-signers.js';

// Resolve the marketplace fee-payer keypair from the environment once per
// lambda instance. `undefined` = not yet resolved, `null` = not configured /
// undecodable (callers fall back to buyer-pays).
let _payer = undefined;

/**
 * Load the platform's gasless fee-payer keypair, preferring the dedicated
 * MARKETPLACE_PAYER_KEYPAIR and falling back to the shared platform treasury.
 * @returns {Promise<import('@solana/web3.js').Keypair | null>}
 */
export async function resolveMarketplacePayer() {
	if (_payer !== undefined) return _payer;
	const secret =
		process.env.MARKETPLACE_PAYER_KEYPAIR ||
		process.env.PLATFORM_TREASURY_KEYPAIR ||
		process.env.TREASURY_KEYPAIR ||
		'';
	if (!secret) {
		_payer = null;
		return null;
	}
	const bytes = await decodeSecretKey(secret);
	if (!bytes) {
		_payer = null;
		return null;
	}
	try {
		const { Keypair } = await import('@solana/web3.js');
		_payer = Keypair.fromSecretKey(bytes);
	} catch {
		_payer = null;
	}
	return _payer;
}

/** Reset the cached payer — test-only seam so env changes take effect. */
export function _resetMarketplacePayerCache() {
	_payer = undefined;
}

/**
 * Build a partially-signed (gasless) SPL-token purchase transaction.
 *
 * The platform payer is the fee-payer and co-signs; the buyer authorizes the
 * transfer leg(s) with their wallet. Pass a non-zero `platformFeeAtomics` +
 * `platformFeeWallet` to add the treasury fee leg atomically (skill purchases);
 * omit them for a single full-amount transfer (whole-asset purchases).
 *
 * @param {object}  args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {string}  args.buyerPublicKey      base58 — token-transfer authority
 * @param {string}  args.recipient           base58 — seller / creator payout wallet
 * @param {string}  args.mint                base58 — SPL mint (e.g. USDC)
 * @param {bigint}  args.creatorAtomics      seller leg amount, atomic units
 * @param {string}  args.reference           base58 — Solana Pay reference key
 * @param {number} [args.decimals]           mint decimals; fetched on-chain if omitted
 * @param {bigint} [args.platformFeeAtomics] treasury leg amount, atomic units
 * @param {string} [args.platformFeeWallet]  base58 — treasury wallet for the fee leg
 * @returns {Promise<{ transaction: string, feePayer: string, gasless: true } | null>}
 *          base64 VersionedTransaction, or null when no payer is configured.
 */
export async function buildGaslessPurchaseTx({
	connection,
	buyerPublicKey,
	recipient,
	mint,
	creatorAtomics,
	reference,
	decimals,
	platformFeeAtomics = 0n,
	platformFeeWallet = null,
}) {
	const payer = await resolveMarketplacePayer();
	if (!payer) return null;

	const mintKey = new PublicKey(mint);
	const buyer = new PublicKey(buyerPublicKey);
	const referenceKey = new PublicKey(reference);

	const mintDecimals =
		decimals == null ? (await getMint(connection, mintKey)).decimals : Number(decimals);

	const fromAta = getAssociatedTokenAddressSync(mintKey, buyer);
	const creatorAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(recipient));

	// Seller leg — carries the Solana Pay reference so the confirm pipeline can
	// locate this transaction via findReference.
	const creatorIx = createTransferCheckedInstruction(
		fromAta,
		mintKey,
		creatorAta,
		buyer,
		creatorAtomics,
		mintDecimals,
	);
	creatorIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

	const instructions = [];

	// Platform fee leg — same transaction, atomic with the seller leg. It goes
	// FIRST because @solana/pay's validateTransfer only ever inspects the LAST
	// instruction: with the fee leg last, confirm would decode the treasury
	// transfer, find no reference key on it, and reject a perfectly good payment
	// as "invalid references". The seller leg therefore always closes the
	// transaction (api/_lib/purchase-confirm.js validates exactly this shape).
	if (platformFeeAtomics > 0n && platformFeeWallet) {
		const feeAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(platformFeeWallet));
		instructions.push(
			createTransferCheckedInstruction(
				fromAta,
				mintKey,
				feeAta,
				buyer,
				platformFeeAtomics,
				mintDecimals,
			),
		);
	}

	instructions.push(creatorIx);

	const { blockhash } = await connection.getLatestBlockhash('confirmed');
	const messageV0 = new TransactionMessage({
		payerKey: payer.publicKey, // platform pays the network fee
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();

	const tx = new VersionedTransaction(messageV0);
	tx.sign([payer]); // partial: buyer adds the authority signature in their wallet

	return {
		transaction: Buffer.from(tx.serialize()).toString('base64'),
		feePayer: payer.publicKey.toBase58(),
		gasless: true,
	};
}
