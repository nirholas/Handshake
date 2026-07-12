/**
 * hoodchain — the TypeScript SDK for Robinhood Chain (chain ID 4663).
 *
 * @packageDocumentation
 */

// client
export { createHoodClient } from './client.js'
export type { HoodClient, HoodClientConfig, HoodNetwork } from './client.js'

// addresses & constants
export {
  MAINNET_ADDRESSES,
  TESTNET_ADDRESSES,
  TESTNET_STOCK_TOKENS,
  MAINNET_FEED_URL,
  MAINNET_EXPLORER_URL,
  USDG_DECIMALS,
  STOCK_TOKEN_DECIMALS,
  FEED_DECIMALS,
  V3_FEE_TIERS,
} from './addresses.js'

// registry
export {
  getRegistry,
  listStockTokens,
  listPricedStockTokens,
  getStockToken,
  getStockTokenByAddress,
  isStockTokenSymbol,
  isStockTokenAddress,
} from './registry/index.js'
export type { StockToken, StockTokenRegistry } from './registry/index.js'

// stocks
export {
  getQuote,
  getMultiplier,
  getPosition,
  getPortfolio,
  DEFAULT_MAX_FEED_AGE_SECONDS,
} from './stocks.js'
export type { StockQuote, StockPosition, Portfolio, GetQuoteOptions } from './stocks.js'

// swap
export { quoteSwap, buildSwapTx, executeSwap, ensureApproval, swapAddresses } from './swap.js'
export type { SwapRoute, SwapQuote, SwapTx, SwapTxOptions, QuoteSwapOptions } from './swap.js'

// usdg
export {
  usdgAddress,
  formatUsdg,
  parseUsdg,
  getUsdgBalance,
  getUsdgTotalSupply,
  getUsdgAllowance,
  transferUsdg,
  approveUsdg,
} from './usdg.js'

// launchpads
export {
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  getRecentLaunches,
  watchLaunches,
  watchCurveTrades,
  watchGraduations,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  odysseyTradedEvent,
  odysseyPoolMigratedEvent,
} from './launchpads.js'
export type {
  Launch,
  CurveTrade,
  LaunchpadName,
  GetRecentLaunchesOptions,
  WatchOptions,
} from './launchpads.js'

// feed
export { subscribeFeed, watchTransfers } from './feed.js'
export type {
  FeedMessage,
  FeedOptions,
  FeedSubscription,
  DecodedFeedTransaction,
  TokenTransfer,
} from './feed.js'

// errors
export {
  HoodchainError,
  UnknownSymbolError,
  FeedNotFoundError,
  StaleFeedError,
  InvalidFeedAnswerError,
  NoRouteError,
  SlippageExceededError,
  NoAccountError,
  StockTokenEligibilityError,
  FeedConnectionError,
} from './errors.js'

// abis (for consumers building custom calls)
export {
  erc20Abi,
  stockTokenAbi,
  aggregatorV3Abi,
  quoterV2Abi,
  swapRouter02Abi,
  swapRouterAbi,
  weth9Abi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
} from './abis.js'
