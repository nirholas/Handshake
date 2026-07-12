import { formatUnits, type Address } from 'viem'
import {
  getQuote,
  getStockToken,
  listStockTokens,
  MAINNET_EXPLORER_URL,
  type StockQuote,
} from 'hoodchain'
import { cached, TTL } from '../lib/cache.js'
import { ApiError, toApiError } from '../lib/errors.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import { ethPriceUsd } from './chain.js'
import { getBulkDexStats, getCandles, getDexStats, type DexStats } from '../upstreams/dex.js'
import * as blockscout from '../upstreams/blockscout.js'

function premium(dexUsd: number | null, chainlinkUsd: number | null): number | null {
  if (dexUsd === null || chainlinkUsd === null || chainlinkUsd === 0) return null
  return (dexUsd - chainlinkUsd) / chainlinkUsd
}

async function safeQuote(symbol: string): Promise<StockQuote | null> {
  try {
    return await getQuote(mainnetClient(), symbol)
  } catch {
    return null // stale/absent feed -> unpriced, not an error
  }
}

function multiplierFloat(scaled: string): number {
  return Number(formatUnits(BigInt(scaled), 18))
}

/** All Stock Tokens with Chainlink price, DEX mid, premium/discount, liquidity, multiplier. */
export async function listStocks() {
  return cached('stocks:list', TTL.stocks, async () => {
    const client = mainnetClient()
    const tokens = listStockTokens()
    const priced = tokens.filter((t) => t.feed !== null)

    const [quotes, eth] = await Promise.all([
      Promise.all(priced.map((t) => safeQuote(t.symbol))),
      ethPriceUsd(),
    ])
    const quoteBySymbol = new Map<string, StockQuote | null>()
    priced.forEach((t, i) => quoteBySymbol.set(t.symbol, quotes[i] ?? null))

    const dex = await getBulkDexStats(client, tokens.map((t) => t.address as Address), eth)

    const rows = tokens.map((t) => {
      const q = quoteBySymbol.get(t.symbol) ?? null
      const d = dex.get(t.address.toLowerCase()) ?? emptyDex()
      return {
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        chainlinkPriceUsd: q?.priceUsd ?? null,
        feedUpdatedAt: q ? new Date(q.updatedAt * 1000).toISOString() : null,
        dexPriceUsd: d.priceUsd,
        premiumDiscount: premium(d.priceUsd, q?.priceUsd ?? null),
        uiMultiplier: multiplierFloat(t.uiMultiplierAtGeneration),
        liquidityUsd: d.liquidityUsd,
        pool: d.pool,
        feeTier: d.feeTier,
        hasFeed: t.feed !== null,
      }
    })

    const withDex = rows.filter((r) => r.dexPriceUsd !== null).length
    return withMeta(
      {
        count: rows.length,
        pricedCount: priced.length,
        dexPricedCount: withDex,
        stocks: rows,
        note:
          'Per-token 24h DEX volume and OHLCV candles are on the detail endpoint (/v1/stocks/{symbol}); ' +
          'reconstructing them for every token per request would hammer the public RPC.',
      },
      [SOURCE.registry, SOURCE.chainlink, SOURCE.uniswap],
    )
  })
}

function emptyDex(): DexStats {
  return { priceUsd: null, pool: null, feeTier: null, quoteAsset: null, liquidityUsd: null }
}

/** One Stock Token in depth: price, DEX stats, 24h volume, holders, feed + links. */
export async function getStockDetail(symbolRaw: string, interval: string) {
  const token = (() => {
    try {
      return getStockToken(symbolRaw)
    } catch {
      throw ApiError.unknownSymbol(symbolRaw)
    }
  })()

  return cached(`stocks:detail:${token.symbol}:${interval}`, TTL.stockDetail, async () => {
    const client = mainnetClient()
    const eth = await ethPriceUsd()

    const [quote, dex, counters, candles] = await Promise.all([
      safeQuote(token.symbol),
      getDexStats(client, token.address as Address, eth).catch(() => emptyDex()),
      blockscout.getTokenCounters(token.address).catch(() => null),
      getCandles(client, token.address as Address, eth, { interval, lookbackBlocks: 900_000n }).catch(() => null),
    ])

    const source: string[] = [SOURCE.registry, SOURCE.chainlink, SOURCE.uniswap]
    if (counters) source.push(SOURCE.blockscout)

    return withMeta(
      {
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        uiMultiplier: multiplierFloat(token.uiMultiplierAtGeneration),
        chainlink: quote
          ? {
              priceUsd: quote.priceUsd,
              feed: quote.feed,
              roundId: quote.roundId.toString(),
              updatedAt: new Date(quote.updatedAt * 1000).toISOString(),
              ageSeconds: quote.ageSeconds,
            }
          : null,
        dex: {
          priceUsd: dex.priceUsd,
          pool: dex.pool,
          feeTier: dex.feeTier,
          quoteAsset: dex.quoteAsset,
          liquidityUsd: dex.liquidityUsd,
          volume24hUsd: candles?.volumeUsd ?? null,
        },
        premiumDiscount: premium(dex.priceUsd, quote?.priceUsd ?? null),
        candles: candles
          ? { interval: candles.interval, fromBlock: candles.fromBlock, toBlock: candles.toBlock, series: candles.candles }
          : null,
        holders: counters ? Number(counters.token_holders_count) : null,
        transfersCount: counters ? Number(counters.transfers_count) : null,
        links: {
          token: blockscout.tokenLink(token.address),
          feed: token.feed ? `${MAINNET_EXPLORER_URL}/address/${token.feed}` : null,
          pool: dex.pool ? blockscout.addressLink(dex.pool) : null,
        },
      },
      source,
    )
  })
}

/** Deep OHLCV history for one token (paid endpoint). */
export async function getStockHistory(symbolRaw: string, interval: string, lookbackBlocks: bigint) {
  const token = (() => {
    try {
      return getStockToken(symbolRaw)
    } catch {
      throw ApiError.unknownSymbol(symbolRaw)
    }
  })()

  return cached(`stocks:history:${token.symbol}:${interval}:${lookbackBlocks}`, TTL.history, async () => {
    const client = mainnetClient()
    const eth = await ethPriceUsd()
    try {
      const candles = await getCandles(client, token.address as Address, eth, { interval, lookbackBlocks })
      if (!candles) {
        throw ApiError.notFound(
          `${token.symbol} has no Uniswap v3 pool with trade history on Robinhood Chain yet.`,
          'no_dex_history',
        )
      }
      return withMeta(
        {
          symbol: token.symbol,
          address: token.address,
          pool: candles.pool,
          quoteAsset: candles.quoteAsset,
          interval: candles.interval,
          fromBlock: candles.fromBlock,
          toBlock: candles.toBlock,
          volumeUsd: candles.volumeUsd,
          candles: candles.candles,
        },
        [SOURCE.uniswap, SOURCE.rpc],
      )
    } catch (err) {
      throw toApiError(err)
    }
  })
}
