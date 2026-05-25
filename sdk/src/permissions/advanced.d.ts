/**
 * @three-ws/sdk/permissions/advanced — TypeScript definitions
 */

import type { Signer } from 'ethers';

// ---------------------------------------------------------------------------
// encodeScopedDelegation
// ---------------------------------------------------------------------------

export interface UnsignedDelegation {
	delegate: string;
	delegator: string;
	/** EIP-712 authority hash — ZeroHash for root delegations */
	authority: string;
	caveats: Caveat[];
	salt: bigint;
	chainId: number;
}

export interface Caveat {
	/** Caveat enforcer contract address */
	enforcer: string;
	/** ABI-encoded terms bytes */
	terms: string;
	/** ABI-encoded args bytes */
	args?: string;
}

/**
 * Build an unsigned delegation envelope ready to be signed via `signDelegation`.
 *
 * @throws {PermissionError} 'validation_error' if inputs are invalid
 */
export function encodeScopedDelegation(opts: {
	delegator: string;
	delegate: string;
	caveats: Caveat[];
	expiry: number;
	chainId: number;
}): UnsignedDelegation;

// ---------------------------------------------------------------------------
// isDelegationValid
// ---------------------------------------------------------------------------

/**
 * Check on-chain whether a delegation is still active (not disabled).
 * Requires an RPC URL — either passed directly or via `RPC_URL_<chainId>` env var.
 *
 * @throws {PermissionError} 'chain_not_supported' if no RPC URL is available
 */
export function isDelegationValid(opts: {
	hash: string;
	chainId: number;
	rpcUrl?: string;
}): Promise<{ valid: boolean; reason?: string }>;

// ---------------------------------------------------------------------------
// delegationToManifestEntry
// ---------------------------------------------------------------------------

export interface ManifestDelegationEntry {
	chainId: number;
	delegator: string;
	delegate: string;
	hash: string;
	scope: Record<string, unknown>;
}

/**
 * Convert a signed delegation to the `permissions.delegations[]` entry shape
 * used in the agent manifest (`agent-manifest/0.2`).
 */
export function delegationToManifestEntry(signedDelegation: {
	chainId: number;
	delegator: string;
	delegate: string;
	hash: string;
	scope?: Record<string, unknown>;
}): ManifestDelegationEntry;

// ---------------------------------------------------------------------------
// PermissionError (re-exported for convenience)
// ---------------------------------------------------------------------------

export class PermissionError extends Error {
	code: string;
	constructor(code: string, message: string);
}
