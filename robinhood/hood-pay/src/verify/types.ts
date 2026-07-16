import type { Address, Hex } from 'viem'

/** Lifecycle of a hood-pay invoice, as the verifier sees it. */
export type PaymentStatus =
  | 'pending' // nothing attributable received yet
  | 'underpaid' // attributable value received, but less than expected
  | 'paid' // exactly the expected value received
  | 'overpaid' // more than expected received - flagged for refund of the overage
  | 'expired' // watch window closed with nothing received
  | 'refunded' // merchant refunded the buyer (ledger-only state)

/** One on-chain transfer/route event attributed to an invoice. */
export interface MatchedTransfer {
  txHash: Hex
  logIndex: number
  blockNumber: bigint
  blockHash: Hex
  /** Buyer address (Transfer `from` / PaymentReceived `payer`). */
  payer: Address
  /** Raw token units moved in this event. */
  amountRaw: bigint
}

/** Result of {@link awaitPayment} / {@link checkPayment}. */
export interface PaymentResult {
  status: PaymentStatus
  /** Raw token units the invoice expects. */
  expectedRaw: bigint
  /** Raw token units attributed so far. */
  receivedRaw: bigint
  /** Overage (receivedRaw - expectedRaw) when overpaid, else 0n. */
  overageRaw: bigint
  /** Buyer address, once at least one transfer is attributed. */
  payer?: Address
  /** Every attributed on-chain event, confirmation-depth safe. */
  transfers: MatchedTransfer[]
  /** Router-mode reference this result settles, when applicable. */
  reference?: Hex
}
