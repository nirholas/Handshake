/**
 * @three-ws/sdk — Permissions module
 *
 * ERC-7710 scoped delegation client for three.ws.
 *
 * Quick start:
 *   import { PermissionsClient } from '@three-ws/sdk/permissions';
 *   const client = new PermissionsClient({ baseUrl: 'https://three.ws/' });
 *   const { delegations } = await client.getMetadata(agentId);
 */

const DEFAULT_BASE = 'https://three.ws/';

/**
 * Typed error class for permission operations.
 * The `code` property maps to canonical error codes from PERMISSIONS_SPEC.md §8.
 *
 * Codes: delegation_expired | delegation_revoked | scope_exceeded | target_not_allowed
 *        | delegation_not_found | signature_invalid | chain_not_supported | rate_limited
 */
export class PermissionError extends Error {
	/**
	 * @param {string} code    Canonical error code from the spec
	 * @param {string} message Human-readable description
	 */
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'PermissionError';
	}
}

/**
 * HTTP client for the three.ws permissions API.
 *
 * Methods `grant` and `revoke` require a browser-connected ethers v6 Signer and will
 * throw `PermissionError('browser_only', ...)` when called in a Node.js environment.
 */
export class PermissionsClient {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.baseUrl]  API base URL (default: https://three.ws/)
	 * @param {string} [opts.bearer]  Bearer token for authenticated endpoints (redeem, private list)
	 */
	constructor({ baseUrl = DEFAULT_BASE, bearer } = {}) {
		this._base = baseUrl.replace(/\/$/, '');
		this._bearer = bearer ?? null;
	}

	/** @returns {Record<string, string>} */
	_headers() {
		const h = { 'Content-Type': 'application/json' };
		if (this._bearer) h['Authorization'] = `Bearer ${this._bearer}`;
		return h;
	}

	/**
	 * @param {string} url
	 * @param {RequestInit} [opts]
	 * @returns {Promise<any>}
	 */
	async _request(url, opts = {}) {
		const res = await fetch(url, { ...opts, headers: this._headers() });
		const body = await res.json();
		if (!body.ok) {
			throw new PermissionError(
				body.error ?? 'unknown_error',
				body.message ?? body.error ?? 'Request failed',
			);
		}
		return body;
	}

	/**
	 * List delegations for an agent or delegator.
	 *
	 * Public path (agentId only) returns active delegations without auth.
	 * Private path (delegator) requires a bearer token or session.
	 *
	 * @param {{ agentId?: string; delegator?: string; status?: string }} [params]
	 * @returns {Promise<DelegationPublic[]>}
	 */
	async listDelegations({ agentId, delegator, status } = {}) {
		const url = new URL(`${this._base}/api/permissions/list`);
		if (agentId) url.searchParams.set('agentId', agentId);
		if (delegator) url.searchParams.set('delegator', delegator);
		if (status) url.searchParams.set('status', status);
		const data = await this._request(url.toString());
		return data.delegations ?? [];
	}

	/**
	 * Fetch public permissions metadata for an agent.
	 * Returns the spec version and the agent's active delegations.
	 *
	 * @param {string} agentId
	 * @returns {Promise<{ spec: string; delegations: DelegationPublic[] }>}
	 */
	async getMetadata(agentId) {
		const url = `${this._base}/api/permissions/metadata?agentId=${encodeURIComponent(agentId)}`;
		const data = await this._request(url);
		return { spec: data.spec, delegations: data.delegations ?? [] };
	}

	/**
	 * Grant a scoped ERC-7710 delegation to an agent. **Browser only.**
	 *
	 * Flow: build unsigned delegation → EIP-712 sign via signer → POST /api/permissions/grant.
	 *
	 * The `delegate` param is the agent's smart account address (obtained from the agent manifest
	 * or from `getMetadata`). The signer must be the human owner (delegator) wallet.
	 *
	 * @param {{
	 *   agentId: string;
	 *   chainId: number;
	 *   preset: ScopePreset;
	 *   delegate: string;
	 *   signer: import('ethers').Signer;
	 * }} params
	 * @returns {Promise<{ id: string; delegationHash: string }>}
	 * @throws {PermissionError} 'browser_only' when called in Node.js
	 */
	async grant({ agentId, chainId, preset, delegate, signer }) {
		if (typeof window === 'undefined') {
			throw new PermissionError(
				'browser_only',
				'grant() requires a browser environment with a wallet — not available in Node.js',
			);
		}
		// Dynamic import keeps ethers + toolkit out of the Node.js bundle.
		const { encodeScopedDelegation, signDelegation } = await import(
			'./permissions/toolkit.js'
		);
		const { CAVEAT_ENFORCERS, encodeCaveats } = await import('./erc7710/abi.js');

		const delegatorAddr = await signer.getAddress();
		const expiry = Math.floor(Date.now() / 1000) + preset.expiryDays * 86400;

		const caveats = [
			{
				enforcer: CAVEAT_ENFORCERS.AllowedTargetsEnforcer[chainId],
				terms: encodeCaveats(
					preset.targets.map((t) => ({ enforcer: t, terms: '0x', args: '0x' })),
				),
				args: '0x',
			},
			{
				enforcer: CAVEAT_ENFORCERS.ERC20LimitEnforcer[chainId],
				terms: preset.maxAmount,
				args: '0x',
			},
			{
				enforcer: CAVEAT_ENFORCERS.TimestampEnforcer[chainId],
				terms: String(expiry),
				args: '0x',
			},
		];

		const unsigned = encodeScopedDelegation({
			delegator: delegatorAddr,
			delegate,
			caveats,
			expiry,
			chainId,
		});
		const signed = await signDelegation(unsigned, signer);

		const data = await this._request(`${this._base}/api/permissions/grant`, {
			method: 'POST',
			body: JSON.stringify({
				agentId,
				chainId,
				delegation: signed,
				scope: {
					token: preset.token,
					maxAmount: preset.maxAmount,
					period: preset.period,
					targets: preset.targets,
					expiryDays: preset.expiryDays,
				},
			}),
		});
		return { id: data.id, delegationHash: data.delegationHash };
	}

	/**
	 * Redeem a delegation to execute on-chain calls. Requires a bearer token.
	 *
	 * The redemption is executed server-side via a relayer. The bearer token must
	 * carry a scope that includes permission to redeem on behalf of the agent.
	 *
	 * @param {{ id: string; calls: Array<{ to: string; value?: string; data: string }> }} params
	 * @returns {Promise<{ txHash: string }>}
	 */
	async redeem({ id, calls }) {
		const data = await this._request(`${this._base}/api/permissions/redeem`, {
			method: 'POST',
			body: JSON.stringify({ id, calls }),
		});
		return { txHash: data.txHash };
	}

	/**
	 * Revoke a delegation on-chain and mirror the revocation to the server. **Browser only.**
	 *
	 * Flow: send `DelegationManager.disableDelegation(delegationHash)` tx via signer
	 *       → POST /api/permissions/revoke with the resulting tx hash.
	 *
	 * Obtain `delegationHash` from the `DelegationPublic` returned by `listDelegations`
	 * or `getMetadata` before calling this method.
	 *
	 * @param {{ id: string; delegationHash: string; signer: import('ethers').Signer }} params
	 * @returns {Promise<{ status: 'revoked'; txHash: string }>}
	 * @throws {PermissionError} 'browser_only' when called in Node.js
	 * @throws {PermissionError} 'chain_not_supported' if no DelegationManager for the signer's chain
	 */
	async revoke({ id, delegationHash, signer }) {
		if (typeof window === 'undefined') {
			throw new PermissionError(
				'browser_only',
				'revoke() requires a browser environment with a wallet — not available in Node.js',
			);
		}
		const { Contract } = await import('ethers');
		const { DELEGATION_MANAGER_ABI, DELEGATION_MANAGER_DEPLOYMENTS } = await import(
			'./erc7710/abi.js'
		);
		const network = await signer.provider.getNetwork();
		const managerAddr = DELEGATION_MANAGER_DEPLOYMENTS[Number(network.chainId)];
		if (!managerAddr) {
			throw new PermissionError(
				'chain_not_supported',
				`no DelegationManager for chain ${network.chainId}`,
			);
		}
		const dm = new Contract(managerAddr, DELEGATION_MANAGER_ABI, signer);
		const tx = await dm.disableDelegation(delegationHash);
		await tx.wait();
		await this._request(`${this._base}/api/permissions/revoke`, {
			method: 'POST',
			body: JSON.stringify({ id, txHash: tx.hash }),
		});
		return { status: 'revoked', txHash: tx.hash };
	}

	/**
	 * Verify that a delegation hash is valid on-chain.
	 * Makes a real-time read from the DelegationManager contract.
	 *
	 * @param {string} hash     Delegation hash (keccak256, hex-encoded)
	 * @param {number} chainId  Chain ID where the delegation was created
	 * @returns {Promise<{ valid: boolean; reason?: string }>}
	 */
	async verify(hash, chainId) {
		const url = `${this._base}/api/permissions/verify?hash=${encodeURIComponent(hash)}&chainId=${chainId}`;
		const data = await this._request(url);
		return data.reason !== undefined
			? { valid: data.valid, reason: data.reason }
			: { valid: data.valid };
	}
}
