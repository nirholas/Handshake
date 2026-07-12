import { paymentMiddleware } from 'x402-hono'
import type { RoutesConfig } from 'x402-hono'
import type { FacilitatorConfig } from 'x402/types'
import { env, paymentsEnabled } from './env.js'

/**
 * Per-route USD prices for paid endpoints (x402-hono accepts `"$0.001"` style
 * strings). Kept in one place so pricing docs/OpenAPI/README can import it.
 */
export const PRICES = {
  portfolio: '$0.002',
  stockHistory: '$0.005',
  equities: '$0.01',
  firehoseToken: '$0.01', // one-time metered session grant; the session then streams free over the WS
} as const

function facilitatorConfig(): FacilitatorConfig | undefined {
  if (env.x402Network === 'base' && env.cdpApiKeyId && env.cdpApiKeySecret) {
    // Base mainnet USDC settlement via the CDP facilitator.
    return {
      url: 'https://api.cdp.coinbase.com/platform/v2/x402' as FacilitatorConfig['url'],
      createAuthHeaders: async () => ({
        verify: { Authorization: `Bearer ${env.cdpApiKeyId}:${env.cdpApiKeySecret}` },
        settle: { Authorization: `Bearer ${env.cdpApiKeyId}:${env.cdpApiKeySecret}` },
      }),
    }
  }
  // base-sepolia default: the public x402.org facilitator (or an operator override).
  return { url: env.x402FacilitatorUrl as FacilitatorConfig['url'] }
}

/**
 * Build the x402 Hono middleware for this deployment's paid routes, or `null`
 * when no `X402_PAY_TO` is configured (free-tier-only deployment). Route
 * handlers still check `paymentsEnabled()` themselves so they can return a
 * clean structured 503 instead of a generic middleware bypass.
 */
export function buildX402Middleware() {
  if (!paymentsEnabled()) return null

  const routes: RoutesConfig = {
    '/v1/portfolio/*': {
      price: PRICES.portfolio,
      network: env.x402Network,
      config: { description: 'Multiplier-correct Robinhood Chain portfolio valuation' },
    },
    '/v1/stocks/*/history': {
      price: PRICES.stockHistory,
      network: env.x402Network,
      config: { description: 'Deep OHLCV history for one Stock Token' },
    },
    '/v1/equities*': {
      price: PRICES.equities,
      network: env.x402Network,
      config: { description: 'Cross-venue tokenized-equity price comparison' },
    },
    '/v1/firehose': {
      price: PRICES.firehoseToken,
      network: env.x402Network,
      config: { description: 'Metered session token for the /v1/ws real-time firehose' },
    },
  }

  return paymentMiddleware(env.x402PayTo as `0x${string}`, routes, facilitatorConfig())
}
