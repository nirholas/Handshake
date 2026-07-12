/**
 * Read-only upstream data providers for Robinhood Chain, each hit live with a
 * timeout and a structured error. No API keys required; all are public.
 *
 * - DefiLlama  — chain TVL (`/v2/chains`, filtered to "Robinhood Chain").
 * - Blockscout — chain stats, token metadata (holders/volume), and search
 *   (`https://robinhoodchain.blockscout.com/api/v2/...`).
 * - GeckoTerminal — DEX pool prices, trending pools, and token pools for the
 *   `robinhood` network (`https://api.geckoterminal.com/api/v2/...`).
 *
 * Verified live during the build: DefiLlama lists chainId 4663, Blockscout Pro
 * v2 API answers `/stats` `/search` `/tokens/:addr`, and GeckoTerminal's
 * network id for Robinhood Chain is `robinhood`.
 */

const DEFILLAMA = 'https://api.llama.fi'
const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2'

/** Blockscout base for a network. Testnet Blockscout has the same v2 API shape. */
export function blockscoutBase(network: 'mainnet' | 'testnet'): string {
  return network === 'testnet'
    ? 'https://explorer.testnet.chain.robinhood.com'
    : 'https://robinhoodchain.blockscout.com'
}

/** GeckoTerminal network slug for Robinhood Chain mainnet (verified live). */
export const GECKOTERMINAL_NETWORK = 'robinhood'

export class UpstreamError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`)
    this.name = 'UpstreamError'
  }
}

async function getJson<T>(provider: string, url: string, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'hood-mcp/0.1 (+https://three.ws)' },
    })
    if (!res.ok) throw new UpstreamError(provider, `HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof UpstreamError) throw e
    const reason = e instanceof Error && e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(e)
    throw new UpstreamError(provider, `${reason} for ${url}`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- DefiLlama

interface LlamaChain {
  name: string
  chainId: number | null
  tvl: number
}

/** Current TVL for Robinhood Chain from DefiLlama, or `null` if unavailable. */
export async function fetchChainTvl(): Promise<number | null> {
  const chains = await getJson<LlamaChain[]>('defillama', `${DEFILLAMA}/v2/chains`)
  const hit = chains.find((c) => c.chainId === 4663 || /robinhood/i.test(c.name))
  return hit ? hit.tvl : null
}

// ---------------------------------------------------------------- Blockscout

export interface BlockscoutStats {
  average_block_time: number
  total_blocks: string
  total_addresses: string
  total_transactions: string
  transactions_today: string
  gas_prices: { slow: number; average: number; fast: number } | null
  coin_price: string | null
}

/** Chain-wide stats from Blockscout. */
export function fetchBlockscoutStats(network: 'mainnet' | 'testnet'): Promise<BlockscoutStats> {
  return getJson<BlockscoutStats>('blockscout', `${blockscoutBase(network)}/api/v2/stats`)
}

export interface BlockscoutToken {
  address_hash?: string
  address?: string
  name: string | null
  symbol: string | null
  decimals: string | null
  holders_count?: string | null
  holders?: string | null
  total_supply: string | null
  volume_24h?: string | null
  circulating_market_cap?: string | null
  exchange_rate?: string | null
  icon_url?: string | null
  type?: string | null
}

/** Token metadata (holders, 24h volume, market cap) from Blockscout. */
export function fetchTokenMeta(network: 'mainnet' | 'testnet', address: string): Promise<BlockscoutToken> {
  return getJson<BlockscoutToken>('blockscout', `${blockscoutBase(network)}/api/v2/tokens/${address}`)
}

export interface BlockscoutSearchItem {
  address_hash?: string
  address?: string
  name?: string | null
  symbol?: string | null
  type?: string
  token_type?: string | null
  is_smart_contract_verified?: boolean
  certified?: boolean
  circulating_market_cap?: string | null
  exchange_rate?: string | null
  icon_url?: string | null
}

/** Full-text search across tokens/addresses/tx on Blockscout. */
export async function searchBlockscout(
  network: 'mainnet' | 'testnet',
  query: string,
): Promise<BlockscoutSearchItem[]> {
  const data = await getJson<{ items?: BlockscoutSearchItem[] }>(
    'blockscout',
    `${blockscoutBase(network)}/api/v2/search?q=${encodeURIComponent(query)}`,
  )
  return data.items ?? []
}

// -------------------------------------------------------------- GeckoTerminal

/** Attributes GeckoTerminal returns on a pool. */
export interface GtPoolAttributes {
  name: string
  address: string
  base_token_price_usd: string | null
  quote_token_price_usd: string | null
  base_token_price_native_currency: string | null
  pool_created_at: string | null
  fdv_usd: string | null
  market_cap_usd: string | null
  reserve_in_usd: string | null
  volume_usd: { h1?: string; h6?: string; h24?: string } | null
  price_change_percentage: { h1?: string; h6?: string; h24?: string } | null
  transactions: Record<string, { buys?: number; sells?: number }> | null
}

export interface GtPool {
  id: string
  type: string
  attributes: GtPoolAttributes
  relationships?: {
    base_token?: { data?: { id?: string } }
    quote_token?: { data?: { id?: string } }
    dex?: { data?: { id?: string } }
  }
}

interface GtResponse<T> {
  data: T
  included?: unknown[]
}

/** Trending pools on Robinhood Chain (proxy for trending coins). */
export async function fetchTrendingPools(limit = 10): Promise<GtPool[]> {
  const data = await getJson<GtResponse<GtPool[]>>(
    'geckoterminal',
    `${GECKOTERMINAL}/networks/${GECKOTERMINAL_NETWORK}/trending_pools?page=1`,
  )
  return (data.data ?? []).slice(0, limit)
}

/** All pools for a token on Robinhood Chain, most-liquid first. */
export async function fetchTokenPools(tokenAddress: string): Promise<GtPool[]> {
  const data = await getJson<GtResponse<GtPool[]>>(
    'geckoterminal',
    `${GECKOTERMINAL}/networks/${GECKOTERMINAL_NETWORK}/tokens/${tokenAddress}/pools?page=1`,
  )
  const pools = data.data ?? []
  return pools.sort((a, b) => {
    const ra = Number(a.attributes.reserve_in_usd ?? 0)
    const rb = Number(b.attributes.reserve_in_usd ?? 0)
    return rb - ra
  })
}

export interface GtTokenAttributes {
  address: string
  name: string | null
  symbol: string | null
  decimals: number | null
  total_supply: string | null
  price_usd: string | null
  fdv_usd: string | null
  total_reserve_in_usd: string | null
  volume_usd: { h24?: string } | null
  market_cap_usd: string | null
  image_url?: string | null
}

/** Token-level info from GeckoTerminal, or `null` if the token is unknown there. */
export async function fetchGtToken(tokenAddress: string): Promise<GtTokenAttributes | null> {
  try {
    const data = await getJson<GtResponse<{ attributes: GtTokenAttributes }>>(
      'geckoterminal',
      `${GECKOTERMINAL}/networks/${GECKOTERMINAL_NETWORK}/tokens/${tokenAddress}`,
    )
    return data.data?.attributes ?? null
  } catch (e) {
    // A 404 from GeckoTerminal means "not indexed", not a hard failure.
    if (e instanceof UpstreamError && /HTTP 404/.test(e.message)) return null
    throw e
  }
}
