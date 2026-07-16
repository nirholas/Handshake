import type { Address, Hex } from 'viem'
import { buildTransferTx, type UnsignedCall } from '../tx.js'
import type { PaymentResult } from './types.js'

/**
 * Refund helpers. hood-pay never holds the merchant's keys: `buildRefundTx`
 * produces the unsigned ERC-20 transfer for ANY signer, and `sendRefund`
 * drives a viem WalletClient the merchant supplies (key from
 * `ROBINHOOD_CHAIN_PRIVATE_KEY` or a signer service - never from this
 * library).
 *
 * Semantics (documented in docs/verify.html):
 * - `overpaid` invoices: refund the overage with {@link refundOverageTx}.
 * - `underpaid` invoices past their window: refund the full received amount
 *   (the sale did not happen) with {@link refundReceivedTx}.
 * - Full refunds of settled sales: `buildRefundTx(token, payer, expectedRaw)`.
 */

/** Unsigned ERC-20 transfer sending `rawAmount` of `token` back to `to`. */
export function buildRefundTx(token: Address, to: Address, rawAmount: bigint): UnsignedCall {
  if (rawAmount <= 0n) throw new RangeError('refund amount must be positive')
  return buildTransferTx(token, to, rawAmount)
}

/** Unsigned refund of an overpaid invoice's overage. Throws unless overpaid. */
export function refundOverageTx(token: Address, result: PaymentResult): UnsignedCall {
  if (result.status !== 'overpaid' || result.overageRaw <= 0n) {
    throw new RangeError(`invoice is ${result.status}, not overpaid - nothing to refund`)
  }
  if (!result.payer) throw new RangeError('cannot refund: no payer attributed')
  return buildRefundTx(token, result.payer, result.overageRaw)
}

/** Unsigned refund of everything an underpaid/abandoned invoice received. */
export function refundReceivedTx(token: Address, result: PaymentResult): UnsignedCall {
  if (result.receivedRaw <= 0n) throw new RangeError('nothing received - nothing to refund')
  if (!result.payer) throw new RangeError('cannot refund: no payer attributed')
  return buildRefundTx(token, result.payer, result.receivedRaw)
}

/** The slice of a viem WalletClient a refund needs (stub-friendly). */
export interface RefundSender {
  sendTransaction(args: { to: Address; data: Hex; value: bigint }): Promise<Hex>
}

/** Sign + broadcast a refund with the merchant's own wallet client. */
export async function sendRefund(wallet: RefundSender, call: UnsignedCall): Promise<Hex> {
  return wallet.sendTransaction({ to: call.to, data: call.data, value: call.value })
}
