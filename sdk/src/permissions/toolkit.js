/**
 * ERC-7710 delegation toolkit — low-level helpers.
 *
 * Used by PermissionsClient.grant() and the advanced sub-entry.
 * Consumers who need direct delegation control should import from
 * '@three-ws/sdk/permissions/advanced' instead of this internal module.
 */

import { PermissionError } from '../permissions.js';
export { PermissionError };

import { DELEGATION_MANAGER_ABI, getDelegationManager } from '../erc7710/abi.js';

/**
 * Build an unsigned delegation envelope ready to be signed via `signDelegation`.
 *
 * @param {object} opts
 * @param {string}   opts.delegator  EIP-55 address of the human delegator
 * @param {string}   opts.delegate   EIP-55 address of the agent's smart account
 * @param {Array}    opts.caveats    Array of caveat objects {enforcer, terms, args}
 * @param {number}   opts.expiry     Unix timestamp (seconds) when the delegation expires
 * @param {number}   opts.chainId    EVM chain ID
 * @returns {{ delegate: string, delegator: string, authority: string, caveats: Array, salt: bigint, chainId: number }}
 */
export function encodeScopedDelegation({ delegator, delegate, caveats, expiry, chainId }) {
	if (!delegator || !delegate) {
		throw new PermissionError('validation_error', 'delegator and delegate addresses are required');
	}
	if (!Array.isArray(caveats)) {
		throw new PermissionError('validation_error', 'caveats must be an array');
	}
	return {
		delegate,
		delegator,
		authority: '0x0000000000000000000000000000000000000000000000000000000000000000', // ZeroHash = root
		caveats: caveats.map((c) => ({
			enforcer: c.enforcer,
			terms: c.terms ?? '0x',
			args: c.args ?? '0x',
		})),
		salt: BigInt(expiry),
		chainId,
	};
}

/**
 * EIP-712 sign a delegation envelope using the provided ethers Signer.
 *
 * @param {{ delegate: string, delegator: string, authority: string, caveats: Array, salt: bigint, chainId: number }} unsigned
 * @param {import('ethers').Signer} signer
 * @returns {Promise<object>} signed delegation (unsigned + signature)
 */
export async function signDelegation(unsigned, signer) {
	// getDelegationManager throws if no real deployment is configured — this
	// prevents EIP-712 signatures from binding to the zero address, which
	// would silently authorize an unowned contract on every chain.
	const verifyingContract = getDelegationManager(unsigned.chainId);
	const domain = {
		name: 'DelegationManager',
		version: '1',
		chainId: unsigned.chainId,
		verifyingContract,
	};

	const types = {
		Caveat: [
			{ name: 'enforcer', type: 'address' },
			{ name: 'terms', type: 'bytes' },
			{ name: 'args', type: 'bytes' },
		],
		Delegation: [
			{ name: 'delegate', type: 'address' },
			{ name: 'delegator', type: 'address' },
			{ name: 'authority', type: 'bytes32' },
			{ name: 'caveats', type: 'Caveat[]' },
			{ name: 'salt', type: 'uint256' },
		],
	};

	const value = {
		delegate: unsigned.delegate,
		delegator: unsigned.delegator,
		authority: unsigned.authority,
		caveats: unsigned.caveats,
		salt: unsigned.salt,
	};

	const signature = await signer.signTypedData(domain, types, value);
	return { ...unsigned, signature };
}

/**
 * Check on-chain whether a delegation hash is still active.
 *
 * @param {object} opts
 * @param {string}   opts.hash     Delegation hash (keccak256, hex)
 * @param {number}   opts.chainId  EVM chain ID
 * @param {string}   [opts.rpcUrl] RPC endpoint URL
 * @returns {Promise<{ valid: boolean; reason?: string }>}
 */
export async function isDelegationValid({ hash, chainId, rpcUrl }) {
	const url = rpcUrl ?? (typeof process !== 'undefined' ? process.env[`RPC_URL_${chainId}`] : null);
	if (!url) {
		throw new PermissionError(
			'chain_not_supported',
			`No RPC URL available for chain ${chainId}. Pass rpcUrl or set RPC_URL_${chainId} env var.`,
		);
	}
	let managerAddr;
	try {
		managerAddr = getDelegationManager(chainId);
	} catch (err) {
		throw new PermissionError('chain_not_supported', err.message);
	}

	// eth_call: isDelegationDisabled(bytes32)
	const callData = '0x' + 'a1a5bdd0' + hash.replace('0x', '').padStart(64, '0');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'eth_call',
			params: [{ to: managerAddr, data: callData }, 'latest'],
		}),
	});
	const json = await res.json();
	const disabled = json.result === '0x' + '1'.padStart(64, '0');
	return disabled ? { valid: false, reason: 'delegation_revoked' } : { valid: true };
}

/**
 * Convert a signed delegation to the `permissions.delegations[]` entry shape
 * used in the agent manifest (`agent-manifest/0.2`).
 *
 * @param {{ chainId: number, delegator: string, delegate: string, hash: string, scope?: object }} signed
 * @returns {{ chainId: number, delegator: string, delegate: string, hash: string, scope: object }}
 */
export function delegationToManifestEntry({ chainId, delegator, delegate, hash, scope = {} }) {
	return { chainId, delegator, delegate, hash, scope };
}
