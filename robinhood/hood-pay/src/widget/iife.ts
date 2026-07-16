import { decodePaymentRequest, encodePaymentRequest, paymentLinkUrl } from '../request.js'
import { mountCheckout, validateCheckoutConfig, type CheckoutConfig } from './widget.js'

/**
 * IIFE entry for script-tag embedding (built to `dist/hood-pay.min.js`).
 *
 * Auto-mount: any element carrying `data-hoodpay` is mounted on
 * DOMContentLoaded from its data attributes:
 *
 *   <div data-hoodpay
 *        data-pay-to="0x…"
 *        data-amount="12.50"
 *        data-network="mainnet"
 *        data-memo="Invoice 7"></div>
 *   <script src="https://nirholas.github.io/hood-pay/hood-pay.min.js"></script>
 *
 * Router mode adds `data-reference` + `data-router`; token overrides use
 * `data-token-address` / `data-token-symbol` / `data-token-decimals`.
 */

function configFrom(el: HTMLElement): CheckoutConfig {
  const d = el.dataset
  const config: CheckoutConfig = {
    payTo: d.payTo ?? '',
    amount: d.amount ?? '',
  }
  if (d.network === 'mainnet' || d.network === 'testnet') config.network = d.network
  if (d.memo) config.memo = d.memo
  if (d.reference) config.reference = d.reference
  if (d.router) config.router = d.router
  if (d.tokenAddress && d.tokenSymbol && d.tokenDecimals) {
    config.token = {
      address: d.tokenAddress,
      symbol: d.tokenSymbol,
      decimals: Number(d.tokenDecimals),
    }
  }
  return config
}

function autoMount(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-hoodpay]'))) {
    if (el.dataset.hoodpayMounted === 'true') continue
    el.dataset.hoodpayMounted = 'true'
    try {
      mountCheckout(el, configFrom(el))
    } catch (error) {
      el.textContent = `hood-pay: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

const api = {
  version: '0.1.0',
  mount: mountCheckout,
  validateConfig: validateCheckoutConfig,
  decodePaymentRequest,
  encodePaymentRequest,
  paymentLinkUrl,
}

declare global {
  interface Window {
    HoodPay: typeof api
  }
}

window.HoodPay = api

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoMount, { once: true })
} else {
  autoMount()
}
