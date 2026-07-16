/**
 * hood-tokenlist: typed loader for the canonical Robinhood Chain token list.
 *
 * The list itself is plain JSON (also importable directly via
 * `hood-tokenlist/tokenlist.json`); these helpers add the lookups every
 * integrator writes anyway.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The full token list (Uniswap token-lists standard, chain ID 4663). */
export const tokenList = require('../tokenlist.json')

/** Every token entry. */
export const tokens = tokenList.tokens

/** The chain the list covers. */
export const CHAIN_ID = 4663

const byAddressMap = new Map(tokens.map((t) => [t.address.toLowerCase(), t]))
const bySymbolMap = new Map()
for (const token of tokens) {
  const key = token.symbol.toUpperCase()
  if (!bySymbolMap.has(key)) bySymbolMap.set(key, [])
  bySymbolMap.get(key).push(token)
}

/** Look up a token by contract address (case-insensitive). Returns null when absent. */
export function getToken(address) {
  return byAddressMap.get(String(address).toLowerCase()) ?? null
}

/**
 * Look up tokens by symbol (case-insensitive). Returns an array because the
 * standard permits distinct tokens to share a symbol across classes.
 */
export function getTokensBySymbol(symbol) {
  return bySymbolMap.get(String(symbol).toUpperCase()) ?? []
}

/** All tokens of one asset class: 'stock-token' | 'memecoin' | 'stablecoin' | 'wrapped-native'. */
export function getTokensByClass(assetClass) {
  return tokens.filter((t) => t.extensions?.assetClass === assetClass)
}

/** All Stock Tokens. */
export function stockTokens() {
  return getTokensByClass('stock-token')
}

/** All vetted memecoins. */
export function memecoins() {
  return getTokensByClass('memecoin')
}

/** Tokens with a live Chainlink price feed. */
export function pricedTokens() {
  return tokens.filter((t) => t.extensions?.chainlinkFeed)
}

/** The list's version as a semver string, e.g. "1.2.0". */
export function listVersion() {
  const { major, minor, patch } = tokenList.version
  return `${major}.${minor}.${patch}`
}
