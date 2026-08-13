// Solana CAIP-2 network ids for the x402 rail, in one place.
//
// These three constants used to be inlined in three modules (x402-spec.js,
// x402-solana-confirm.js, x402/a2a-client.js) because x402-spec.js imports
// x402-solana-confirm.js and an import back the other way would have been a
// cycle. This module is a leaf (env.js is itself import-free), so every caller
// can share one definition without reintroducing that cycle.
//
// A Solana CAIP-2 id is `solana:` followed by the first 32 base58 characters of
// the cluster's genesis hash, which is what makes the id chain-identifying: a
// receipt naming a network names the exact ledger the payment settled on.

import { env } from '../env.js';

export const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const NETWORK_SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** The CAIP-2 network id for a cluster, given its base58 genesis hash. */
export function caip2ForGenesisHash(genesisHash) {
	const hash = String(genesisHash || '').trim();
	if (!hash) throw new Error('caip2ForGenesisHash: genesis hash is required');
	return `solana:${hash.slice(0, 32)}`;
}

/**
 * The local test lane, or null when it is not configured.
 *
 * A `solana-test-validator` mints a fresh genesis on every reset, so its CAIP-2
 * id cannot be a constant: the operator passes the live id in
 * `X402_SOLANA_LOCAL_NETWORK` (derive it with `caip2ForGenesisHash()` from a
 * `getGenesisHash` call). Unset, as it is in production and in every deployed
 * environment, this returns null and `isSolanaNetwork()` behaves exactly as it
 * did before this module existed.
 *
 * Naming the lane honestly is the point. Settling a proof run on a local
 * validator while labelling the receipt `NETWORK_SOLANA_DEVNET` would put a
 * false chain id inside a signed attestation whose whole purpose is to be
 * true, so the local lane gets its own real id instead.
 */
export function solanaLocalTestNetwork() {
	const id = env.X402_SOLANA_LOCAL_NETWORK;
	if (!id) return null;
	const trimmed = String(id).trim();
	return /^solana:[1-9A-HJ-NP-Za-km-z]{1,32}$/.test(trimmed) ? trimmed : null;
}

/** True when this network settles over the Solana rail. */
export function isSolanaNetwork(network) {
	return (
		network === NETWORK_SOLANA_MAINNET ||
		network === NETWORK_SOLANA_DEVNET ||
		network === 'solana' ||
		(network != null && network === solanaLocalTestNetwork())
	);
}
