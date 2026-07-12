import { parseSignature, type Address, type Hex } from 'viem'
import { eip3009Abi } from './abi.js'
import { requireNetwork, type HoodNetwork } from './networks.js'
import { verifyPayment, type HoodReader } from './verify.js'
import type { PaymentPayload, PaymentRequirements, SettleResult } from './types.js'

/** The slice of a viem `WalletClient` needed to broadcast settlement. */
export interface HoodBroadcaster {
  writeContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    chain?: unknown
    account?: unknown
  }): Promise<Hex>
}

/** The slice of a viem `PublicClient` needed to confirm settlement. */
export interface HoodConfirmer extends HoodReader {
  waitForTransactionReceipt(args: {
    hash: Hex
  }): Promise<{ status: 'success' | 'reverted'; transactionHash: Hex }>
}

export interface SettleOptions {
  payload: PaymentPayload
  requirements: PaymentRequirements
  /** Facilitator gas wallet that broadcasts the settlement transaction. */
  wallet: HoodBroadcaster
  /** Public client used to re-verify and to await the receipt. */
  reader: HoodConfirmer
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: number
  /** Pre-resolved network. */
  network?: HoodNetwork
  /** Re-verify immediately before broadcasting (default: true). */
  reverify?: boolean
}

/**
 * Settle a payment by calling `transferWithAuthorization` on USDG. The
 * facilitator pays gas; it cannot alter the amount or recipient — those are
 * bound into the signed authorization.
 *
 * The call is re-verified against chain state first (balance + replay), so a
 * nonce that was consumed between the initial 402 and settlement fails cleanly
 * instead of wasting gas on a guaranteed revert.
 */
export async function settlePayment(opts: SettleOptions): Promise<SettleResult> {
  const net = opts.network ?? requireNetwork(opts.payload.network)
  const reverify = opts.reverify ?? true

  if (reverify) {
    const v = await verifyPayment({
      payload: opts.payload,
      requirements: opts.requirements,
      reader: opts.reader,
      network: net,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    })
    if (!v.isValid) {
      return {
        success: false,
        errorReason: v.invalidReason ?? 'settlement_failed',
        network: net.id,
        ...(v.payer ? { payer: v.payer } : {}),
      }
    }
  }

  const auth = opts.payload.payload.authorization
  const { r, s, v, yParity } = parseSignature(opts.payload.payload.signature)
  const vByte = v !== undefined ? Number(v) : yParity + 27

  let hash: Hex
  try {
    hash = await opts.wallet.writeContract({
      address: net.usdg,
      abi: eip3009Abi,
      functionName: 'transferWithAuthorization',
      args: [
        auth.from,
        auth.to,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        vByte,
        r,
        s,
      ],
      chain: net.chain,
    })
  } catch (err) {
    return {
      success: false,
      errorReason: 'settlement_failed',
      network: net.id,
      payer: auth.from,
    }
  }

  const receipt = await opts.reader.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    return {
      success: false,
      errorReason: 'settlement_failed',
      network: net.id,
      payer: auth.from,
      transaction: receipt.transactionHash,
    }
  }

  return {
    success: true,
    transaction: receipt.transactionHash,
    network: net.id,
    payer: auth.from,
  }
}
