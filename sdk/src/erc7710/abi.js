/**
 * ERC-7710 / MetaMask Delegation Toolkit ABIs and addresses.
 *
 * Source of deployment addresses:
 *   https://github.com/MetaMask/delegation-framework/blob/main/documents/deployments
 *
 * Authoritative deployments are tracked in env vars so this SDK can be used
 * against any chain the MetaMask delegation framework has been deployed to,
 * including networks the SDK was written before. Set:
 *
 *   THREE_WS_DELEGATION_MANAGER_<chainId>=0x…
 *   THREE_WS_ENFORCER_<NAME>_<chainId>=0x…
 *
 * where <chainId> is the EVM chain id and <NAME> is one of
 * ALLOWED_TARGETS / ERC20_LIMIT / TIMESTAMP. The lookup helpers in this
 * file read the env first and fall back to a built-in registry only for
 * chains that explicitly have a real deployed address.
 *
 * Until a chain has either an env override or a registered address,
 * `getDelegationManager(chainId)` throws — preventing the SDK from
 * silently emitting transactions to the zero address.
 */

import { encodeAbiParameters, parseAbiParameters } from 'viem';

export const DELEGATION_MANAGER_ABI = [
	'function disableDelegation(bytes32 delegationHash) external',
	'function isDelegationDisabled(bytes32 delegationHash) external view returns (bool)',
	'event DisabledDelegation(bytes32 indexed delegationHash)',
];

/**
 * Known DelegationManager addresses keyed by chainId.
 * No entry == not deployed; consumers must set an env override or pass an
 * explicit address to the higher-level helpers.
 *
 * @type {Record<number, string>}
 */
export const DELEGATION_MANAGER_DEPLOYMENTS = Object.freeze({
	// Intentionally empty until an upstream deployment is published. Set the
	// `THREE_WS_DELEGATION_MANAGER_<chainId>` env to opt into a chain.
});

/**
 * Caveat enforcer contract addresses keyed by chainId.
 * Same opt-in convention as DELEGATION_MANAGER_DEPLOYMENTS.
 *
 * @type {Record<string, Record<number, string>>}
 */
export const CAVEAT_ENFORCERS = Object.freeze({
	AllowedTargetsEnforcer: {},
	ERC20LimitEnforcer: {},
	TimestampEnforcer: {},
});

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function envAddress(key) {
	if (typeof process === 'undefined' || !process.env) return null;
	const raw = process.env[key];
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
	if (trimmed.toLowerCase() === ZERO_ADDRESS) return null;
	return trimmed;
}

/**
 * Resolve the DelegationManager address for a chain. Throws if no real
 * deployment is configured (so the SDK cannot accidentally send a tx to the
 * zero address).
 *
 * @param {number} chainId
 * @returns {string} 0x EVM address
 */
export function getDelegationManager(chainId) {
	const env = envAddress(`THREE_WS_DELEGATION_MANAGER_${chainId}`);
	if (env) return env;
	const known = DELEGATION_MANAGER_DEPLOYMENTS[chainId];
	if (known && known.toLowerCase() !== ZERO_ADDRESS) return known;
	throw new Error(
		`erc7710_not_configured: no DelegationManager deployment for chainId ${chainId}. ` +
			`Set THREE_WS_DELEGATION_MANAGER_${chainId}=0x… to opt in.`,
	);
}

/**
 * Resolve a caveat enforcer address. Same gate as getDelegationManager.
 *
 * @param {'AllowedTargetsEnforcer'|'ERC20LimitEnforcer'|'TimestampEnforcer'} name
 * @param {number} chainId
 * @returns {string} 0x EVM address
 */
export function getCaveatEnforcer(name, chainId) {
	const map = {
		AllowedTargetsEnforcer: 'ALLOWED_TARGETS',
		ERC20LimitEnforcer: 'ERC20_LIMIT',
		TimestampEnforcer: 'TIMESTAMP',
	};
	const slug = map[name];
	if (!slug) throw new Error(`unknown_enforcer: ${name}`);
	const env = envAddress(`THREE_WS_ENFORCER_${slug}_${chainId}`);
	if (env) return env;
	const known = CAVEAT_ENFORCERS[name]?.[chainId];
	if (known && known.toLowerCase() !== ZERO_ADDRESS) return known;
	throw new Error(
		`erc7710_not_configured: no ${name} deployment for chainId ${chainId}. ` +
			`Set THREE_WS_ENFORCER_${slug}_${chainId}=0x… to opt in.`,
	);
}

/**
 * ABI-encode an array of caveat objects into bytes for the DelegationManager.
 * Each caveat is `(address enforcer, bytes terms, bytes args)`.
 *
 * @param {Array<{enforcer: string, terms: string, args: string}>} caveats
 * @returns {string} hex-encoded bytes
 */
export function encodeCaveats(caveats) {
	if (!Array.isArray(caveats)) {
		throw new TypeError('encodeCaveats: expected an array of caveats');
	}
	const normalised = caveats.map((c, i) => {
		if (!c || typeof c !== 'object') {
			throw new TypeError(`encodeCaveats: caveat[${i}] is not an object`);
		}
		if (!/^0x[0-9a-fA-F]{40}$/.test(c.enforcer || '')) {
			throw new TypeError(`encodeCaveats: caveat[${i}].enforcer must be a 0x EVM address`);
		}
		const terms = c.terms || '0x';
		const args = c.args || '0x';
		if (!/^0x[0-9a-fA-F]*$/.test(terms) || !/^0x[0-9a-fA-F]*$/.test(args)) {
			throw new TypeError(`encodeCaveats: caveat[${i}].terms / .args must be 0x-hex`);
		}
		return { enforcer: c.enforcer, terms, args };
	});
	return encodeAbiParameters(
		parseAbiParameters('(address enforcer, bytes terms, bytes args)[]'),
		[normalised],
	);
}
