// Shared helpers for agent → pump.fun actions.
// Loads an agent, requires the caller is the owner, and returns a signing
// Keypair derived from the agent's encrypted Solana secret.

import { sql } from './db.js';
import { solanaConnection as failoverConnection } from './solana/connection.js';
import {
	generateSolanaAgentWallet,
	recoverSolanaAgentKeypair,
} from './agent-wallet.js';

const RPC_PUBLIC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet: 'https://api.devnet.solana.com',
};

// Resolve the primary mainnet RPC, preferring a real paid endpoint over the
// public one (which 429s under load). Order:
//   1. SOLANA_RPC_URL, but only when it points at something other than the
//      public endpoint — operators sometimes set it to the public URL, which
//      is no better than leaving it unset.
//   2. A Helius endpoint derived from HELIUS_API_KEY — the same credential that
//      already powers the DAS balance path in balances.js, so one key fixes
//      both the portfolio reads and the agent-wallet balance reads.
//   3. The public endpoint as a last resort.
function resolveMainnetRpc() {
	const configured = process.env.SOLANA_RPC_URL;
	if (configured && configured !== RPC_PUBLIC.mainnet) return configured;
	if (process.env.HELIUS_API_KEY) {
		return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
	}
	return RPC_PUBLIC.mainnet;
}

const RPC = {
	mainnet: resolveMainnetRpc(),
	devnet: process.env.SOLANA_RPC_URL_DEVNET || RPC_PUBLIC.devnet,
};

export function solanaConnection(network = 'mainnet') {
	return failoverConnection({ url: RPC[network] || RPC.mainnet, commitment: 'confirmed' });
}

export function solanaPublicConnection(network = 'mainnet') {
	return failoverConnection({ url: RPC_PUBLIC[network] || RPC_PUBLIC.mainnet, commitment: 'confirmed' });
}

/**
 * Load an agent owned by `userId`. If the agent has no Solana wallet yet
 * (older rows from before pump-fun integration), one is generated and
 * persisted into meta in-place.
 *
 * `audit` is passed through to `recoverSolanaAgentKeypair` so every key
 * decrypt is recorded in usage_events. Always pass `{ reason }` at minimum.
 *
 * Returns { agent, keypair, meta }. Caller is responsible for calling
 * agent-payments / pump-sdk / pump-swap-sdk with `keypair`.
 */
export async function loadAgentForSigning(agentId, userId, audit = null) {
	const [row] = await sql`
		SELECT * FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row) return { error: { status: 404, code: 'not_found', msg: 'agent not found' } };
	if (row.user_id !== userId)
		return { error: { status: 403, code: 'forbidden', msg: 'not your agent' } };

	let meta = { ...(row.meta || {}) };
	if (!meta.encrypted_solana_secret || !meta.solana_address) {
		const sol = await generateSolanaAgentWallet();
		meta = {
			...meta,
			solana_address: sol.address,
			encrypted_solana_secret: sol.encrypted_secret,
			solana_wallet_source: 'auto_provisioned',
		};
		await sql`
			UPDATE agent_identities
			SET meta = ${JSON.stringify(meta)}::jsonb
			WHERE id = ${agentId}
		`;
	}

	let keypair;
	try {
		keypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
			agentId,
			userId,
			reason: audit?.reason || 'pumpfun_action',
			meta: audit?.meta,
		});
	} catch (err) {
		// A custodial wallet encrypted under a RETIRED key (e.g. the WALLET_ENCRYPTION_KEY
		// that changed during the Vercel→Cloud Run migration) can no longer be decrypted
		// with the current key OR the JWT_SECRET fallback. decryptSecret authenticates
		// every candidate (AES-GCM), so a failure here is a DEFINITIVE "unrecoverable",
		// not a transient fault — and the stored address is already unreachable because we
		// can't sign for it, so nothing new is stranded. Rather than fail every launch
		// forever, self-heal: mint a fresh wallet under the CURRENT key (the same
		// self-provision the no-wallet branch above does), keep the dead address in meta
		// for the audit/recovery trail, and continue.
		if (!isUnrecoverableSecret(err)) throw err;
		// Before abandoning the dead wallet, make sure it isn't holding funds that are
		// still recoverable with the retired key. Silently re-keying a FUNDED wallet
		// would strand real SOL. If it holds more than dust, refuse and surface it for
		// manual recovery (decrypt + sweep with the old key, then it re-keys clean);
		// only an empty stale wallet is safe to auto-replace.
		let staleSol;
		try {
			staleSol = await staleWalletBalanceSol(meta.solana_address);
		} catch {
			// Can't confirm the wallet is empty — fail CLOSED rather than risk
			// abandoning funds during an RPC hiccup. The launcher will retry next tick.
			return {
				error: {
					status: 503,
					code: 'stale_balance_unverified',
					msg: 'could not verify the retired-key wallet is empty before re-keying — will retry',
				},
			};
		}
		if (staleSol > STALE_REKEY_DUST_SOL) {
			return {
				error: {
					status: 409,
					code: 'wallet_funds_stranded',
					msg: `custodial wallet ${meta.solana_address} holds ${staleSol.toFixed(4)} SOL under a retired encryption key — recover it before re-keying`,
				},
			};
		}
		const sol = await generateSolanaAgentWallet();
		meta = {
			...meta,
			solana_address: sol.address,
			encrypted_solana_secret: sol.encrypted_secret,
			solana_wallet_source: 're_provisioned_stale_key',
			stale_solana_address: meta.solana_address,
			rekeyed_at: new Date().toISOString(),
		};
		await sql`
			UPDATE agent_identities
			SET meta = ${JSON.stringify(meta)}::jsonb
			WHERE id = ${agentId}
		`;
		keypair = await recoverSolanaAgentKeypair(meta.encrypted_solana_secret, {
			agentId,
			userId,
			reason: 're_provision_stale_key',
			meta: audit?.meta,
		});
	}
	return { agent: row, keypair, meta };
}

// A stored custodial secret is unrecoverable when neither the dedicated wallet key
// nor the JWT_SECRET fallback can authenticate it (AES-GCM OperationError), or when
// the decrypted bytes aren't a valid 64-byte secret key. These are permanent — a
// retired key or a corrupt record — so it's safe to re-provision rather than retry.
// A stale wallet below this SOL is treated as empty — safe to abandon and re-key.
// Above it, re-keying would strand funds, so the self-heal refuses and flags it.
const STALE_REKEY_DUST_SOL = 0.01;

// On-chain SOL balance of an address, for the self-heal's fund-safety check. Uses
// the public RPC (a free read). Throws on an RPC error so the caller can fail CLOSED
// (refuse to re-key) rather than mistake an unreachable RPC for an empty wallet.
async function staleWalletBalanceSol(address) {
	if (!address) return 0;
	const { PublicKey } = await import('@solana/web3.js');
	const conn = solanaPublicConnection('mainnet');
	const lamports = await conn.getBalance(new PublicKey(address));
	return lamports / 1e9;
}

export function isUnrecoverableSecret(err) {
	const name = err?.name || '';
	const msg = String(err?.message || '');
	return (
		name === 'OperationError' ||
		/decrypt failed|no candidate key|bad secret key|invalid secret key|secret key size/i.test(msg)
	);
}
