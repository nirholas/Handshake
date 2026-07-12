import { getAddress, type Address } from 'viem'
import { eip3009Abi, erc20Abi } from './abi.js'
import { requireNetwork, type HoodNetwork } from './networks.js'
import { validateStructural, verifyAuthorizationSignature } from './scheme/exact.js'
import type { PaymentPayload, PaymentRequirements, VerifyResult } from './types.js'

/**
 * The narrow slice of a viem `PublicClient` verification needs. Typing it
 * structurally (rather than importing the full client) keeps the state machine
 * unit-testable with a lightweight stub.
 */
export interface HoodReader {
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

export interface VerifyOptions {
  payload: PaymentPayload
  requirements: PaymentRequirements
  /** RPC reader for on-chain checks. Omit to run structure + signature only. */
  reader?: HoodReader
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: number
  /** Pre-resolved network (defaults to resolving from the payload). */
  network?: HoodNetwork
}

/**
 * Verify a payment against a requirement. Runs, in order:
 *  1. structure + scheme/network/asset/recipient/amount/expiry (pure)
 *  2. EIP-3009 signature recovery to the payer (pure crypto, no RPC)
 *  3. replay: the authorization nonce has not already been used (RPC)
 *  4. balance: the payer holds enough USDG (RPC)
 *
 * Steps 3–4 run only when a `reader` is supplied. This is the state machine the
 * unit suite exercises: malformed, replay, expiry, wrong-chain, underpayment,
 * bad-signature, insufficient-funds each surface a distinct `invalidReason`.
 */
export async function verifyPayment(opts: VerifyOptions): Promise<VerifyResult> {
  const { payload, requirements, reader, now } = opts

  // 1. Structural checks (pure).
  const structural = validateStructural(payload, requirements, now)
  if (!structural.isValid) return structural

  const net = opts.network ?? requireNetwork(payload.network)
  const auth = payload.payload.authorization

  // 2. Signature recovers to the payer.
  const sigOk = await verifyAuthorizationSignature(net, auth, payload.payload.signature)
  if (!sigOk) return { isValid: false, invalidReason: 'invalid_signature' }

  const payer = getAddress(auth.from) as Address
  if (!reader) return { isValid: true, payer }

  // 3. Replay protection — the nonce must be unused.
  const used = (await reader.readContract({
    address: net.usdg,
    abi: eip3009Abi,
    functionName: 'authorizationState',
    args: [payer, auth.nonce],
  })) as boolean
  if (used) return { isValid: false, invalidReason: 'authorization_already_used' }

  // 4. Balance — the payer can cover the payment.
  const balance = (await reader.readContract({
    address: net.usdg,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [payer],
  })) as bigint
  if (balance < BigInt(auth.value)) {
    return { isValid: false, invalidReason: 'insufficient_funds' }
  }

  return { isValid: true, payer }
}
