import type { Address } from 'viem'
import { UnknownSymbolError } from '../errors.js'
import registryJson from './stock-tokens.json' with { type: 'json' }

/** One canonical Stock Token registry entry. */
export interface StockToken {
  /** Checksummed token contract address on chain 4663. */
  address: Address
  /** On-chain ticker, e.g. `"TSLA"`. The on-chain symbol is the source of truth. */
  symbol: string
  /** On-chain name, e.g. `"Tesla • Robinhood Token"`. */
  name: string
  /** Token decimals (18 for every canonical Stock Token). */
  decimals: number
  /**
   * Chainlink feed proxy for this token, or `null` when Chainlink's public
   * directory lists no feed for it. Feed answers are already
   * multiplier-adjusted (price of one TOKEN, not one share).
   */
  feed: Address | null
  /** Feed answer decimals (8), or `null` when there is no feed. */
  feedDecimals: number | null
  /** `uiMultiplier()` snapshot taken when the registry was generated (1e18-scaled string). */
  uiMultiplierAtGeneration: string
}

/** Registry metadata: where the data came from and how it was verified. */
export interface StockTokenRegistry {
  chainId: number
  generatedAtBlock: number
  /** The shared EIP-1967 beacon behind every canonical Stock Token proxy. */
  stockBeacon: Address
  tokenCount: number
  feedCount: number
  tokens: StockToken[]
}

const registry = registryJson as unknown as StockTokenRegistry

const bySymbol = new Map<string, StockToken>(registry.tokens.map((t) => [t.symbol.toUpperCase(), t]))
const byAddress = new Map<string, StockToken>(registry.tokens.map((t) => [t.address.toLowerCase(), t]))

/**
 * The full Stock Token registry, generated from Blockscout discovery +
 * on-chain verification + Chainlink's official feed directory. Regenerate
 * with `npm run refresh-registry`.
 */
export function getRegistry(): StockTokenRegistry {
  return registry
}

/** All canonical Stock Tokens, sorted by symbol. */
export function listStockTokens(): StockToken[] {
  return registry.tokens
}

/** Stock Tokens that have a live Chainlink price feed. */
export function listPricedStockTokens(): StockToken[] {
  return registry.tokens.filter((t) => t.feed !== null)
}

/**
 * Look up a Stock Token by ticker (case-insensitive).
 * @throws {@link UnknownSymbolError} when the symbol is not in the registry.
 */
export function getStockToken(symbol: string): StockToken {
  const token = bySymbol.get(symbol.toUpperCase())
  if (!token) throw new UnknownSymbolError(symbol)
  return token
}

/** Look up a Stock Token by contract address, or `null` if not canonical. */
export function getStockTokenByAddress(address: Address): StockToken | null {
  return byAddress.get(address.toLowerCase()) ?? null
}

/** `true` when `symbol` resolves to a canonical Stock Token. */
export function isStockTokenSymbol(symbol: string): boolean {
  return bySymbol.has(symbol.toUpperCase())
}

/** `true` when `address` is a canonical Stock Token contract. */
export function isStockTokenAddress(address: Address): boolean {
  return byAddress.has(address.toLowerCase())
}
