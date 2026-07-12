import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { ApiError, toApiError } from '../lib/errors.js'
import { paymentsEnabled } from '../lib/env.js'
import { PRICES } from '../lib/x402.js'
import { SymbolParam, AddressParam, HistoryQuery, EquitiesListQuery, ErrorSchema, LOOKBACK_BLOCKS } from '../schemas.js'
import { getPortfolioValuation } from '../services/portfolio.js'
import { getStockHistory } from '../services/stocks.js'
import { getEquity, listEquities } from '../services/equities.js'
import { mintSession } from '../lib/firehose-session.js'
import { withMeta } from '../lib/response.js'

export const paidRoutes = new OpenAPIHono()

const JsonBody = z.record(z.string(), z.unknown())

function fail(err: unknown) {
  const apiErr = toApiError(err)
  return { status: apiErr.status, body: apiErr.toBody() } as const
}

// ---- /v1/portfolio/:address ----
paidRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/portfolio/{address}',
    tags: ['Paid'],
    summary: `Multiplier-correct portfolio valuation (x402, ${PRICES.portfolio})`,
    request: { params: AddressParam },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Portfolio' },
      400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid address' },
      503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Payments not configured' },
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), 503)
    }
    const { address } = c.req.valid('param')
    try {
      return c.json(await getPortfolioValuation(address))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/stocks/:symbol/history ----
paidRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/stocks/{symbol}/history',
    tags: ['Paid'],
    summary: `Deep OHLCV history for one Stock Token (x402, ${PRICES.stockHistory})`,
    request: { params: SymbolParam, query: HistoryQuery },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'History' },
      404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unknown symbol / no history' },
      503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Payments not configured' },
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), 503)
    }
    const { symbol } = c.req.valid('param')
    const { interval, lookback } = c.req.valid('query')
    const lookbackBlocks = LOOKBACK_BLOCKS[lookback ?? '7d'] ?? LOOKBACK_BLOCKS['7d']!
    try {
      return c.json(await getStockHistory(symbol, interval ?? '1h', lookbackBlocks))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/equities ----
paidRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/equities',
    tags: ['Paid'],
    summary: `Cross-venue tokenized-equity spreads: Robinhood Chain vs xStocks vs Ondo (x402, ${PRICES.equities})`,
    request: { query: EquitiesListQuery },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Cross-venue list' },
      503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Payments not configured' },
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), 503)
    }
    const { limit } = c.req.valid('query')
    try {
      return c.json(await listEquities(limit ?? 10))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/equities/:symbol ----
paidRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/equities/{symbol}',
    tags: ['Paid'],
    summary: `Cross-venue price for one ticker (x402, ${PRICES.equities})`,
    request: { params: SymbolParam },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Cross-venue row' },
      404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unknown symbol' },
      503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Payments not configured' },
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), 503)
    }
    const { symbol } = c.req.valid('param')
    try {
      return c.json(await getEquity(symbol))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/firehose (mint a metered WS session token) ----
paidRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/firehose',
    tags: ['Paid'],
    summary: `Mint a metered session token for the real-time /v1/ws firehose (x402, ${PRICES.firehoseToken})`,
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Session token' },
      503: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Payments not configured' },
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), 503)
    }
    const session = mintSession()
    return c.json(
      withMeta(
        {
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          wsUrl: `wss://{host}/v1/ws?token=${session.token}`,
          channels: ['firehose', 'launches', 'trades', 'ticks'],
          note: 'Connect within the token TTL. One paid mint grants ~10 minutes of streaming on any subset of channels via ?channels=firehose,ticks.',
        },
        ['robinhood-chain-sequencer'],
      ),
    )
  },
)
