import { explorerApiUrl } from '../core/explorer.js'
import { TickerTakenError } from '../errors.js'
import type { HoodNetwork } from 'hoodchain'

interface BlockscoutTokenSearchItem {
  address_hash: string
  symbol: string | null
  name: string | null
}

/**
 * Check whether `symbol` is already in use by a live token on-chain, via
 * Blockscout's token search API (`GET /api/v2/tokens?q=<symbol>`, verified
 * live on both mainnet and testnet during this build). Search is
 * fuzzy/substring on Blockscout's side, so this filters to an EXACT
 * case-insensitive symbol match before treating it as a collision.
 *
 * @throws {@link TickerTakenError} when an exact match exists.
 */
export async function checkTickerUniqueness(network: HoodNetwork, symbol: string): Promise<void> {
  const url = `${explorerApiUrl(network)}/v2/tokens?q=${encodeURIComponent(symbol)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'hood-launcher' } })
  if (!res.ok) {
    // Blockscout being briefly unavailable shouldn't hard-fail a launch; the
    // caller still gets an on-chain collision check via the rail's own
    // "already launched" guards. Surface loudly instead of failing silent.
    console.warn(`[uniqueness] Blockscout token search returned ${res.status} — skipping ticker uniqueness check`)
    return
  }
  const body = (await res.json()) as { items?: BlockscoutTokenSearchItem[] }
  const exactMatch = (body.items ?? []).find((item) => (item.symbol ?? '').toUpperCase() === symbol.toUpperCase())
  if (exactMatch) {
    throw new TickerTakenError(symbol, `${network} token ${exactMatch.address_hash} ("${exactMatch.name}")`)
  }
}
