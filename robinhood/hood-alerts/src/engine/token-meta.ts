import { erc20Abi, type HoodClient } from 'hoodchain'
import type { Address } from 'viem'

export interface TokenMeta {
  symbol: string | null
  name: string | null
}

/**
 * Symbol/name cache for arbitrary ERC-20s (launchpad coins are not in the
 * Stock Token registry). Failures cache as nulls so a broken token does not
 * hammer the RPC on every event.
 */
export class TokenMetaCache {
  private readonly cache = new Map<string, TokenMeta>()

  constructor(private readonly client: HoodClient) {}

  async get(token: Address): Promise<TokenMeta> {
    const key = token.toLowerCase()
    const hit = this.cache.get(key)
    if (hit) return hit
    let meta: TokenMeta = { symbol: null, name: null }
    try {
      const [symbol, name] = await this.client.public.multicall({
        contracts: [
          { address: token, abi: erc20Abi, functionName: 'symbol' },
          { address: token, abi: erc20Abi, functionName: 'name' },
        ],
        allowFailure: true,
      })
      meta = {
        symbol: symbol.status === 'success' ? String(symbol.result).slice(0, 32) : null,
        name: name.status === 'success' ? String(name.result).slice(0, 64) : null,
      }
    } catch {
      // keep nulls
    }
    this.cache.set(key, meta)
    if (this.cache.size > 5000) {
      const first = this.cache.keys().next().value
      if (first) this.cache.delete(first)
    }
    return meta
  }
}
