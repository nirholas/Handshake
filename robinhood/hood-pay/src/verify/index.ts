/**
 * hood-pay/verify - the merchant side: a reorg-safe on-chain payment
 * watcher, an idempotent SQLite ledger, signed webhooks, and refund
 * helpers. Node-only (the widget and link pages never import this).
 *
 * @packageDocumentation
 */

export { awaitPayment, checkPayment, createReader } from './watcher.js'
export type { AwaitPaymentOptions, ChainReader, WatchOptions, WatchSpec } from './watcher.js'

export type { MatchedTransfer, PaymentResult, PaymentStatus } from './types.js'

export { createLedger } from './ledger.js'
export type {
  CreateDirectInvoiceInput,
  CreateRouterInvoiceInput,
  Ledger,
  LedgerInvoice,
  WebhookDeliveryRecord,
} from './ledger.js'

export {
  createWebhookEmitter,
  signWebhook,
  verifyWebhookSignature,
  toWebhookEvent,
  SIGNATURE_HEADER,
} from './webhook.js'
export type {
  VerifyWebhookOptions,
  WebhookDeliveryResult,
  WebhookEmitterOptions,
  WebhookEvent,
} from './webhook.js'

export { buildRefundTx, refundOverageTx, refundReceivedTx, sendRefund } from './refund.js'
export type { RefundSender } from './refund.js'
