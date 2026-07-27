/**
 * Shared plumbing for autonomous purchases paid from an agent's own custodial
 * Solana wallet.
 *
 * Two marketplace surfaces sell things an agent can buy for itself: individual
 * skills (`skill_purchases`, via /api/marketplace/purchase-as-agent) and whole
 * assets (avatars, agents, plugins; `asset_purchases`, via
 * /api/marketplace/buy-asset with an `agent_id`). Both spend real USDC out of the
 * same wallet under the same owner-configured ceiling, so the cap accounting,
 * keypair recovery and transfer construction live here rather than being forked
 * per endpoint.
 *
 * The daily ceiling is `agent_identities.meta.auto_purchase_daily_limit_usdc`
 * (a number, e.g. 10 = $10/day; absent or <= 0 means no cap). It spans BOTH
 * tables: an agent that spent its budget on skills cannot then spend it again on
 * assets. Enforcement is two-phase at every call site, and the second phase is
 * the authoritative one:
 *
 *   1. Pre-check before doing expensive work: a cheap early rejection, and a
 *      TOCTOU on its own (concurrent buys all read the same pre-spend SUM).
 *   2. Re-check AFTER the pending row is inserted. The row is now counted by the
 *      same SUM, so every concurrent in-flight purchase is visible and the total
 *      cannot be collectively overshot. Fails safe: contending requests abort
 *      rather than risk exceeding the owner's limit.
 *
 * Nothing here decides WHETHER a purchase is allowed beyond the cap. Ownership,
 * rate limits, self-dealing and already-owned checks stay with the endpoints,
 * which have the surface-specific context to answer them.
 */

import { PublicKey } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	getMint,
} from '@solana/spl-token';

import { sql } from './db.js';
import { submitProtected } from './execution-engine.js';
import { ensureAgentWallet, recoverSolanaAgentKeypair } from './agent-wallet.js';

export const USDC_DECIMALS = 6;

/** Start of the current UTC day, as an ISO string: the cap window boundary. */
export function dayStartIso() {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	return d.toISOString();
}

/**
 * Read the owner-configured autonomous purchase ceiling off an agent's meta.
 * @param {object|null} meta - agent_identities.meta
 * @returns {{ enabled: boolean, limitUsdc: number|null, limitAtomics: bigint }}
 */
export function readPurchaseCap(meta) {
	const limitUsdc = meta?.auto_purchase_daily_limit_usdc;
	const enabled = typeof limitUsdc === 'number' && Number.isFinite(limitUsdc) && limitUsdc > 0;
	return {
		enabled,
		limitUsdc: enabled ? limitUsdc : null,
		limitAtomics: enabled ? BigInt(Math.round(limitUsdc * 10 ** USDC_DECIMALS)) : 0n,
	};
}

/**
 * Total atomics this user's agents have committed to autonomous purchases today,
 * in one currency, across BOTH purchase tables. Rows in a terminal-failure state
 * ('failed', 'expired') never count; 'pending' rows do, so an in-flight purchase
 * holds its share of the budget until it resolves.
 *
 * @param {{ userId: string, currencyMint: string }} args
 * @returns {Promise<bigint>}
 */
export async function sumDailyPurchaseAtomics({ userId, currencyMint }) {
	const since = dayStartIso();
	const [row] = await sql`
		SELECT (
			COALESCE((
				SELECT SUM(amount) FROM skill_purchases
				WHERE user_id = ${userId}
				  AND created_at >= ${since}
				  AND currency_mint = ${currencyMint}
				  AND status NOT IN ('failed', 'expired')
			), 0)
			+
			COALESCE((
				SELECT SUM(amount) FROM asset_purchases
				WHERE buyer_user_id = ${userId}
				  AND created_at >= ${since}
				  AND currency_mint = ${currencyMint}
				  AND status NOT IN ('failed', 'expired')
			), 0)
		)::bigint AS total
	`;
	// ::bigint (not ::numeric) is load-bearing: SUM() yields numeric, which the
	// driver can hand back as "2500000.00", a string BigInt() refuses to parse.
	return BigInt(row?.total ?? 0);
}

/**
 * Human-readable cap-exceeded message, shared so both surfaces explain the same
 * limit with the same remedy.
 */
export function capExceededMessage(limitUsdc) {
	return `daily agent purchase cap of ${limitUsdc} USDC reached. Raise meta.auto_purchase_daily_limit_usdc or wait until UTC midnight`;
}

/**
 * Load a buyer agent's custodial keypair, provisioning the wallet if it is
 * missing or corrupt. Every decrypt is audit-logged with `reason` into
 * usage_events + the owner-viewable custody trail.
 *
 * The caller must ALREADY have verified that `userId` owns `agentId`; this
 * function does not authorize, it only loads.
 *
 * @param {{ agentId: string, userId: string, reason: string, meta?: object }} args
 * @returns {Promise<{ keypair: import('@solana/web3.js').Keypair, address: string, agentMeta: object }>}
 */
export async function loadBuyerAgentKeypair({ agentId, userId, reason, meta = {} }) {
	// Repairs an unparseable address or a missing secret rather than letting a
	// downstream PublicKey()/sign call throw on it.
	await ensureAgentWallet(agentId, userId, { reason });

	const [row] = await sql`
		SELECT meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	const agentMeta = row?.meta || {};
	const encrypted = agentMeta.encrypted_solana_secret;
	if (!encrypted) {
		const err = new Error('agent has no Solana wallet');
		err.code = 'no_buyer_wallet';
		throw err;
	}
	const keypair = await recoverSolanaAgentKeypair(encrypted, { agentId, userId, reason, meta });
	return { keypair, address: keypair.publicKey.toBase58(), agentMeta };
}

/**
 * Build and broadcast the SPL payment for an autonomous purchase: an idempotent
 * ATA-create for the seller (buyer pays the rent) plus a transferChecked
 * carrying the Solana Pay reference key, so the same findReference /
 * validateTransfer verification the browser flow uses works unchanged.
 *
 * Sent through submitProtected: data-driven compute-unit estimate, escalating
 * priority fee, blockhash-refresh rebroadcast, and a hard throw on an on-chain
 * revert (never a silently-dropped transaction).
 *
 * @param {{
 *   connection: import('@solana/web3.js').Connection,
 *   keypair: import('@solana/web3.js').Keypair,
 *   currencyMint: string,
 *   recipient: string,
 *   amountAtomics: bigint|string|number,
 *   referenceKey: import('@solana/web3.js').PublicKey,
 * }} args
 * @returns {Promise<string>} the confirmed transaction signature
 */
export async function sendAgentPurchaseTransfer({
	connection,
	keypair,
	currencyMint,
	recipient,
	amountAtomics,
	referenceKey,
}) {
	const mintKey = new PublicKey(currencyMint);
	const recipKey = new PublicKey(recipient);
	const mintInfo = await getMint(connection, mintKey);

	const fromAta = getAssociatedTokenAddressSync(mintKey, keypair.publicKey);
	const toAta = getAssociatedTokenAddressSync(mintKey, recipKey);

	const transferIx = createTransferCheckedInstruction(
		fromAta, mintKey, toAta, keypair.publicKey,
		BigInt(amountAtomics), mintInfo.decimals,
	);
	// The reference key is a non-signer, non-writable account on the transfer so
	// findReference() can locate this exact payment on-chain afterwards.
	transferIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

	const { signature } = await submitProtected({
		network: 'mainnet',
		connection,
		payer: keypair,
		instructions: [
			createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, recipKey, mintKey),
			transferIx,
		],
	});
	return signature;
}
