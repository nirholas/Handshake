/**
 * hood402 — the x402 payment rail for USDG on Robinhood Chain.
 *
 * This root entry exports the protocol primitives (types, encoding, the
 * `exact`/EIP-3009 scheme, verify + settle, the network registry, and a
 * facilitator HTTP client). Framework middleware lives under `hood402/server`
 * and the paying fetch wrapper under `hood402/client`.
 */

export * from './types.js'
export * from './errors.js'
export * from './networks.js'
export * from './challenge.js'
export * from './abi.js'

export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  usdgDomain,
  randomNonce,
  authorizationMessage,
  verifyAuthorizationSignature,
  isWellFormedPayload,
  validateStructural,
} from './scheme/exact.js'

export {
  encodeBase64Json,
  decodeBase64Json,
  encodePaymentHeader,
  decodePaymentHeader,
  encodeSettlementHeader,
  decodeSettlementHeader,
} from './scheme/encoding.js'

export { verifyPayment, type HoodReader, type VerifyOptions } from './verify.js'
export {
  settlePayment,
  type SettleOptions,
  type HoodBroadcaster,
  type HoodConfirmer,
} from './settle.js'
export { FacilitatorClient, type FacilitatorClientOptions } from './facilitator-client.js'
