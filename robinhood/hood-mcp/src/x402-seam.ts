/**
 * Optional x402 monetization seam for the HTTP transport.
 *
 * Design contract: the free data tools are ALWAYS free. This seam exists only
 * to paywall a future set of expensive tools (deep history, firehose) once the
 * sibling `hood402` package (prompt 05, USDG-on-Robinhood-Chain x402 rail)
 * lands. Until then it is inert and documented.
 *
 * When `hood402` is installed AND `HOOD_MCP_PAYWALL_PRICE` + `HOOD_MCP_PAY_TO`
 * are set, {@link applyPaywall} attaches its Express middleware to the MCP HTTP
 * route so that any tool named in {@link PAID_TOOLS} requires an x402 payment.
 * If `hood402` cannot be resolved, it logs once to stderr and stays open — the
 * server never fails closed on a missing optional dependency.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Tools gated behind x402 when the paywall is active. Empty today: this server
 * ships only free tools. Add a tool name here the day a metered tool exists.
 */
export const PAID_TOOLS: readonly string[] = []

export interface PaywallConfig {
  price?: string
  payTo?: string
}

export function readPaywallConfig(env: NodeJS.ProcessEnv = process.env): PaywallConfig {
  return { price: env.HOOD_MCP_PAYWALL_PRICE, payTo: env.HOOD_MCP_PAY_TO }
}

let warned = false

/**
 * Attempt to attach the hood402 paywall middleware. Returns an Express-style
 * `(req, res, next)` middleware. When the paywall is not configured or hood402
 * is not installed, returns a pass-through so the caller can always `use()` it.
 */
export async function loadPaywallMiddleware(
  config: PaywallConfig,
): Promise<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> {
  const passthrough = (_req: IncomingMessage, _res: ServerResponse, next: () => void) => next()

  if (!config.price || !config.payTo || PAID_TOOLS.length === 0) return passthrough

  try {
    // Resolved dynamically so hood402 stays an OPTIONAL dependency — its
    // absence must never break the free server. The specifier is built at
    // runtime so the type-checker does not require the module to be present.
    const specifier = ['hood402', 'server'].join('/')
    const mod = (await import(specifier)) as {
      paywall?: (opts: { price: string; payTo: string; network: string }) => (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void,
      ) => void
    }
    if (typeof mod.paywall !== 'function') return passthrough
    return mod.paywall({ price: config.price, payTo: config.payTo, network: 'robinhood' })
  } catch {
    if (!warned) {
      warned = true
      process.stderr.write(
        '[hood-mcp] HOOD_MCP_PAYWALL_* is set but the optional `hood402` package is not installed; ' +
          'serving all tools free. Install hood402 to enable metered paid tools.\n',
      )
    }
    return passthrough
  }
}
