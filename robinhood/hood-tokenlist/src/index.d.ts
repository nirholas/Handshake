/** hood-tokenlist type definitions. */

export type AssetClass = 'stock-token' | 'memecoin' | 'stablecoin' | 'wrapped-native'

export interface TokenExtensions {
  /** Which class of asset this entry is. */
  assetClass: AssetClass
  /** Chainlink price feed proxy for this token, or null when none exists. */
  chainlinkFeed: string | null
  /** Feed answer decimals (8 for USD feeds), present when chainlinkFeed is set. */
  chainlinkFeedDecimals?: number | null
  /** True when the token implements ERC-8056 uiMultiplier() (all Stock Tokens). */
  supportsUiMultiplier: boolean
  /** Stock Tokens only: eligibility restriction marker ("not-for-us-persons"). */
  eligibility?: string
  /** Memecoins only: launchpad of origin. */
  launchpad?: 'noxa' | 'odyssey'
  /** Memecoins only: the token's Uniswap v3 pool. */
  uniswapV3Pool?: string
  /** Memecoins only: the pool's fee tier (e.g. 10000 = 1%). */
  uniswapV3PoolFee?: number
  /** Memecoins only: block of the launch (NOXA) or graduation (Odyssey). */
  launchBlock?: number
  /** NOXA memecoins only: block at which launch anti-snipe restrictions expire. */
  launchRestrictionsEndBlock?: number
}

export interface TokenInfo {
  chainId: 4663
  /** Checksummed contract address. */
  address: string
  symbol: string
  name: string
  decimals: number
  /** Self-hosted logo URL (monogram SVG or the token's own art). */
  logoURI: string
  tags: string[]
  extensions: TokenExtensions
}

export interface TokenList {
  name: string
  timestamp: string
  version: { major: number; minor: number; patch: number }
  keywords: string[]
  tags: Record<string, { name: string; description: string }>
  logoURI: string
  tokens: TokenInfo[]
}

/** The full token list (Uniswap token-lists standard, chain ID 4663). */
export const tokenList: TokenList
/** Every token entry. */
export const tokens: TokenInfo[]
/** The chain the list covers. */
export const CHAIN_ID: 4663

/** Look up a token by contract address (case-insensitive). */
export function getToken(address: string): TokenInfo | null
/** Look up tokens by symbol (case-insensitive). */
export function getTokensBySymbol(symbol: string): TokenInfo[]
/** All tokens of one asset class. */
export function getTokensByClass(assetClass: AssetClass): TokenInfo[]
/** All Stock Tokens. */
export function stockTokens(): TokenInfo[]
/** All vetted memecoins. */
export function memecoins(): TokenInfo[]
/** Tokens with a live Chainlink price feed. */
export function pricedTokens(): TokenInfo[]
/** The list's version as a semver string. */
export function listVersion(): string
