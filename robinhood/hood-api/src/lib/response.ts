/**
 * Response envelope helpers. Every successful body carries provenance:
 * `asOf` (ISO-8601 read time) and `source` (the upstreams the data came from).
 */

export interface Provenance {
  /** ISO-8601 timestamp for when this data was read/computed. */
  asOf: string
  /** Upstream sources this response was assembled from. */
  source: string[]
}

/** Named upstream identifiers used in the `source` field. */
export const SOURCE = {
  rpc: 'robinhood-chain-rpc',
  chainlink: 'chainlink-feeds',
  uniswap: 'uniswap-v3-onchain',
  blockscout: 'blockscout',
  defillama: 'defillama',
  coingecko: 'coingecko',
  registry: 'hoodchain-registry',
  odyssey: 'odyssey-launchpad',
  noxa: 'noxa-launchpad',
} as const

export function nowIso(): string {
  return new Date().toISOString()
}

/** Attach provenance to a payload object. */
export function withMeta<T extends object>(payload: T, source: string[]): T & Provenance {
  return { ...payload, asOf: nowIso(), source: dedupe(source) }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}
