import type { RefusalReason, RiskLimits } from './types.js'

/** Everything the risk engine needs to rule on a single intent. */
export interface RiskContext {
  /** `buy` grows exposure and hits spend/position caps; `sell` reduces it and is exempt from those. */
  side: 'buy' | 'sell'
  /** USD notional of this order (agent computes it from live prices; USDG≈USD, WETH×ethUsd). */
  notionalUsd: number
  /** USD value the token position would reach AFTER a buy fills. */
  positionUsdAfter: number
  /** USD this agent has already spent this UTC day. */
  spentTodayUsd: number
  /** USD the whole fleet has spent this UTC day. */
  fleetSpentTodayUsd: number
  /** ms epoch of this agent's last executed trade, or null. */
  lastTradeAt: number | null
  /** Slippage bound (bps) the order would execute with. */
  slippageBps: number
  /** Whether the global kill switch is tripped. */
  killed: boolean
  /** Current time (ms) — injected for deterministic tests. */
  now: number
  /** Fleet-wide daily spend ceiling (USD). */
  fleetMaxDailySpendUsdg: number
}

/** Result of a risk check. */
export interface RiskVerdict {
  ok: boolean
  reason?: RefusalReason
  /** Human explanation, safe to journal and surface on the dashboard. */
  detail: string
}

/**
 * The risk engine. It is the last gate before any order — paper or live —
 * reaches execution, and it fails CLOSED: any check it cannot satisfy refuses
 * the trade rather than letting it through. Refusals are ordered from
 * cheapest/most-fatal (kill switch) to most-specific (caps) so the journaled
 * reason is the most meaningful one.
 *
 * Sells are intentionally exempt from spend and position caps: those caps exist
 * to bound how much risk you take ON, and refusing a de-risking sell because of
 * a spend cap would trap an agent in a losing position. Sells still honor the
 * kill switch, cooldown, and slippage bound.
 */
export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {}

  get riskLimits(): RiskLimits {
    return this.limits
  }

  check(ctx: RiskContext): RiskVerdict {
    if (ctx.killed) {
      return { ok: false, reason: 'kill_switch', detail: 'kill switch is tripped — no new orders' }
    }

    if (ctx.notionalUsd <= 0) {
      return { ok: false, reason: 'zero_amount', detail: 'order notional is zero or negative' }
    }

    // Cooldown throttles trade frequency regardless of side.
    if (ctx.lastTradeAt !== null) {
      const elapsed = (ctx.now - ctx.lastTradeAt) / 1000
      if (elapsed < this.limits.cooldownSeconds) {
        const wait = (this.limits.cooldownSeconds - elapsed).toFixed(1)
        return { ok: false, reason: 'cooldown', detail: `cooldown active — ${wait}s until next trade allowed` }
      }
    }

    // Slippage bound must never exceed the configured cap.
    if (ctx.slippageBps > this.limits.maxSlippageBps) {
      return {
        ok: false,
        reason: 'slippage_bound',
        detail: `slippage ${ctx.slippageBps}bps exceeds cap ${this.limits.maxSlippageBps}bps`,
      }
    }

    // Spend/position caps only constrain buys (exposure-increasing orders).
    if (ctx.side === 'buy') {
      if (ctx.positionUsdAfter > this.limits.maxPositionUsdg) {
        return {
          ok: false,
          reason: 'position_cap',
          detail: `position would reach $${ctx.positionUsdAfter.toFixed(2)}, over cap $${this.limits.maxPositionUsdg}`,
        }
      }
      if (ctx.spentTodayUsd + ctx.notionalUsd > this.limits.maxDailySpendUsdg) {
        return {
          ok: false,
          reason: 'daily_cap',
          detail: `daily spend would reach $${(ctx.spentTodayUsd + ctx.notionalUsd).toFixed(2)}, over cap $${this.limits.maxDailySpendUsdg}`,
        }
      }
      if (ctx.fleetSpentTodayUsd + ctx.notionalUsd > ctx.fleetMaxDailySpendUsdg) {
        return {
          ok: false,
          reason: 'fleet_daily_cap',
          detail: `fleet daily spend would reach $${(ctx.fleetSpentTodayUsd + ctx.notionalUsd).toFixed(2)}, over cap $${ctx.fleetMaxDailySpendUsdg}`,
        }
      }
    }

    return { ok: true, detail: 'within all risk limits' }
  }
}

/** UTC-midnight ms boundary for `now` — the daily-cap accounting window. */
export function utcDayStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
