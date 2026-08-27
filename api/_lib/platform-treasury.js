// @ts-check
// Shared platform-treasury rail.
//
// A single operator-funded Solana wallet that the platform uses to seed small,
// real, on-chain grants — today: the agent activation "Go Live" welcome grant
// (api/_lib/activation.js). The autonomous circulation engine
// (api/_lib/circulation.js) keeps its own treasury plumbing for its hot path;
// this module is the canonical, reusable helper for everything else, so new
// platform-funded flows don't each re-implement keypair decoding + transfers.
//
// The secret is read from CIRCULATION_TREASURY_SECRET (the existing operator
// treasury) so no new key needs provisioning; a flow may override it with its
// own secret env var. With no secret set, isConfigured() is false and callers
// degrade gracefully — nothing is ever inert-but-pretending.

import { solanaConnection } from './agent-pumpfun.js';
import { blockhashKey, getRecentBlockhashInfo, readBalanceOrNull, rpcUnavailableError } from './solana/read-guards.js';
import { confirmOrThrow } from './solana/confirm.js';

const SOL = 1_000_000_000;
// tx fee + compute headroom kept on the treasury beyond the amount it sends.
export const FEE_BUFFER = Math.floor(0.0009 * SOL);

/** The treasury network — mainnet unless the operator runs circulation on devnet. */
export function treasuryNetwork() {
	return process.env.CIRCULATION_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
}

/**
 * Resolve the treasury secret. `overrideEnv` lets a specific flow point at its
 * own funded wallet; otherwise the shared operator treasury is used.
 * @param {string} [overrideEnv]
 */
function treasurySecret(overrideEnv) {
	const override = overrideEnv ? String(process.env[overrideEnv] || '').trim() : '';
	if (override) return override;
	return String(process.env.CIRCULATION_TREASURY_SECRET || '').trim();
}

/** Whether a treasury secret is configured (so a flow can fail soft, not hard). */
export function isConfigured(overrideEnv) {
	return treasurySecret(overrideEnv).length > 0;
}

// Decode a 64-byte secret key in base58, base64, or JSON-array form (mirrors the
// circulation decoder so operators can paste whichever format their tooling emits).
function decodeSecretKey(secret, bs58) {
	let bytes = null;
	try {
		const d = bs58.decode(secret);
		if (d.length === 64) bytes = d;
	} catch {
		/* not base58 */
	}
	if (!bytes) {
		try {
			const b = Buffer.from(secret, 'base64');
			if (b.length === 64) bytes = b;
		} catch {
			/* not base64 */
		}
	}
	if (!bytes) {
		try {
			const arr = JSON.parse(secret);
			if (Array.isArray(arr) && arr.length === 64) bytes = Uint8Array.from(arr);
		} catch {
			/* not json */
		}
	}
	return bytes ? Uint8Array.from(bytes) : null;
}

/**
 * Recover the treasury Keypair. Throws a typed Error when unset/malformed — the
 * caller is expected to have gated on isConfigured() first for the soft path.
 * @param {string} [overrideEnv]
 */
export async function getTreasuryKeypair(overrideEnv) {
	const secret = treasurySecret(overrideEnv);
	if (!secret) {
		const e = new Error('treasury secret unset');
		// @ts-ignore — tagged for callers that map it to a clean "not configured".
		e.code = 'treasury_unset';
		throw e;
	}
	const { Keypair } = await import('@solana/web3.js');
	const bs58 = (await import('bs58')).default;
	const bytes = decodeSecretKey(secret, bs58);
	if (!bytes) {
		throw new Error('treasury secret must be a 64-byte base58, base64, or JSON-array secret key');
	}
	return Keypair.fromSecretKey(bytes);
}

/** Lamport balance of an address on the treasury's connection. */
export async function lamportBalance(conn, address) {
	const { PublicKey } = await import('@solana/web3.js');
	const lamports = await readBalanceOrNull(conn, new PublicKey(address), 'confirmed');
	if (lamports == null) throw rpcUnavailableError(null, `treasury balance for ${address} is unreadable right now`);
	return BigInt(lamports);
}

/**
 * Sign + send a SOL transfer from `fromKp` to `toAddress`. Retries once on an
 * expired blockhash (the hash can lapse between fetch and send under RPC/key
 * latency); a fresh hash is valid for ~60s. Returns the confirmed signature.
 */
export async function transferSol(conn, fromKp, toAddress, lamports) {
	const {
		PublicKey,
		SystemProgram,
		TransactionMessage,
		VersionedTransaction,
		ComputeBudgetProgram,
	} = await import('@solana/web3.js');
	const toPk = new PublicKey(toAddress);

	const MAX_ATTEMPTS = 2;
	let lastErr;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		// The retry exists to escape an expired blockhash, so it forces a fresh
		// read; the first attempt may take the cached one, and a chain that cannot
		// be read at all still yields a hash inside its validity window.
		const { blockhash, lastValidBlockHeight } = await getRecentBlockhashInfo(
			conn,
			blockhashKey({ network: treasuryNetwork() }),
			{ forceFresh: attempt > 0 },
		);
		const message = new TransactionMessage({
			payerKey: fromKp.publicKey,
			recentBlockhash: blockhash,
			instructions: [
				ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 60_000 }),
				ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
				SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: toPk, lamports }),
			],
		}).compileToV0Message();
		const tx = new VersionedTransaction(message);
		tx.sign([fromKp]);
		// Captured outside the try so a confirmation failure still carries the
		// broadcast signature out on the thrown error — the caller can then check
		// whether the tx actually landed before treating it as a clean failure.
		let signature = null;
		try {
			signature = await conn.sendTransaction(tx, { maxRetries: 5 });
			// HTTP-polling confirm (no WebSocket) — throws on a landed-but-reverted
			// transfer; the surrounding catch retries only the never-landed case.
			await confirmOrThrow(conn, { signature, blockhash, lastValidBlockHeight }, 'confirmed');
			return signature;
		} catch (err) {
			const msg = err?.message || '';
			// Retry only when the tx provably never landed (preflight blockhash miss)
			// AND nothing was broadcast — never re-broadcast after a confirmation
			// ambiguity, which could double-send.
			if (
				attempt < MAX_ATTEMPTS - 1 &&
				!signature &&
				/Blockhash not found|BlockhashNotFound/i.test(msg)
			) {
				lastErr = err;
				continue;
			}
			if (signature && err && typeof err === 'object') err.signature = signature;
			throw err;
		}
	}
	throw lastErr;
}

/**
 * Whether a transaction signature has landed on-chain (confirmed or finalized,
 * with no execution error). Used to disambiguate a confirmation-timeout — where
 * the tx may have actually succeeded — before any retry/refund decision, so a
 * grant is never sent twice. Returns false on any RPC trouble (caller decides).
 */
export async function signatureLanded(conn, signature) {
	if (!signature) return false;
	const statuses = await conn.getSignatureStatuses([signature], {
		searchTransactionHistory: true,
	});
	const st = statuses?.value?.[0];
	if (!st) return false;
	if (st.err) return false;
	return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
}

/** The shared Solana RPC connection for a network (re-export for convenience). */
export function treasuryConnection(network) {
	return solanaConnection(network || treasuryNetwork());
}

export { SOL };
