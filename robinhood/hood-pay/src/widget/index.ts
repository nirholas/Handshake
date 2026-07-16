/**
 * hood-pay/widget - the embeddable checkout, as an ESM module for bundler
 * users. Script-tag users load `dist/hood-pay.min.js` instead, which
 * exposes `window.HoodPay` and auto-mounts `[data-hoodpay]` elements.
 *
 * @packageDocumentation
 */

export { mountCheckout, validateCheckoutConfig } from './widget.js'
export type { CheckoutConfig, CheckoutHandle, CheckoutReceipt, CheckoutState } from './widget.js'
export { ensureStyles, WIDGET_CSS } from './styles.js'
export { decodePaymentRequest, encodePaymentRequest, paymentLinkUrl } from '../request.js'
export type { PaymentRequest } from '../request.js'
