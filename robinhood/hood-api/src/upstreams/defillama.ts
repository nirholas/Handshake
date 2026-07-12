import { fetchJson } from '../lib/http.js'

/** DefiLlama — Robinhood Chain TVL (current + historical series). */

const CHAIN_SLUG = 'robinhood-chain'
const CHAIN_NAME = 'Robinhood Chain'

interface ChainEntry {
  name: string
  chainId: number | null
  tvl: number
}

/** Current chain TVL in USD, or null if DefiLlama has no entry. */
export async function getChainTvl(): Promise<number | null> {
  const chains = await fetchJson<ChainEntry[]>('https://api.llama.fi/v2/chains', {
    label: 'defillama/chains',
    timeoutMs: 8000,
  })
  const entry = chains.find((c) => c.name === CHAIN_NAME || c.chainId === 4663)
  return entry ? entry.tvl : null
}

export interface TvlPoint {
  date: number // unix seconds
  tvl: number
}

/** Full historical TVL series for the chain. */
export function getHistoricalTvl(): Promise<TvlPoint[]> {
  return fetchJson<TvlPoint[]>(`https://api.llama.fi/v2/historicalChainTvl/${CHAIN_SLUG}`, {
    label: 'defillama/historical',
    timeoutMs: 8000,
  })
}
