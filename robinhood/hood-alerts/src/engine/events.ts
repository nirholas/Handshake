import type { Address, Hash } from 'viem'

/** Which launchpad an event came from. */
export type Launchpad = 'noxa' | 'odyssey'

/** A new token launch on NOXA or The Odyssey. */
export interface LaunchEvent {
  type: 'launch'
  launchpad: Launchpad
  token: Address
  symbol: string | null
  name: string | null
  creator: Address
  /** Uniswap v3 pool (immediate for NOXA; null while an Odyssey curve fills). */
  pool: Address | null
  blockNumber: bigint
  transactionHash: Hash
  at: number
}

/** An Odyssey bonding curve filled and migrated to a locked Uniswap v3 pool. */
export interface GraduationEvent {
  type: 'graduation'
  token: Address
  symbol: string | null
  name: string | null
  pool: Address
  blockNumber: bigint
  transactionHash: Hash
  at: number
}

/** A trade at or above the whale USD floor. */
export interface WhaleEvent {
  type: 'whale'
  source: 'odyssey-curve' | 'uniswap-v3'
  token: Address
  symbol: string | null
  side: 'buy' | 'sell'
  usd: number
  trader: Address
  blockNumber: bigint
  transactionHash: Hash
  at: number
}

/** A Stock Token Chainlink price moved beyond a ladder rung within the window. */
export interface PriceMoveEvent {
  type: 'price_move'
  symbol: string
  /** Signed percent change over the window. */
  pct: number
  fromUsd: number
  toUsd: number
  windowS: number
  at: number
}

/** DEX price crossed a premium/discount rung vs the Chainlink feed. */
export interface PremiumEvent {
  type: 'premium'
  symbol: string
  token: Address
  /** Signed premium percent: positive = DEX trades above Chainlink. */
  premiumPct: number
  /** The ladder rung crossed (absolute percent). */
  level: number
  direction: 'premium' | 'discount'
  dexUsd: number
  feedUsd: number
  pool: Address
  at: number
}

/** A token's holder count crossed a milestone. */
export interface HolderMilestoneEvent {
  type: 'holders'
  token: Address
  symbol: string | null
  milestone: number
  count: number
  at: number
}

/** Pool quote reserves dropped sharply: the rug early-warning. */
export interface LiquidityPullEvent {
  type: 'liquidity_pull'
  token: Address | null
  symbol: string | null
  pool: Address
  quoteAsset: 'USDG' | 'WETH'
  droppedPct: number
  beforeUsd: number
  afterUsd: number
  at: number
}

/** Any alert the engine can route. */
export type AlertEvent =
  | LaunchEvent
  | GraduationEvent
  | WhaleEvent
  | PriceMoveEvent
  | PremiumEvent
  | HolderMilestoneEvent
  | LiquidityPullEvent

/** Stable dedup fingerprint for an event. */
export function fingerprint(e: AlertEvent): string {
  switch (e.type) {
    case 'launch':
      return `launch:${e.transactionHash}:${e.token.toLowerCase()}`
    case 'graduation':
      return `grad:${e.token.toLowerCase()}`
    case 'whale':
      return `whale:${e.transactionHash}:${e.token.toLowerCase()}:${e.usd.toFixed(0)}`
    case 'price_move':
      return `price:${e.symbol}:${e.at}`
    case 'premium':
      return `premium:${e.symbol}:${e.direction}:${e.level}`
    case 'holders':
      return `holders:${e.token.toLowerCase()}:${e.milestone}`
    case 'liquidity_pull':
      return `liq:${e.pool.toLowerCase()}`
  }
}

/** How long a fingerprint blocks re-delivery, per event type (seconds). */
export function dedupTtlSeconds(e: AlertEvent): number {
  switch (e.type) {
    case 'launch':
    case 'graduation':
    case 'whale':
      return 7 * 24 * 3600
    case 'price_move':
      return 24 * 3600
    case 'premium':
      return 6 * 3600
    case 'holders':
      return 30 * 24 * 3600
    case 'liquidity_pull':
      return 3600
  }
}
