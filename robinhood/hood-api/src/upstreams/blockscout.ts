import { MAINNET_EXPLORER_URL } from 'hoodchain'
import { fetchJson } from '../lib/http.js'

/** Blockscout Pro API (mainnet). Chain stats, gas prices, and token holder counts. */

const BASE = MAINNET_EXPLORER_URL

export interface BlockscoutStats {
  average_block_time: number // ms
  gas_prices: { slow: number; average: number; fast: number } | null
  gas_used_today: string
  coin_price: string | null
  market_cap: string | null
  total_addresses: string | null
  total_blocks: string | null
  total_transactions: string | null
  transactions_today: string | null
  network_utilization_percentage: number | null
}

export function getStats(): Promise<BlockscoutStats> {
  return fetchJson<BlockscoutStats>(`${BASE}/api/v2/stats`, { label: 'blockscout/stats', timeoutMs: 8000 })
}

export interface TokenCounters {
  token_holders_count: string
  transfers_count: string
}

export function getTokenCounters(address: string): Promise<TokenCounters> {
  return fetchJson<TokenCounters>(`${BASE}/api/v2/tokens/${address}/counters`, {
    label: 'blockscout/token-counters',
    timeoutMs: 8000,
  })
}

export interface BlockscoutToken {
  address: string
  name: string | null
  symbol: string | null
  decimals: string | null
  holders: string | null
  total_supply: string | null
  volume_24h?: string | null
}

export async function getToken(address: string): Promise<BlockscoutToken | null> {
  try {
    return await fetchJson<BlockscoutToken>(`${BASE}/api/v2/tokens/${address}`, {
      label: 'blockscout/token',
      timeoutMs: 8000,
    })
  } catch {
    return null
  }
}

export function txLink(hash: string): string {
  return `${BASE}/tx/${hash}`
}

export function addressLink(address: string): string {
  return `${BASE}/address/${address}`
}

export function tokenLink(address: string): string {
  return `${BASE}/token/${address}`
}
