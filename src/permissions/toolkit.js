/**
 * ERC-7710 delegation toolkit — single facade over all delegation operations.
 * Consumers import from here; never import @metamask/delegation-toolkit directly.
 * Usable in both browser (wallet signer) and Node (relayer signer).
 *
 * Uses ethers v6 directly — @metamask/delegation-toolkit transitive deps exceed
 * 5 MB threshold (@metamask/delegation-abis alone is 6.2 MB unpacked).
 */

import {
	AbiCoder,
	Contract,
	getAddress,
	randomBytes,
	TypedDataEncoder,
} from 'ethers';
import { getEvmProvider, isRpcTransportError } from '../shared/evm-rpc-fallback.js';
import {
	CAVEAT_ENFORCERS,
	DELEGATION_MANAGER_ABI,
	DELEGATION_MANAGER_DEPLOYMENTS,
	DELEGATION_TYPES,
	EIP712_DOMAIN,
	ROOT_AUTHORITY,
} from '../erc7710/abi.js';

// ─── Error type ──────────────────────────────────────────────────────────────

/**
 * Typed error for all delegation operations.
 * `code` matches the canonical OAuth-style error codes from 00-README.md.
 */
export class PermissionError extends Error {
	/**
	 * @param {string} code - delegation_expired | delegation_revoked | scope_exceeded |
	 *   target_not_allowed | delegation_not_found | signature_invalid |
	 *   chain_not_supported | rate_limited
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'PermissionError';
	}
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * @param {unknown} addr
 * @param {string} label
 * @returns {string} EIP-55 checksummed address
 * @throws {PermissionError} signature_invalid
 */
function checksum(addr, label) {
	try {
		return getAddress(/** @type {string} */ (addr));
	} catch {
		throw new PermissionError('signature_invalid', `Invalid address for ${label}: ${addr}`);
	}
}

/**
 * @param {number} chainId
 * @returns {string} DelegationManager address
 * @throws {PermissionError} chain_not_supported
 */
function managerAddress(chainId) {
	const addr = DELEGATION_MANAGER_DEPLOYMENTS[chainId];
	if (!addr)
		throw new PermissionError(
			'chain_not_supported',
			`No DelegationManager deployment for chain ${chainId}`,
		);
	return addr;
}

/**
 * ABI-encode a delegation array into the bytes expected by permissionContexts[i].
 * Format: abi.encode(Delegation[]) per @metamask/delegation-core DELEGATION_ARRAY_ABI_TYPES.
 * @param {object[]} delegations
 * @returns {string} 0x-prefixed hex
 */
function encodePermissionContext(delegations) {
	const coder = AbiCoder.defaultAbiCoder();
	const tuples = delegations.map((d) => [
		d.delegate,
		d.delegator,
		d.authority ?? ROOT_AUTHORITY,
		(d.caveats ?? []).map((c) => [c.enforcer, c.terms ?? '0x', c.args ?? '0x']),
		d.salt ?? 0n,
		d.signature ?? '0x',
	]);
	return coder.encode(
		['tuple(address,address,bytes32,tuple(address,bytes,bytes)[],uint256,bytes)[]'],
		[tuples],
	);
}

/**
 * ERC-7579 packed execution calldata for a single call.
 * encodePacked(address target, uint256 value, bytes callData)
 * @param {string} to
 * @param {bigint|number|string} value
 * @param {string} data
 * @returns {string} 0x-prefixed hex
 */
function encodeSingleExecution(to, value, data) {
	const coder = AbiCoder.defaultAbiCoder();
	// abi.encode is safe here — ERC-7579's decodeSingle uses byte-slice offsets
	// but the MetaMask DelegationManager accepts standard abi.encode for single mode.
	return coder.encode(['address', 'uint256', 'bytes'], [to, value ?? 0n, data ?? '0x']);
}

// ERC-7579 single-call, default execution mode (callType=0x01, execType=0x00).
const SINGLE_DEFAULT_MODE = '0x0100000000000000000000000000000000000000000000000000000000000000';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build an unsigned delegation envelope ready to be EIP-712 signed.
 * Pure and synchronous — no network I/O.
 *
 * @param {{
 *   delegator: string,
 *   delegate:  string,
 *   caveats:   Array<{ enforcer: string, terms: string, args?: string }>,
 *   expiry:    number,
 *   chainId:   number,
 * }} opts
 * @returns {{
 *   delegate:  string,
 *   delegator: string,
 *   authority: string,
 *   caveats:   Array<{ enforcer: string, terms: string, args: string }>,
 *   salt:      bigint,
 *   expiry:    number,
 *   chainId:   number,
 * }}
 * @throws {PermissionError} signature_invalid | delegation_expired | chain_not_supported
 */
export function encodeScopedDelegation({ delegator, delegate, caveats, expiry, chainId }) {
	const delegatorAddr = checksum(delegator, 'delegator');
	const delegateAddr = checksum(delegate, 'delegate');

	if (delegateAddr === delegatorAddr) {
		throw new PermissionError('signature_invalid', 'delegate must differ from delegator');
	}
	if (!Array.isArray(caveats) || caveats.length < 1) {
		throw new PermissionError('signature_invalid', 'at least one caveat is required');
	}
	if (expiry <= Math.floor(Date.now() / 1000) + 60) {
		throw new PermissionError(
			'delegation_expired',
			'expiry must be at least 60 seconds in the future',
		);
	}

	managerAddress(chainId); // throws chain_not_supported if unknown

	const normalizedCaveats = caveats.map((c, i) => ({
		enforcer: checksum(c.enforcer, `caveats[${i}].enforcer`),
		terms: c.terms ?? '0x',
		args: c.args ?? '0x',
	}));

	// Cryptographically random 32-byte salt to prevent replay.
	const saltHex = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
	const salt = BigInt('0x' + saltHex);

	return {
		delegate: delegateAddr,
		delegator: delegatorAddr,
		authority: ROOT_AUTHORITY,
		caveats: normalizedCaveats,
		salt,
		expiry,
		chainId,
	};
}

/**
 * Sign a delegation using EIP-712.
 * Returns the delegation enriched with `signature` and `hash`.
 * Only the hash is safe to log — never log the signature itself.
 *
 * @param {{
 *   delegate:  string,
 *   delegator: string,
 *   authority: string,
 *   caveats:   Array<{ enforcer: string, terms: string, args: string }>,
 *   salt:      bigint,
 *   chainId:   number,
 * }} delegation - unsigned delegation from encodeScopedDelegation
 * @param {import('ethers').Signer} signer - ethers v6 signer (must support signTypedData)
 * @returns {Promise<{ signature: string, hash: string } & typeof delegation>}
 * @throws {PermissionError} chain_not_supported | signature_invalid
 */
export async function signDelegation(delegation, signer) {
	if (!signer) throw new PermissionError('signature_invalid', 'signer is required');

	const verifyingContract = managerAddress(delegation.chainId);
	const domain = EIP712_DOMAIN({ chainId: delegation.chainId, verifyingContract });

	const typedValue = {
		delegate: delegation.delegate,
		delegator: delegation.delegator,
		authority: delegation.authority ?? ROOT_AUTHORITY,
		caveats: delegation.caveats,
		salt: delegation.salt ?? 0n,
	};

	let signature;
	try {
		signature = await signer.signTypedData(domain, DELEGATION_TYPES, typedValue);
	} catch (err) {
		throw new PermissionError('signature_invalid', `EIP-712 signing failed: ${err.message}`);
	}

	// Compute hash locally using the same encoder ethers uses for signTypedData.
	const hash = TypedDataEncoder.hash(domain, DELEGATION_TYPES, typedValue);

	return { ...delegation, signature, hash };
}

/**
 * Redeem a signed delegation by submitting redeemDelegations to the DelegationManager.
 * Verifies on-chain that the delegation is not revoked before spending gas.
 *
 * @param {{
 *   delegation: object,
 *   calls:      Array<{ to: string, value?: bigint|number|string, data?: string }>,
 *   signer:     import('ethers').Signer,
 *   chainId:    number,
 * }} opts
 * @returns {Promise<{ txHash: string, receipt: object }>}
 * @throws {PermissionError} delegation_revoked | chain_not_supported | signature_invalid
 */
export async function redeemDelegation({ delegation, calls, signer, chainId }) {
	if (!signer) throw new PermissionError('signature_invalid', 'signer is required');
	if (!signer.provider)
		throw new PermissionError('chain_not_supported', 'signer has no provider attached');

	const addr = managerAddress(chainId);

	// Pre-flight: check delegation is not disabled on-chain.
	const dmRead = new Contract(addr, DELEGATION_MANAGER_ABI, signer.provider);
	const disabled = await dmRead.disabledDelegations(delegation.hash);
	if (disabled)
		throw new PermissionError('delegation_revoked', 'delegation has been revoked on-chain');

	// Build permissionContexts: one entry per call, each wrapping the same delegation chain.
	const permissionContext = encodePermissionContext([delegation]);
	const permissionContexts = calls.map(() => permissionContext);
	const modes = calls.map(() => SINGLE_DEFAULT_MODE);
	const executionCallDatas = calls.map((c) =>
		encodeSingleExecution(checksum(c.to, 'calls[].to'), c.value ?? 0n, c.data ?? '0x'),
	);

	const dmWrite = new Contract(addr, DELEGATION_MANAGER_ABI, signer);
	const tx = await dmWrite.redeemDelegations(permissionContexts, modes, executionCallDatas);
	const receipt = await tx.wait();

	return {
		txHash: tx.hash,
		receipt: {
			status: receipt.status,
			blockNumber: receipt.blockNumber,
			gasUsed: receipt.gasUsed.toString(),
		},
	};
}

/**
 * Read-only check that a delegation hash is valid on-chain.
 * Checks: not disabled on-chain. Pass `delegation` for expiry + signature checks.
 *
 * Three outcomes, not two: `valid: true`, `valid: false` with a reason that
 * names what is wrong with the delegation, or `valid: null` with
 * `reason: 'rpc_unavailable'` when the chain could not be reached at all. An
 * RPC outage is not evidence that a permission was revoked, and a caller that
 * treats null as false is choosing fail-closed deliberately.
 *
 * @param {{
 *   hash:        string,
 *   chainId:     number,
 *   rpcUrl?:     string,
 *   delegation?: object,
 * }} opts
 * @returns {Promise<{ valid: boolean|null, reason?: string }>}
 * @throws {PermissionError} chain_not_supported (if chain unknown)
 */
export async function isDelegationValid({ hash, chainId, rpcUrl, delegation }) {
	const addr = managerAddress(chainId); // throws if unsupported

	const pinned =
		rpcUrl ?? (typeof process !== 'undefined' ? process.env?.[`RPC_URL_${chainId}`] : undefined);

	let disabled;
	try {
		// Pinned URL first, then the same-origin proxy and the public hosts.
		const provider = await getEvmProvider(chainId, { primaryUrl: pinned || null });
		const dm = new Contract(addr, DELEGATION_MANAGER_ABI, provider);
		disabled = await dm.disabledDelegations(hash);
	} catch (err) {
		if (isRpcTransportError(err) || /no rpc configured/i.test(err?.message || '')) {
			return { valid: null, reason: 'rpc_unavailable' };
		}
		return { valid: false, reason: err?.message ?? String(err) };
	}
	if (disabled) return { valid: false, reason: 'delegation_revoked' };

	try {

		// Expiry check if full delegation object available.
		if (delegation?.expiry) {
			if (delegation.expiry <= Math.floor(Date.now() / 1000)) {
				return { valid: false, reason: 'delegation_expired' };
			}
		}

		// Signature recovery check if full delegation object available.
		if (delegation?.signature && delegation?.delegator) {
			const verifyingContract = addr;
			const domain = EIP712_DOMAIN({ chainId, verifyingContract });
			const typedValue = {
				delegate: delegation.delegate,
				delegator: delegation.delegator,
				authority: delegation.authority ?? ROOT_AUTHORITY,
				caveats: delegation.caveats,
				salt: delegation.salt,
			};
			const recovered = TypedDataEncoder.recoverAddress(
				domain,
				DELEGATION_TYPES,
				typedValue,
				delegation.signature,
			);
			if (recovered.toLowerCase() !== delegation.delegator.toLowerCase()) {
				return { valid: false, reason: 'signature_invalid' };
			}
		}

		return { valid: true };
	} catch (err) {
		return { valid: false, reason: err.message };
	}
}

/**
 * Map a signed delegation into the manifest permissions.delegations[] shape.
 * Pure and synchronous — no network I/O.
 *
 * @param {{
 *   chainId:   number,
 *   delegator: string,
 *   delegate:  string,
 *   hash:      string,
 *   uri?:      string,
 *   scope?:    { token: string, maxAmount: string, period: string, targets: string[], expiry: number },
 *   expiry?:   number,
 * }} signedDelegation
 * @returns {{
 *   chainId:   number,
 *   delegator: string,
 *   delegate:  string,
 *   hash:      string,
 *   uri?:      string,
 *   scope:     { token: string, maxAmount: string, period: string, targets: string[], expiry: number },
 * }}
 */
export function delegationToManifestEntry(signedDelegation) {
	const { chainId, delegator, delegate, hash, uri, scope, expiry } = signedDelegation;
	return {
		chainId,
		delegator,
		delegate,
		hash,
		...(uri ? { uri } : {}),
		scope: scope ?? {
			token: 'native',
			maxAmount: '0',
			period: 'once',
			targets: [],
			expiry: expiry ?? 0,
		},
	};
}

export { CAVEAT_ENFORCERS };
