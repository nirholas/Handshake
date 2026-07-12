import { env } from '../lib/env.js'
import { cached } from '../lib/cache.js'
import { fetchJson } from '../lib/http.js'

/**
 * CoinGecko — used only for the cross-venue `/v1/equities` endpoint, to price
 * the SAME underlying ticker on other tokenized-equity venues:
 *   - xStocks (Backed), e.g. AAPL -> "Apple xStock" (symbol AAPLX)
 *   - Ondo Global Markets, e.g. AAPL -> "... Ondo ..." tokenized equity
 *
 * Free-tier friendly: id resolution is cached for a day and prices for 30s.
 */

const BASE = env.coingeckoApiKey
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3'

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' }
  if (env.coingeckoApiKey) h['x-cg-pro-api-key'] = env.coingeckoApiKey
  return h
}

interface SearchResult {
  coins: Array<{ id: string; name: string; symbol: string; market_cap_rank: number | null }>
}

export type EquityVenue = 'xstocks' | 'ondo'

/** Predicate identifying the right CoinGecko coin for a ticker on a venue. */
function matches(venue: EquityVenue, ticker: string, coin: { name: string; symbol: string }): boolean {
  const name = coin.name.toLowerCase()
  const sym = coin.symbol.toUpperCase()
  if (venue === 'xstocks') {
    return name.includes('xstock') && (sym === `${ticker}X` || sym === ticker)
  }
  // Ondo Global Markets tokenized equities
  return name.includes('ondo') && (sym === ticker || sym === `${ticker}ON` || name.includes(ticker.toLowerCase()))
}

/** Resolve a CoinGecko coin id for `ticker` on `venue`, or null. Cached 24h. */
export async function resolveEquityId(venue: EquityVenue, ticker: string): Promise<string | null> {
  return cached(`cg:resolve:${venue}:${ticker}`, 24 * 60 * 60_000, async () => {
    const query = venue === 'xstocks' ? `${ticker}x` : `${ticker} ondo`
    const res = await fetchJson<SearchResult>(`${BASE}/search?query=${encodeURIComponent(query)}`, {
      headers: headers(),
      label: 'coingecko/search',
      timeoutMs: 8000,
    })
    const hit = res.coins.find((c) => matches(venue, ticker, c))
    return hit?.id ?? null
  })
}

export interface SimplePrice {
  usd: number
  usd_24h_vol?: number
  usd_24h_change?: number
  last_updated_at?: number
}

/** Batch price lookup for coin ids. Missing ids are simply absent from the map. */
export async function getSimplePrices(ids: string[]): Promise<Record<string, SimplePrice>> {
  if (ids.length === 0) return {}
  const url =
    `${BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}` +
    `&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`
  return fetchJson<Record<string, SimplePrice>>(url, {
    headers: headers(),
    label: 'coingecko/simple-price',
    timeoutMs: 8000,
  })
}
