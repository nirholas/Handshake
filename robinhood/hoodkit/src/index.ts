/**
 * hoodkit — the power-user toolkit for Robinhood Chain (chain ID 4663).
 *
 * @packageDocumentation
 */

// stream
export {
  Stream,
  streamPrices,
  streamSwaps,
  streamLaunches,
  streamPortfolio,
  runLogCursor,
  discoverPools,
  loadPoolInfo,
  decodeSwapLog,
  sqrtPriceX96ToPrice,
  uniswapV3SwapEvent,
  uniswapV3PoolMetaAbi,
} from './stream/index.js'
export type {
  OverflowPolicy,
  StreamOptions,
  StreamPollOptions,
  StreamSwapsOptions,
  PriceTick,
  PortfolioUpdate,
  PoolInfo,
  SwapEvent,
  LogCursorOptions,
  LogSource,
} from './stream/index.js'

// cache
export { createHoodCache, MemoryLruStore } from './cache/index.js'
export type { HoodCache, HoodCacheOptions, CacheStore, CacheTtls, CacheStats } from './cache/index.js'

// batch
export { plan, createBatcher } from './batch/index.js'
export type { ContractRead, BatchResult, BatchOptions, Batcher } from './batch/index.js'

// indexer
export { Indexer, createIndexer, buildCandles, fillGaps, INTERVAL_SECONDS } from './indexer/index.js'
export type { IndexerOptions, SyncProgress, SyncResult, Holder, Candle, Interval, TradePoint } from './indexer/index.js'

// strategy
export {
  Position,
  SpendCap,
  SpendCapExceededError,
  createPriceTriggers,
  createTwapExecutor,
} from './strategy/index.js'
export type {
  Fill,
  PnlSnapshot,
  CrossDirection,
  CrossEvent,
  PriceTriggers,
  TwapConfig,
  TwapExecutor,
  TwapSlicePlan,
  TwapSliceResult,
} from './strategy/index.js'
