import { getQuote, getStockToken, listPricedStockTokens } from 'hoodchain'
import { cached, TTL } from '../lib/cache.js'
import { ApiError } from '../lib/errors.js'
import { SOURCE, withMeta } from '../lib/response.js'
import { mainnetClient } from '../upstreams/rpc.js'
import { resolveEquityId, getSimplePrices, type EquityVenue } from '../upstreams/coingecko.js'

/**
 * `/v1/equities` — the unique product. Nobody else prices the same underlying
 * ticker across all three tokenized-equity venues in one call:
 *
 *  - Robinhood Chain Stock Tokens (Chainlink feed, this service's own chain)
 *  - xStocks (Backed Finance) — Solana-native, priced via CoinGecko
 *  - Ondo Global Markets — tokenized equities, priced via CoinGecko
 *
 * Each row reports every venue's price plus which venue is cheapest and the
 * spread in basis points. Venues without a resolvable/priced token for a
 * ticker are `null`, never fabricated.
 */

export interface VenueLeg {
  venue: 'robinhood-chain' | EquityVenue
  priceUsd: number | null
  updatedAt: string | null
  ref: string | null // coingecko id, or feed address
}

async function robinhoodLeg(symbol: string): Promise<VenueLeg> {
  try {
    const q = await getQuote(mainnetClient(), symbol)
    return { venue: 'robinhood-chain', priceUsd: q.priceUsd, updatedAt: new Date(q.updatedAt * 1000).toISOString(), ref: q.feed }
  } catch {
    return { venue: 'robinhood-chain', priceUsd: null, updatedAt: null, ref: null }
  }
}

async function venueLeg(venue: EquityVenue, symbol: string): Promise<VenueLeg> {
  const id = await resolveEquityId(venue, symbol)
  if (!id) return { venue, priceUsd: null, updatedAt: null, ref: null }
  const prices = await getSimplePrices([id])
  const p = prices[id]
  if (!p) return { venue, priceUsd: null, updatedAt: null, ref: id }
  return {
    venue,
    priceUsd: p.usd,
    updatedAt: p.last_updated_at ? new Date(p.last_updated_at * 1000).toISOString() : null,
    ref: id,
  }
}

function spreadRow(legs: VenueLeg[]) {
  const priced = legs.filter((l): l is VenueLeg & { priceUsd: number } => l.priceUsd !== null)
  if (priced.length < 2) return { cheapestVenue: priced[0]?.venue ?? null, spreadBps: null }
  const sorted = [...priced].sort((a, b) => a.priceUsd - b.priceUsd)
  const cheapest = sorted[0]!
  const priciest = sorted[sorted.length - 1]!
  const spreadBps = ((priciest.priceUsd - cheapest.priceUsd) / cheapest.priceUsd) * 10_000
  return { cheapestVenue: cheapest.venue, spreadBps }
}

/** Cross-venue view for one ticker. */
export async function getEquity(symbolRaw: string) {
  const token = (() => {
    try {
      return getStockToken(symbolRaw)
    } catch {
      throw ApiError.unknownSymbol(symbolRaw)
    }
  })()
  const symbol = token.symbol

  return cached(`equities:${symbol}`, TTL.equities, async () => {
    const [rh, xstocks, ondo] = await Promise.all([
      robinhoodLeg(symbol),
      venueLeg('xstocks', symbol),
      venueLeg('ondo', symbol),
    ])
    const legs = [rh, xstocks, ondo]
    return withMeta(
      { symbol, name: token.name, venues: legs, ...spreadRow(legs) },
      [SOURCE.chainlink, SOURCE.coingecko],
    )
  })
}

/** Cross-venue view for every priced Stock Token (bounded list for the "show me the market" call). */
export async function listEquities(limit: number) {
  const symbols = listPricedStockTokens()
    .map((t) => t.symbol)
    .slice(0, Math.min(Math.max(limit, 1), 30))

  return cached(`equities:list:${symbols.join(',')}`, TTL.equities, async () => {
    const rows = await Promise.all(
      symbols.map(async (symbol) => {
        const [rh, xstocks, ondo] = await Promise.all([
          robinhoodLeg(symbol),
          venueLeg('xstocks', symbol),
          venueLeg('ondo', symbol),
        ])
        const legs = [rh, xstocks, ondo]
        return { symbol, venues: legs, ...spreadRow(legs) }
      }),
    )
    const withMultipleVenues = rows.filter((r) => r.venues.filter((v) => v.priceUsd !== null).length >= 2).length
    return withMeta(
      { count: rows.length, crossVenueCount: withMultipleVenues, equities: rows },
      [SOURCE.chainlink, SOURCE.coingecko],
    )
  })
}
