import type { Address, Hash } from 'viem'

/** Trading mode. `paper` simulates fills against live liquidity; `live` signs real swaps. */
export type Mode = 'paper' | 'live'

/** A single actionable instruction produced by a strategy's `decide` step. */
export interface Intent {
  /** `buy` = spend the quote token to acquire `token`; `sell` = the reverse. */
  side: 'buy' | 'sell'
  /** The non-quote token being acquired (buy) or disposed (sell). */
  token: Address
  /** Human label for the token, for journal/dashboard readability. */
  tokenSymbol: string
  /**
   * Amount of the INPUT token, in its smallest unit. On a `buy` the input is the
   * quote token (spend N USDG/WETH → receive `token`); on a `sell` the input is
   * `token` itself (sell N token units → receive the quote token).
   */
  amountIn: bigint
  /** Which token `amountIn` is denominated in (what leaves the wallet on a buy). */
  quoteToken: Address
  /** Quote token symbol, e.g. `USDG` or `WETH`. */
  quoteSymbol: string
  /** Free-text reason the strategy fired — surfaced verbatim in the decision journal. */
  reason: string
  /** Optional per-intent slippage override (bps). Falls back to the agent's cap. */
  maxSlippageBps?: number
  /** Opaque strategy metadata persisted with the decision (take-profit level, curve %, premium bps…). */
  meta?: Record<string, unknown>
}

/** An alert a strategy raises without trading (e.g. premium-watch in alerts-only mode). */
export interface Alert {
  level: 'info' | 'warn'
  message: string
  meta?: Record<string, unknown>
}

/** What a strategy returns each tick. */
export interface Decision {
  intents: Intent[]
  alerts: Alert[]
}

/** A position the agent is currently holding (paper or live). */
export interface Position {
  token: Address
  tokenSymbol: string
  /** Token units held (smallest unit). */
  amount: bigint
  /** Quote token spent to open (net of sells), smallest unit. */
  costBasis: bigint
  /** USD cost basis at time of each buy (net of proportional sells) — the number the position cap bounds. */
  investedUsd: number
  quoteToken: Address
  quoteSymbol: string
  /** ms epoch the position opened. */
  openedAt: number
  /** Marked exit value in USD at last tick (null until first mark). */
  markUsd: number | null
  /** Strategy metadata carried from the opening intent. */
  meta: Record<string, unknown>
}

/** Reason an intent was refused before execution. */
export type RefusalReason =
  | 'position_cap'
  | 'daily_cap'
  | 'fleet_daily_cap'
  | 'slippage_bound'
  | 'cooldown'
  | 'kill_switch'
  | 'no_route'
  | 'eligibility_gate'
  | 'insufficient_balance'
  | 'zero_amount'

/** A journaled trade (executed or simulated). */
export interface TradeRecord {
  id?: number
  agentId: string
  mode: Mode
  ts: number
  side: 'buy' | 'sell'
  token: Address
  tokenSymbol: string
  quoteToken: Address
  quoteSymbol: string
  amountIn: bigint
  amountOut: bigint
  /** null in paper mode; the swap tx hash in live mode. */
  txHash: Hash | null
  reason: string
  slippageBps: number
  gasEstimate: bigint
  meta: Record<string, unknown>
}

/** A journaled decision that did NOT result in a trade (refused / held / alerted). */
export interface DecisionRecord {
  id?: number
  agentId: string
  ts: number
  kind: 'refused' | 'alert' | 'observe';
  detail: string
  meta: Record<string, unknown>
}

/** A point on an agent's equity curve. */
export interface EquityPoint {
  agentId: string
  ts: number
  /** Realized PnL to date (quote units, USDG cents-style as float USD). */
  realizedUsd: number
  /** Marked value of open positions (USD). */
  openValueUsd: number
  /** realized + open. */
  equityUsd: number
}

/** Per-agent risk limits. */
export interface RiskLimits {
  maxPositionUsdg: number
  maxDailySpendUsdg: number
  maxSlippageBps: number
  cooldownSeconds: number
}

/** Live snapshot of an agent for the dashboard. */
export interface AgentStatus {
  id: string
  strategy: string
  mode: Mode
  running: boolean
  killed: boolean
  limits: RiskLimits
  spentTodayUsd: number
  realizedUsd: number
  openValueUsd: number
  equityUsd: number
  positions: Position[]
  lastTickAt: number | null
  lastError: string | null
  ticks: number
  trades: number
  refusals: number
}
