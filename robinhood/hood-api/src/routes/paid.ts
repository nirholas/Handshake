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
const errorResponse = { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error' } as const

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
      default: errorResponse,
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), apiErr.status)
    }
    const { address } = c.req.valid('param')
    try {
      return c.json(await getPortfolioValuation(address), 200)
    } catch (err) {
      const apiErr = toApiError(err)
      return c.json(apiErr.toBody(), apiErr.status)
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
      default: errorResponse,
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), apiErr.status)
    }
    const { symbol } = c.req.valid('param')
    const { interval, lookback } = c.req.valid('query')
    const lookbackBlocks = LOOKBACK_BLOCKS[lookback ?? '7d'] ?? LOOKBACK_BLOCKS['7d']!
    try {
      return c.json(await getStockHistory(symbol, interval ?? '1h', lookbackBlocks), 200)
    } catch (err) {
      const apiErr = toApiError(err)
      return c.json(apiErr.toBody(), apiErr.status)
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
      default: errorResponse,
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), apiErr.status)
    }
    const { limit } = c.req.valid('query')
    try {
      return c.json(await listEquities(limit ?? 10), 200)
    } catch (err) {
      const apiErr = toApiError(err)
      return c.json(apiErr.toBody(), apiErr.status)
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
      default: errorResponse,
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), apiErr.status)
    }
    const { symbol } = c.req.valid('param')
    try {
      return c.json(await getEquity(symbol), 200)
    } catch (err) {
      const apiErr = toApiError(err)
      return c.json(apiErr.toBody(), apiErr.status)
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
      default: errorResponse,
    },
  }),
  async (c) => {
    if (!paymentsEnabled()) {
      const apiErr = ApiError.paymentsDisabled()
      return c.json(apiErr.toBody(), apiErr.status)
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
      200,
    )
  },
)
