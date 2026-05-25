/**
 * @three-ws/sdk — Permissions module types
 */

import type { Signer } from 'ethers';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Scope of a single delegation, matching the DB `scope` JSONB field. */
export interface DelegationScope {
	/** ERC-20 token address or `"native"` for ETH */
	token: string;
	/** Maximum spend in token base units (string to avoid BigInt serialisation issues) */
	maxAmount: string;
	/** Period for resetting the spend limit */
	period: 'once' | 'daily' | 'weekly';
	/** EIP-55 checksummed target contract addresses */
	targets: string[];
	/** Delegation expiry as a Unix timestamp (seconds) */
	expiry: number;
}

/**
 * Public delegation record returned by the list and metadata endpoints.
 * Matches the `toPublicShape` / `toAuthShape` responses from the API.
 */
export interface DelegationPublic {
	/** UUID primary key */
	id: string;
	/** Agent UUID this delegation is granted to */
	agentId: string;
	/** EVM chain ID */
	chainId: number;
	/** EIP-55 checksummed address of the human delegator */
	delegatorAddress: string;
	/** EIP-55 checksummed address of the agent's smart account (delegate) */
	delegateAddress: string;
	/** keccak256 hash of the signed delegation envelope */
	delegationHash: string;
	/** Scope restrictions applied to this delegation */
	scope: DelegationScope;
	/** Current lifecycle status */
	status: 'active' | 'revoked' | 'expired';
	/** ISO-8601 timestamp when this delegation expires */
	expiresAt: string;
	/** ISO-8601 timestamp when this delegation was created */
	createdAt: string;
	/** ISO-8601 timestamp when this delegation was revoked (if applicable) */
	revokedAt?: string;
	/** ISO-8601 timestamp of the last successful redemption */
	lastRedeemedAt?: string;
	/** Total number of successful redemptions */
	redemptionCount: number;
}

/**
 * Human-friendly preset that the SDK translates into ERC-7710 caveats.
 * Use this instead of building raw `Caveat[]` structs.
 */
export interface ScopePreset {
	/** ERC-20 token address or `"native"` */
	token: string;
	/** Maximum spend in token base units */
	maxAmount: string;
	/** Spend-limit reset period */
	period: 'once' | 'daily' | 'weekly';
	/** EIP-55 checksummed target addresses that the agent is allowed to call */
	targets: string[];
	/** Days from now until the delegation expires */
	expiryDays: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown for all permissions-related errors.
 *
 * Error codes mirror the canonical vocabulary from PERMISSIONS_SPEC.md §8:
 * `delegation_expired` | `delegation_revoked` | `scope_exceeded` | `target_not_allowed`
 * | `delegation_not_found` | `signature_invalid` | `chain_not_supported` | `rate_limited`
 * | `browser_only` | `unknown_error`
 */
export class PermissionError extends Error {
	/** Canonical error code */
	code: string;
	constructor(code: string, message: string);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PermissionsClientOptions {
	/** API base URL (default: https://three.ws) */
	baseUrl?: string;
	/** Bearer token for authenticated endpoints */
	bearer?: string;
}

/**
 * HTTP client for the three.ws permissions API.
 *
 * `grant` and `revoke` are browser-only — they require a wallet-connected
 * `ethers.Signer` and will throw `PermissionError('browser_only', …)` in Node.js.
 */
export class PermissionsClient {
	constructor(opts?: PermissionsClientOptions);

	/**
	 * List delegations for an agent or delegator.
	 *
	 * Passing only `agentId` is public (no auth).
	 * Passing `delegator` requires a bearer token or session.
	 */
	listDelegations(params?: {
		agentId?: string;
		delegator?: string;
		status?: string;
	}): Promise<DelegationPublic[]>;

	/**
	 * Fetch public permissions metadata for an agent,
	 * including all active delegations and the spec version.
	 */
	getMetadata(agentId: string): Promise<{
		spec: string;
		delegations: DelegationPublic[];
	}>;

	/**
	 * Grant a scoped ERC-7710 delegation to an agent. **Browser only.**
	 *
	 * Builds an unsigned delegation from `preset`, signs it via EIP-712 using
	 * `signer` (the human owner / delegator), then POSTs to `/api/permissions/grant`.
	 *
	 * @param delegate - The agent's smart account address (obtain from the manifest or `getMetadata`)
	 */
	grant(params: {
		agentId: string;
		chainId: number;
		preset: ScopePreset;
		/** Agent's smart account address (delegate in the ERC-7710 envelope) */
		delegate: string;
		signer: Signer;
	}): Promise<{ id: string; delegationHash: string }>;

	/**
	 * Redeem a delegation to execute on-chain calls.
	 * Executed server-side via a relayer; requires a bearer token.
	 */
	redeem(params: {
		id: string;
		calls: Array<{ to: string; value?: string; data: string }>;
	}): Promise<{ txHash: string }>;

	/**
	 * Revoke a delegation on-chain and mirror to the server. **Browser only.**
	 *
	 * Sends `DelegationManager.disableDelegation(delegationHash)` via `signer`,
	 * then POSTs the tx hash to `/api/permissions/revoke`.
	 *
	 * Obtain `delegationHash` from `DelegationPublic.delegationHash` before calling.
	 */
	revoke(params: {
		id: string;
		/** keccak256 hash of the delegation (from `DelegationPublic.delegationHash`) */
		delegationHash: string;
		signer: Signer;
	}): Promise<{ status: 'revoked'; txHash: string }>;

	/**
	 * Verify that a delegation hash is valid on-chain via the `/api/permissions/verify` endpoint.
	 */
	verify(hash: string, chainId: number): Promise<{ valid: boolean; reason?: string }>;
}
