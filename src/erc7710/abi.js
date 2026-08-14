/**
 * ERC-7710 DelegationManager ABIs and canonical deployments.
 *
 * Addresses sourced from @metamask/delegation-deployments v1.2.0 (DEPLOYMENTS_1_3_0).
 * ABI verified against @metamask/delegation-abis v1.0.0 DelegationManager.cjs.
 * No mainnet defaults per project policy.
 *
 * Only constants and pure encoders live here — no signing, no RPC calls.
 * See src/permissions/toolkit.js for signing + redemption logic.
 */

import { AbiCoder } from 'ethers';

// DelegationManager deployment addresses, keyed by numeric chainId.
// All supported chains use the same address (CREATE2 deterministic, DEPLOYMENTS_1_3_0).
// Source: @metamask/delegation-deployments v1.2.0, fetched 2026-04-18.
export const DELEGATION_MANAGER_DEPLOYMENTS = {
	// Mainnets
	1: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Ethereum mainnet
	8453: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Base mainnet
	// Testnets
	84532: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Base Sepolia
	11155111: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Sepolia
	421614: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Arbitrum Sepolia
	11155420: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', // Optimism Sepolia
};

// Human-readable ethers v6 ABI strings for DelegationManager.
// Verified against @metamask/delegation-abis v1.0.0.
export const DELEGATION_MANAGER_ABI = [
	// Redeem one or more delegations to execute calls
	'function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas) external',

	// Disable (revoke) a delegation — caller must be the delegator
	'function disableDelegation(tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) _delegation) external',

	// Public mapping: true if the delegation hash has been disabled on-chain
	// The revocation getter. This exact name is what every caller must use: an
	// ethers Contract resolves an unknown method to undefined, so a near-miss
	// spelling throws "not a function" at call time rather than failing loudly here.
	'function disabledDelegations(bytes32 delegationHash) external view returns (bool isDisabled)',

	// Returns the keccak256 hash for a delegation (used for revoke checks and signing)
	'function getDelegationHash(tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) _input) external pure returns (bytes32)',

	// --- Events ---
	'event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)',
	'event DisabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)',
	'event EnabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)',
];

// Caveat enforcer addresses per chain — enforcer name → { chainId: address }.
// Addresses are identical on all supported chains (CREATE2 deterministic, DEPLOYMENTS_1_3_0).
// Source: @metamask/delegation-deployments v1.2.0, fetched 2026-04-18.
const _CHAINS = [1, 8453, 11155111, 84532, 421614, 11155420];
const _addr = (a) => Object.fromEntries(_CHAINS.map((id) => [id, a]));
export const CAVEAT_ENFORCERS = {
	AllowedCalldataEnforcer: _addr('0xc2b0d624c1c4319760C96503BA27C347F3260f55'),
	AllowedMethodsEnforcer: _addr('0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5'),
	AllowedTargetsEnforcer: _addr('0x7F20f61b1f09b08D970938F6fa563634d65c4EeB'),
	ERC20TransferAmountEnforcer: _addr('0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc'),
	ERC20PeriodTransferEnforcer: _addr('0x474e3Ae7E169e940607cC624Da8A15Eb120139aB'),
	LimitedCallsEnforcer: _addr('0x04658B29F6b82ed55274221a06Fc97D318E25416'),
	NativeTokenTransferAmountEnforcer: _addr('0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320'),
	NativeTokenPeriodTransferEnforcer: _addr('0x9BC0FAf4Aca5AE429F4c06aEEaC517520CB16BD9'),
	TimestampEnforcer: _addr('0x1046bb45C8d673d4ea75321280DB34899413c069'),
	NonceEnforcer: _addr('0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f'),
	ValueLteEnforcer: _addr('0x92Bf12322527cAA612fd31a0e810472BBB106A8F'),
};

// bytes32 sentinel used as `authority` for root (non-chained) delegations.
export const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// EIP-712 type hashes (from @metamask/delegation-core v1.1.0).
export const DELEGATION_TYPEHASH =
	'0x88c1d2ecf185adf710588203a5f263f0ff61be0d33da39792cde19ba9aa4331e';
export const CAVEAT_TYPEHASH = '0x80ad7e1b04ee6d994a125f4714ca0720908bd80ed16063ec8aee4b88e9253e2d';

// EIP-712 domain builder for delegation signing.
// NAME = 'DelegationManager', DOMAIN_VERSION = '1' per on-chain constants.
export function EIP712_DOMAIN({ chainId, verifyingContract }) {
	return {
		name: 'DelegationManager',
		version: '1',
		chainId,
		verifyingContract,
	};
}

// EIP-712 type definitions for signing delegations.
// `signature` is excluded — it is what we are computing.
export const DELEGATION_TYPES = {
	Delegation: [
		{ name: 'delegate', type: 'address' },
		{ name: 'delegator', type: 'address' },
		{ name: 'authority', type: 'bytes32' },
		{ name: 'caveats', type: 'Caveat[]' },
		{ name: 'salt', type: 'uint256' },
	],
	Caveat: [
		{ name: 'enforcer', type: 'address' },
		{ name: 'terms', type: 'bytes' },
		{ name: 'args', type: 'bytes' },
	],
};

/**
 * ABI-encode an array of caveats into the on-chain format.
 * @param {{ enforcer: string, terms: string, args: string }[]} caveats
 * @returns {string} ABI-encoded bytes
 */
export function encodeCaveats(caveats) {
	const coder = AbiCoder.defaultAbiCoder();
	return coder.encode(
		['tuple(address enforcer, bytes terms, bytes args)[]'],
		[caveats.map((c) => [c.enforcer, c.terms || '0x', c.args || '0x'])],
	);
}

/**
 * ABI-encode a delegation chain (array of signed delegations) into the bytes
 * format expected by DelegationManager.redeemDelegations permissionContexts[i].
 * For a direct root delegation, pass a single-element array.
 * @param {{ delegate: string, delegator: string, authority: string, caveats: object[], salt: string|bigint, signature: string }[]} delegations
 * @returns {string} ABI-encoded bytes
 */
export function encodePermissionContext(delegations) {
	const coder = AbiCoder.defaultAbiCoder();
	const tuples = delegations.map((d) => [
		d.delegate,
		d.delegator,
		d.authority || ROOT_AUTHORITY,
		(d.caveats || []).map((c) => [c.enforcer, c.terms || '0x', c.args || '0x']),
		BigInt(d.salt ?? 0),
		d.signature || '0x',
	]);
	return coder.encode(
		[
			'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]',
		],
		[tuples],
	);
}

/**
 * ABI-encode a batch of calls into the Execution[] format expected by
 * DelegationManager.redeemDelegations executionCallDatas[i].
 * @param {{ to: string, value: string, data: string }[]} calls
 * @returns {{ to: string, value: bigint, data: string }[]} tuple array (passed directly, not encoded)
 */
export function buildExecutionTuples(calls) {
	return calls.map((c) => ({
		to: c.to,
		value: BigInt(c.value || '0'),
		data: c.data || '0x',
	}));
}
