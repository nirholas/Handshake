/**
 * Trading-server configuration and the in-process spend ledger that enforces
 * hard caps. Both the per-call and per-session limits are denominated in USD
 * (USDG), and every mutating tool must call {@link assertWithinCaps} before it
 * signs anything and {@link recordSpend} only after settlement succeeds.
 */

/** Parsed, validated trading configuration. */
export interface TradingConfig {
  /** Whether `HOOD_MCP_ENABLE_TRADING === '1'`. When false, no tool may sign. */
  enabled: boolean
  /** Max USD value moved in a single tool call. */
  maxSpendPerCallUsd: number
  /** Max cumulative USD value moved across the whole server session. */
  maxSpendPerSessionUsd: number
  /** Whether the operator affirmed Stock Token acquisition eligibility. */
  acknowledgeEligibility: boolean
}

function parsePositiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}")`)
  }
  return n
}

/** Read the trading config from the environment. */
export function readTradingConfig(env: NodeJS.ProcessEnv = process.env): TradingConfig {
  const perCall = parsePositiveNumber('HOOD_MCP_MAX_SPEND_USDG', env.HOOD_MCP_MAX_SPEND_USDG, 25)
  const perSession = parsePositiveNumber(
    'HOOD_MCP_MAX_SESSION_USDG',
    env.HOOD_MCP_MAX_SESSION_USDG,
    Math.max(perCall, 100),
  )
  if (perSession < perCall) {
    throw new Error(
      `HOOD_MCP_MAX_SESSION_USDG (${perSession}) must be >= HOOD_MCP_MAX_SPEND_USDG (${perCall}).`,
    )
  }
  return {
    enabled: env.HOOD_MCP_ENABLE_TRADING === '1',
    maxSpendPerCallUsd: perCall,
    maxSpendPerSessionUsd: perSession,
    acknowledgeEligibility: env.HOOD_MCP_ACKNOWLEDGE_ELIGIBILITY === '1',
  }
}

/** Session spend accumulator. One instance lives for the life of the server. */
export class SpendLedger {
  private spentUsd = 0

  constructor(private readonly config: TradingConfig) {}

  /** Total USD moved so far this session. */
  get spent(): number {
    return this.spentUsd
  }

  /** USD remaining before the session cap is hit. */
  get sessionRemaining(): number {
    return Math.max(0, this.config.maxSpendPerSessionUsd - this.spentUsd)
  }

  /**
   * Throw if `usdValue` would breach the per-call or per-session cap. Call this
   * BEFORE signing. `usdValue` must be a finite non-negative number; an
   * un-valuable spend (no price route) is a caller error and must be rejected
   * upstream rather than passed here as 0.
   */
  assertWithinCaps(usdValue: number): void {
    if (!Number.isFinite(usdValue) || usdValue < 0) {
      throw new Error(`internal: refusing to check a non-finite spend value (${usdValue})`)
    }
    if (usdValue > this.config.maxSpendPerCallUsd) {
      throw new Error(
        `spend $${usdValue.toFixed(2)} exceeds the per-call cap of ` +
          `$${this.config.maxSpendPerCallUsd} (HOOD_MCP_MAX_SPEND_USDG). ` +
          `Lower the amount or raise the cap.`,
      )
    }
    if (this.spentUsd + usdValue > this.config.maxSpendPerSessionUsd) {
      throw new Error(
        `spend $${usdValue.toFixed(2)} would bring this session to ` +
          `$${(this.spentUsd + usdValue).toFixed(2)}, over the per-session cap of ` +
          `$${this.config.maxSpendPerSessionUsd} (HOOD_MCP_MAX_SESSION_USDG). ` +
          `$${this.sessionRemaining.toFixed(2)} remaining. Restart the server to reset.`,
      )
    }
  }

  /** Record a settled spend. Call only AFTER a successful on-chain settlement. */
  recordSpend(usdValue: number): void {
    this.spentUsd += usdValue
  }
}
