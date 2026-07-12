import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { ApiError } from './lib/errors.js'
import { env, paymentsEnabled } from './lib/env.js'
import { buildX402Middleware } from './lib/x402.js'
import { freeRoutes } from './routes/free.js'
import { paidRoutes } from './routes/paid.js'
import pkg from '../package.json' with { type: 'json' }

export function createApp() {
  const app = new OpenAPIHono()

  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }))

  // x402 payment gate mounts BEFORE the paid routes so unpaid requests never
  // reach a handler. Only registered when X402_PAY_TO is configured — without
  // it, paid routes fall straight through to their own 503 "not configured".
  const x402 = buildX402Middleware()
  if (x402) app.use('*', x402)

  app.route('/', freeRoutes)
  app.route('/', paidRoutes)

  app.notFound((c) =>
    c.json(
      {
        error: 'not_found',
        hint: `No route for ${c.req.method} ${c.req.path}. See /v1/openapi.json for the full endpoint list.`,
        docs: 'https://nirholas.github.io/hood-api/',
      },
      404,
    ),
  )

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400 | 404 | 502 | 503)
    console.error('[hood-api] unhandled error:', err)
    return c.json(
      { error: 'internal_error', hint: 'Unexpected server error. Please retry; if it persists, file an issue.', docs: 'https://github.com/nirholas/hood-api/issues' },
      500,
    )
  })

  app.doc31('/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'hood-api',
      version: pkg.version,
      description:
        'Hosted market-data API for Robinhood Chain (chain ID 4663): Stock Tokens with Chainlink + DEX ' +
        'premium/discount, memecoin launchpads, multiplier-correct portfolios, cross-venue tokenized-equity ' +
        'spreads, and a real-time firehose. Free tier is IP-rate-limited; paid endpoints are metered via x402.',
      license: { name: 'MIT' },
      contact: { name: 'nirholas', url: 'https://x.com/nichxbt' },
    },
    servers: [{ url: env.publicBaseUrl, description: paymentsEnabled() ? 'This deployment' : 'This deployment (payments disabled)' }],
    tags: [
      { name: 'Health', description: 'Liveness and status' },
      { name: 'Chain', description: 'Chain-wide stats' },
      { name: 'Stocks', description: 'Stock Token market data (free)' },
      { name: 'Coins', description: 'Memecoin launchpad data (free)' },
      { name: 'Paid', description: 'x402-metered endpoints' },
    ],
  })

  return app
}
