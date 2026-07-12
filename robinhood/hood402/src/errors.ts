/**
 * Canonical `invalidReason` codes returned by verification and settlement.
 *
 * These mirror the x402 reference facilitator's vocabulary so that clients and
 * dashboards built for the wider ecosystem recognize hood402's responses.
 */
export type InvalidReason =
  | 'malformed_payment'
  | 'unsupported_scheme'
  | 'unsupported_network'
  | 'network_mismatch'
  | 'invalid_scheme'
  | 'invalid_signature'
  | 'invalid_recipient'
  | 'invalid_asset'
  | 'insufficient_amount'
  | 'authorization_expired'
  | 'authorization_not_yet_valid'
  | 'authorization_already_used'
  | 'insufficient_funds'
  | 'simulation_failed'
  | 'settlement_failed'

/** Human-readable one-liners for each reason (used in logs and docs). */
export const REASON_TEXT: Record<InvalidReason, string> = {
  malformed_payment: 'The X-PAYMENT header could not be decoded into a valid payment payload.',
  unsupported_scheme: 'The payment scheme is not supported (only "exact" is implemented).',
  unsupported_network: 'The payment network is not a known Robinhood Chain network.',
  network_mismatch: 'The payment network does not match the network the resource requires.',
  invalid_scheme: 'The payment scheme does not match the required scheme.',
  invalid_signature: 'The EIP-3009 signature is invalid or does not recover to the payer address.',
  invalid_recipient: 'The authorization pays a different address than the resource requires.',
  invalid_asset: 'The authorization is for a different token than the resource requires.',
  insufficient_amount: 'The authorized amount is less than the price of the resource.',
  authorization_expired: 'The authorization validBefore time has already passed.',
  authorization_not_yet_valid: 'The authorization validAfter time is in the future.',
  authorization_already_used: 'The authorization nonce has already been settled (replay).',
  insufficient_funds: 'The payer does not hold enough USDG to cover the payment.',
  simulation_failed: 'The settlement transaction reverted in simulation.',
  settlement_failed: 'The settlement transaction failed to broadcast or confirm.',
}

/** Error raised when a caller misconfigures hood402 (not a payment failure). */
export class Hood402ConfigError extends Error {
  override name = 'Hood402ConfigError'
}

/** Error raised by the client when a spend cap would be exceeded. */
export class SpendCapExceededError extends Error {
  override name = 'SpendCapExceededError'
  constructor(
    readonly origin: string,
    readonly attempted: string,
    readonly cap: string,
  ) {
    super(
      `hood402: payment of ${attempted} USDG to ${origin} would exceed the spend cap of ${cap} USDG for this origin`,
    )
  }
}
