import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { ApiError, toApiError } from '../lib/errors.js'
import { nowIso } from '../lib/response.js'
import {
  SymbolParam,
  AddressParam,
  LaunchesQuery,
  CoinsQuery,
  ErrorSchema,
  LOOKBACK_BLOCKS,
} from '../schemas.js'
import { getChain } from '../services/chain.js'
import { listStocks, getStockDetail } from '../services/stocks.js'
import { listCoins, getCoinDetail } from '../services/coins.js'
import { getLaunches } from '../services/launches.js'
import { mainnetClient } from '../upstreams/rpc.js'
import { env } from '../lib/env.js'
import pkg from '../../package.json' with { type: 'json' }

export const freeRoutes = new OpenAPIHono()

const JsonBody = z.record(z.string(), z.unknown())

function fail(err: unknown) {
  const apiErr = toApiError(err)
  return { status: apiErr.status, body: apiErr.toBody() } as const
}

// ---- /v1/health ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/health',
    tags: ['Health'],
    summary: 'Service liveness + RPC reachability',
    responses: { 200: { content: { 'application/json': { schema: JsonBody } }, description: 'OK' } },
  }),
  async (c) => {
    let rpcOk = true
    let blockHeight: string | null = null
    try {
      blockHeight = (await mainnetClient().public.getBlockNumber()).toString()
    } catch {
      rpcOk = false
    }
    return c.json({
      status: rpcOk ? 'ok' : 'degraded',
      version: pkg.version,
      chainId: 4663,
      rpcOk,
      blockHeight,
      paymentsEnabled: env.x402PayTo.length > 0,
      asOf: nowIso(),
    })
  },
)

// ---- /v1/chain ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/chain',
    tags: ['Chain'],
    summary: 'Chain stats: block height, gas, TVL, ETH price',
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Chain stats' },
      502: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Upstream unavailable' },
    },
  }),
  async (c) => {
    try {
      return c.json(await getChain())
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/stocks ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/stocks',
    tags: ['Stocks'],
    summary: 'All Stock Tokens: Chainlink price, DEX price, premium/discount, liquidity',
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Stock Token list' },
      502: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Upstream unavailable' },
    },
  }),
  async (c) => {
    try {
      return c.json(await listStocks())
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/stocks/:symbol ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/stocks/{symbol}',
    tags: ['Stocks'],
    summary: 'Stock Token detail: candles, holders, feed metadata, links',
    request: {
      params: SymbolParam,
      query: z.object({ interval: z.enum(['5m', '15m', '1h', '4h', '1d']).optional() }),
    },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Stock Token detail' },
      404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Unknown symbol' },
    },
  }),
  async (c) => {
    const { symbol } = c.req.valid('param')
    const { interval } = c.req.valid('query')
    try {
      return c.json(await getStockDetail(symbol, interval ?? '1h'))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/coins ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/coins',
    tags: ['Coins'],
    summary: 'Memecoins: launchpad state, price, liquidity, holders, age',
    request: { query: CoinsQuery },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Coin list' },
    },
  }),
  async (c) => {
    const { limit } = c.req.valid('query')
    try {
      return c.json(await listCoins({ limit }))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/coins/:address ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/coins/{address}',
    tags: ['Coins'],
    summary: 'Coin detail: launch info, graduation status, DEX stats, holders',
    request: { params: AddressParam },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Coin detail' },
      400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid address' },
    },
  }),
  async (c) => {
    const { address } = c.req.valid('param')
    try {
      return c.json(await getCoinDetail(address))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

// ---- /v1/launches ----
freeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v1/launches',
    tags: ['Coins'],
    summary: 'Recent + live launchpad activity (NOXA, The Odyssey)',
    request: { query: LaunchesQuery },
    responses: {
      200: { content: { 'application/json': { schema: JsonBody } }, description: 'Launch list' },
    },
  }),
  async (c) => {
    const { launchpad, lookback, limit } = c.req.valid('query')
    const lookbackBlocks = lookback ? LOOKBACK_BLOCKS[lookback] : undefined
    try {
      return c.json(await getLaunches({ launchpad, lookbackBlocks, limit }))
    } catch (err) {
      const { status, body } = fail(err)
      return c.json(body, status)
    }
  },
)

export { ApiError }
