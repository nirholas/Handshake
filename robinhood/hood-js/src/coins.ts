import { HoodError, toHoodError } from './errors.js'
import { geckoNetwork } from './state.js'

/**
 * A coin as reported by GeckoTerminal's public onchain index for Robinhood
 * Chain — the same provider that already covers chain 4663. Used by both
 * {@link coins} (trending) and {@link import('./index').launches} (new pools).
 */
export interface Coin {
  /** Base-token ticker, e.g. `"HOODBOT"`. */
  symbol: string
  /** Human name of the pool pairing, e.g. `"HOODBOT / WETH 1%"`. */
  name: string
  /** Base-token contract address. */
  address: string
  /** The Uniswap-style pool address the metrics come from. */
  pool: string
  /** DEX the pool lives on, e.g. `"uniswap-v3-robinhood"`. */
  dex: string
  /** Current base-token price in USD. */
  priceUsd: number
  /** 24-hour price change, in percent (e.g. `180.16`). `null` when unknown. */
  change24h: number | null
  /** 24-hour trade volume in USD. `null` when unknown. */
  volume24hUsd: number | null
  /** Fully-diluted valuation in USD. `null` when unknown. */
  fdvUsd: number | null
  /** Total pool liquidity in USD. `null` when unknown. */
  liquidityUsd: number | null
  /** ISO timestamp the pool was created, when reported. */
  createdAt: string | null
  /** GeckoTerminal page for the pool. */
  url: string
}

/** Alias for {@link Coin} in trending contexts. */
export type TrendingCoin = Coin
/** Alias for {@link Coin} in new-launch contexts. */
export type NewCoin = Coin

/** Options for {@link coins}. */
export interface CoinsOptions {
  /** Max coins to return. @defaultValue `20` */
  limit?: number
  /**
   * Ranking window GeckoTerminal computes "trending" over.
   * @defaultValue `'24h'`
   */
  window?: '5m' | '1h' | '6h' | '24h'
  /** Per-request timeout in ms. @defaultValue `10000` */
  timeoutMs?: number
}

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2'

interface GeckoPool {
  id: string
  attributes: {
    address: string
    name: string
    base_token_price_usd: string | null
    fdv_usd: string | null
    market_cap_usd: string | null
    reserve_in_usd: string | null
    pool_created_at: string | null
    price_change_percentage?: Record<string, string | null>
    volume_usd?: Record<string, string | null>
  }
  relationships?: {
    base_token?: { data?: { id: string } }
    dex?: { data?: { id: string } }
  }
}

interface GeckoIncluded {
  id: string
  type: string
  attributes: { address?: string; name?: string; symbol?: string }
}

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Fetch a page of pools from a GeckoTerminal onchain endpoint and map them to
 * {@link Coin}s. Shared by {@link coins} and the new-pools discovery used by
 * {@link import('./index').launches}.
 */
export async function fetchPools(
  endpoint: 'trending_pools' | 'new_pools',
  params: Record<string, string>,
  timeoutMs: number,
): Promise<Coin[]> {
  const network = geckoNetwork()
  const query = new URLSearchParams({ include: 'base_token,dex', page: '1', ...params }).toString()
  const url = `${GECKO_BASE}/networks/${network}/${endpoint}?${query}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
  } catch (err) {
    throw toHoodError(err)
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 429) {
    throw new HoodError(
      'GeckoTerminal is rate-limiting requests (free tier is ~30/min). Slow down or add your own API key upstream.',
      'NETWORK',
    )
  }
  if (!res.ok) {
    throw new HoodError(
      `Couldn't load ${endpoint} for network "${network}" (HTTP ${res.status}). If Robinhood Chain isn't indexed yet, set hood.config({ geckoNetwork }) to the correct slug.`,
      'NETWORK',
    )
  }

  const body = (await res.json()) as { data?: GeckoPool[]; included?: GeckoIncluded[] }
  const tokenById = new Map<string, GeckoIncluded>()
  for (const inc of body.included ?? []) {
    if (inc.type === 'token') tokenById.set(inc.id, inc)
  }

  return (body.data ?? []).map((pool): Coin => {
    const a = pool.attributes
    const baseId = pool.relationships?.base_token?.data?.id
    const base = baseId ? tokenById.get(baseId) : undefined
    return {
      symbol: base?.attributes.symbol ?? a.name.split(' / ')[0] ?? '',
      name: a.name,
      address: base?.attributes.address ?? (baseId ? baseId.split('_')[1] ?? '' : ''),
      pool: a.address,
      dex: pool.relationships?.dex?.data?.id ?? 'unknown',
      priceUsd: num(a.base_token_price_usd) ?? 0,
      change24h: num(a.price_change_percentage?.h24),
      volume24hUsd: num(a.volume_usd?.h24),
      fdvUsd: num(a.fdv_usd),
      liquidityUsd: num(a.reserve_in_usd),
      createdAt: a.pool_created_at ?? null,
      url: `https://www.geckoterminal.com/${network}/pools/${a.address}`,
    }
  })
}

/**
 * Trending memecoins on Robinhood Chain, aggregated across the launchpad and
 * Uniswap pools by GeckoTerminal's public onchain index. Returns live USD
 * price, 24h change, volume, and liquidity. No key, no wallet.
 *
 * @example
 * ```js
 * const top = await hood.coins()
 * for (const c of top) console.log(c.symbol, `$${c.priceUsd}`, `${c.change24h}%`)
 * ```
 */
export async function coins(options: CoinsOptions = {}): Promise<TrendingCoin[]> {
  const limit = options.limit ?? 20
  const list = await fetchPools(
    'trending_pools',
    { duration: options.window ?? '24h' },
    options.timeoutMs ?? 10_000,
  )
  return list.slice(0, limit)
}

/** Fetch the newest pools (freshest launches first). */
export async function fetchNewCoins(timeoutMs: number): Promise<NewCoin[]> {
  return fetchPools('new_pools', {}, timeoutMs)
}
