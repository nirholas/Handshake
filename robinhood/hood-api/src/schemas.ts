import { z } from '@hono/zod-openapi'

/** Shared param/query schemas for OpenAPI request validation. */

export const SymbolParam = z.object({
  symbol: z
    .string()
    .min(1)
    .max(10)
    .openapi({ param: { name: 'symbol', in: 'path' }, example: 'AAPL', description: 'Stock Token ticker, case-insensitive' }),
})

export const AddressParam = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-hex-char address')
    .openapi({
      param: { name: 'address', in: 'path' },
      example: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
      description: 'EVM contract or wallet address',
    }),
})

export const IntervalQuery = z.object({
  interval: z
    .enum(['5m', '15m', '1h', '4h', '1d'])
    .optional()
    .openapi({ param: { name: 'interval', in: 'query' }, example: '1h', description: 'Candle bucket size' }),
})

export const HistoryQuery = IntervalQuery.extend({
  lookback: z
    .enum(['1h', '6h', '24h', '7d', '30d'])
    .optional()
    .openapi({
      param: { name: 'lookback', in: 'query' },
      example: '7d',
      description: 'How far back to reconstruct OHLCV from swap logs',
    }),
})

export const LaunchesQuery = z.object({
  launchpad: z
    .enum(['noxa', 'odyssey'])
    .optional()
    .openapi({ param: { name: 'launchpad', in: 'query' }, description: 'Restrict to one launchpad' }),
  lookback: z
    .enum(['15m', '1h', '6h', '24h'])
    .optional()
    .openapi({ param: { name: 'lookback', in: 'query' }, example: '1h' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, example: 50 }),
})

export const CoinsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, example: 25 }),
})

export const EquitiesListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, example: 10 }),
})

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'unknown_symbol' }),
    hint: z.string().openapi({ example: 'Symbol not found in the Stock Token registry.' }),
    docs: z.string().url().openapi({ example: 'https://nirholas.github.io/hood-api/#errors' }),
  })
  .openapi('ApiError')

export const LOOKBACK_BLOCKS: Record<string, bigint> = {
  '15m': 9_000n,
  '1h': 36_000n,
  '6h': 216_000n,
  '24h': 864_000n,
  '1h_hist': 36_000n,
  '6h_hist': 216_000n,
  '24h_hist': 864_000n,
  '7d': 6_048_000n,
  '30d': 25_920_000n,
}
