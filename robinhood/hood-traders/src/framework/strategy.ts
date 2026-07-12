import type { Address } from 'viem'
import type { Market } from './market.js'
import type { Decision, Position } from './types.js'

/** Which token a strategy denominates its orders in. */
export type QuoteKind = 'usdg' | 'weth'

/** Documentation a strategy must publish about itself — surfaced in docs + dashboard. */
export interface StrategyMeta {
  /** One-paragraph honest statement of why this could have an edge. */
  edge: string
  /** The ways this strategy loses money — named plainly, no hand-waving. */
  failureModes: string[]
  /** Tunable parameters and their live values. */
  params: Record<string, unknown>
}

/** Context handed to a strategy on each decision tick. */
export interface StrategyTickContext {
  market: Market
  /** This agent's currently open positions. */
  positions: Position[]
  /** Injected clock (ms) — deterministic in tests. */
  now: number
  /** Resolved quote token address for this strategy's {@link QuoteKind}. */
  quoteToken: Address
  quoteSymbol: string
  quoteDecimals: number
  /** Structured log line into the decision journal (kind = observe). */
  log: (message: string, meta?: Record<string, unknown>) => void
}

/** Context handed once at strategy startup (for stream subscriptions). */
export interface StrategyStartContext {
  market: Market
  log: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * A trading strategy: pure observation → decision. It never touches wallets,
 * risk caps, or the journal — the {@link Agent} owns simulate/execute/journal
 * and enforces every risk rail around whatever the strategy proposes. A
 * strategy that proposes a wild order simply gets refused; it cannot bypass the
 * risk engine.
 */
export interface Strategy {
  readonly id: string
  readonly title: string
  readonly quote: QuoteKind
  readonly meta: StrategyMeta
  /** Optional: wire real-time subscriptions (e.g. launch stream). */
  start?(ctx: StrategyStartContext): Promise<void> | void
  /** Optional teardown for subscriptions. */
  stop?(): void
  /** Produce intents + alerts for this tick. */
  tick(ctx: StrategyTickContext): Promise<Decision>
}
