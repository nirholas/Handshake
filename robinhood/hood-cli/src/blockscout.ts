/**
 * Thin Blockscout v2 API client. Used to enrich RPC data with decoded method
 * names, token metadata, and holder counts. Every call is best-effort: on any
 * failure it resolves to `null` so the RPC-only path still works offline of the
 * explorer.
 */
import type { HoodNetwork } from 'hoodchain'
import { MAINNET_EXPLORER_URL } from 'hoodchain'

const TESTNET_EXPLORER_URL = 'https://explorer.testnet.chain.robinhood.com'

export function explorerBase(network: HoodNetwork): string {
  return network === 'testnet' ? TESTNET_EXPLORER_URL : MAINNET_EXPLORER_URL
}

/** A browser link to a transaction. */
export function txUrl(network: HoodNetwork, hash: string): string {
  return `${explorerBase(network)}/tx/${hash}`
}

/** A browser link to an address/token. */
export function addressUrl(network: HoodNetwork, address: string): string {
  return `${explorerBase(network)}/address/${address}`
}

async function get<T>(network: HoodNetwork, path: string, timeoutMs = 6000): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${explorerBase(network)}/api/v2${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface BlockscoutTx {
  method?: string | null
  decoded_input?: { method_call?: string; parameters?: { name: string; type: string; value: unknown }[] } | null
  status?: string
  result?: string
  fee?: { value?: string } | null
  gas_used?: string
  revert_reason?: unknown
  exchange_rate?: string | null
  to?: { hash?: string; name?: string | null; is_contract?: boolean } | null
  from?: { hash?: string } | null
}

export function fetchTx(network: HoodNetwork, hash: string): Promise<BlockscoutTx | null> {
  return get<BlockscoutTx>(network, `/transactions/${hash}`)
}

export interface BlockscoutToken {
  name?: string | null
  symbol?: string | null
  decimals?: string | null
  total_supply?: string | null
  holders?: string | null
  holders_count?: string | null
  type?: string | null
  icon_url?: string | null
}

export function fetchToken(network: HoodNetwork, address: string): Promise<BlockscoutToken | null> {
  return get<BlockscoutToken>(network, `/tokens/${address}`)
}
