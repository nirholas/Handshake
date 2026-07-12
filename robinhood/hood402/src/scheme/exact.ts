import {
  getAddress,
  isAddress,
  verifyTypedData,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem'
import type { HoodNetwork } from '../networks.js'
import { resolveNetwork } from '../networks.js'
import type {
  ExactEvmAuthorization,
  PaymentPayload,
  PaymentRequirements,
  VerifyResult,
} from '../types.js'
import { SCHEME, X402_VERSION } from '../types.js'

/** The EIP-712 type of the message a payer signs (EIP-3009). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Build the USDG EIP-712 domain for a network. */
export function usdgDomain(net: HoodNetwork): TypedDataDomain {
  return {
    name: net.usdgDomain.name,
    version: net.usdgDomain.version,
    chainId: net.chainId,
    verifyingContract: net.usdg,
  }
}

/** Generate a fresh random 32-byte EIP-3009 nonce (browser + Node safe). */
export function randomNonce(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = '0x'
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex as Hex
}

/** The EIP-712 message form of an authorization (bigints for numeric fields). */
export function authorizationMessage(auth: ExactEvmAuthorization) {
  return {
    from: getAddress(auth.from),
    to: getAddress(auth.to),
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  }
}

/**
 * Verify the EIP-3009 signature recovers to `authorization.from`. Uses viem's
 * `verifyTypedData` (which supports both EOA ECDSA and ERC-1271 smart-account
 * signatures). Read-only, no gas.
 */
export async function verifyAuthorizationSignature(
  net: HoodNetwork,
  auth: ExactEvmAuthorization,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(auth.from),
      domain: usdgDomain(net),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorizationMessage(auth),
      signature,
    })
  } catch {
    return false
  }
}

/** Shape-check a decoded payload — every field present and well-typed. */
export function isWellFormedPayload(p: unknown): p is PaymentPayload {
  if (!p || typeof p !== 'object') return false
  const pp = p as Record<string, unknown>
  if (pp['x402Version'] !== X402_VERSION) return false
  if (pp['scheme'] !== SCHEME) return false
  if (typeof pp['network'] !== 'string') return false
  const inner = pp['payload']
  if (!inner || typeof inner !== 'object') return false
  const ip = inner as Record<string, unknown>
  if (typeof ip['signature'] !== 'string') return false
  const auth = ip['authorization']
  if (!auth || typeof auth !== 'object') return false
  const a = auth as Record<string, unknown>
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof a[k] !== 'string') return false
  }
  if (!isAddress(a['from'] as string) || !isAddress(a['to'] as string)) return false
  return true
}

/**
 * Pure, RPC-free half of the verify state machine: check the payload's
 * structure against the requirement (scheme, network, asset, recipient,
 * amount, validity window). On-chain checks (balance, replay, simulation) are
 * layered on top in `verify.ts`.
 *
 * @param now Unix seconds — injectable for deterministic tests.
 */
export function validateStructural(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (payload.scheme !== requirements.scheme) {
    return { isValid: false, invalidReason: 'invalid_scheme' }
  }

  const payNet = resolveNetwork(payload.network)
  const reqNet = resolveNetwork(requirements.network)
  if (!payNet || !reqNet) {
    return { isValid: false, invalidReason: 'unsupported_network' }
  }
  if (payNet.chainId !== reqNet.chainId) {
    return { isValid: false, invalidReason: 'network_mismatch' }
  }

  const auth = payload.payload.authorization

  // Asset must be USDG for this network.
  if (getAddress(requirements.asset) !== getAddress(payNet.usdg)) {
    return { isValid: false, invalidReason: 'invalid_asset' }
  }

  // Payment must go to the required recipient.
  if (getAddress(auth.to) !== getAddress(requirements.payTo)) {
    return { isValid: false, invalidReason: 'invalid_recipient' }
  }

  // Amount must cover the price (exact scheme: value >= price).
  let value: bigint
  let required: bigint
  try {
    value = BigInt(auth.value)
    required = BigInt(requirements.maxAmountRequired)
  } catch {
    return { isValid: false, invalidReason: 'malformed_payment' }
  }
  if (value < required) {
    return { isValid: false, invalidReason: 'insufficient_amount' }
  }

  // Validity window.
  let validAfter: bigint
  let validBefore: bigint
  try {
    validAfter = BigInt(auth.validAfter)
    validBefore = BigInt(auth.validBefore)
  } catch {
    return { isValid: false, invalidReason: 'malformed_payment' }
  }
  const nowBig = BigInt(now)
  if (validBefore <= nowBig) {
    return { isValid: false, invalidReason: 'authorization_expired' }
  }
  if (validAfter > nowBig) {
    return { isValid: false, invalidReason: 'authorization_not_yet_valid' }
  }

  return { isValid: true, payer: getAddress(auth.from) as Address }
}
