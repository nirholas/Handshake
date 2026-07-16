/**
 * hood-pay - Stripe-Checkout-grade USDG payments on Robinhood Chain.
 *
 * Core module: networks, the reference/fingerprint scheme, payment
 * requests + link codec, and unsigned-tx builders. The merchant-side
 * watcher/webhook/ledger stack lives in `hood-pay/verify`; the embeddable
 * checkout in `hood-pay/widget` (or the prebuilt `dist/hood-pay.min.js`).
 *
 * @packageDocumentation
 */

// networks
export { networkInfo, explorerTxUrl, explorerAddressUrl } from './networks.js'
export type { HoodPayNetwork, NetworkInfo, PayToken } from './networks.js'

// reference scheme
export {
  newReference,
  isReference,
  randomDust,
  applyDust,
  splitDust,
  directCollisionProbability,
  referenceCollisionProbability,
  DUST_SLOTS,
  DUST_DIGITS,
  DUST_MODULUS,
} from './reference.js'

// payment requests + links
export {
  validatePaymentRequest,
  requestToken,
  requestRawAmount,
  formatRequestAmount,
  encodePaymentRequest,
  decodePaymentRequest,
  paymentLinkUrl,
  MAX_MEMO_LENGTH,
} from './request.js'
export type { PaymentRequest } from './request.js'

// unsigned transactions
export { buildTransferTx, buildApproveTx, buildRouterPayTx } from './tx.js'
export type { UnsignedCall } from './tx.js'

// ABIs
export { erc20Abi, hoodPayRouterAbi } from './abi.js'
