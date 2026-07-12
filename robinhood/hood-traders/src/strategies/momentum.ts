import { getRecentLaunches, parseUsdg, type Launch } from 'hoodchain'
import type { Address } from 'viem'
import type {
  Strategy,
  StrategyMeta,
  StrategyTickContext,
} from '../framework/strategy.js'
import type { Decision, Intent, Alert } from '../framework/types.js'

/** Tunables for {@link Momentum}. */
export interface MomentumParams {
  /** USDG spent per entry. */
  entryUsdg: number
  /** Minimum price gain over the lookback window to count as a breakout. */
  breakoutPct: number
  /** How many price samples (ticks) form the lookback window. */
  lookbackSamples: number
  /** Trailing stop: exit if price falls this fraction off its post-entry peak. */
  trailingStopPct: number
  /** Hard time exit regardless of PnL. */
  maxHoldSeconds: number
  /** How many graduated tokens to track price history for (most-recently-graduated first). */
  maxTracked: number
  /** Blocks to look back for discovering graduated tokens. */
  discoveryLookbackBlocks: bigint
}

const DEFAULTS: MomentumParams = {
  entryUsdg: 10,
  breakoutPct: 0.15,
  lookbackSamples: 6,
  trailingStopPct: 0.2,
  maxHoldSeconds: 60 * 60,
  maxTracked: 15,
  discoveryLookbackBlocks: 200_000n,
}

interface PriceHistory {
  token: Address
  symbol: string
  samples: { ts: number; priceUsd: number }[]
}

/**
 * momentum — volume+price breakout entries on already-graduated (liquid)
 * tokens, trailing-stop exits.
 *
 * EDGE HYPOTHESIS: a token that has already graduated to a locked Uniswap v3
 * pool has survived the highest-mortality phase (the bonding curve / first
 * minutes). A subsequent breakout — price up sharply over a short lookback,
 * confirmed by the pool actually being tradable at size — reflects real
 * incoming demand rather than launch-day noise, and trend-following that with
 * a trailing stop captures the middle of the move while giving back only the
 * tail.
 *
 * FAILURE MODES: breakouts on illiquid tokens are trivially fakeable by a
 * single wallet round-tripping the pool; the strategy only looks at price, not
 * depth, so it can chase a move that reverses the instant it stops buying.
 * Trailing stops whipsaw in choppy markets — expect a string of small losses
 * between real trends. Discovery only looks at NOXA (instant-listed, so
 * "graduated" from day one) and Odyssey `PoolMigrated` history within the
 * lookback window; a real breakout minutes after that window closes is missed
 * until the next discovery pass.
 */
export class Momentum implements Strategy {
  readonly id = 'momentum'
  readonly title = 'Momentum'
  readonly quote = 'usdg' as const
  private readonly p: MomentumParams
  private readonly history = new Map<string, PriceHistory>()
  private readonly peakSinceEntry = new Map<string, number>()
  private lastDiscoveryAt = 0

  constructor(params: Partial<MomentumParams> = {}) {
    this.p = { ...DEFAULTS, ...params }
  }

  get meta(): StrategyMeta {
    return {
      edge:
        'Trend-follow price breakouts on already-graduated, liquid tokens — surviving the launch phase filters ' +
        'for real demand, and a trailing stop rides the middle of a move.',
      failureModes: [
        'Breakouts on thin pools are trivially fakeable by a single wallet; price-only signal has no depth check.',
        'Trailing stops whipsaw in choppy conditions — a string of small losses between real trends is expected.',
        'Discovery only scans a bounded block lookback; breakouts on tokens outside that window are missed until the next pass.',
        'Momentum has no edge in a flat or declining market — it is a trend-only strategy by design.',
      ],
      params: { ...this.p },
    }
  }

  async tick(ctx: StrategyTickContext): Promise<Decision> {
    const intents: Intent[] = []
    const alerts: Alert[] = []

    // Refresh the tracked-token set periodically (cheap log scan, not every tick).
    if (ctx.now - this.lastDiscoveryAt > 5 * 60_000 || this.history.size === 0) {
      await this.discover(ctx)
      this.lastDiscoveryAt = ctx.now
    }

    // Sample current prices for tracked tokens.
    for (const h of this.history.values()) {
      const spot = await ctx.market.spotPrice(h.token)
      if (!spot) continue
      h.samples.push({ ts: ctx.now, priceUsd: spot.priceUsd })
      if (h.samples.length > this.p.lookbackSamples + 1) h.samples.shift()
    }

    // ── exits: trailing stop / time exit ────────────────────────────────────────
    for (const pos of ctx.positions) {
      const key = pos.token.toLowerCase()
      const spot = await ctx.market.spotPrice(pos.token)
      const ageSec = (ctx.now - pos.openedAt) / 1000
      if (spot) {
        const peak = Math.max(this.peakSinceEntry.get(key) ?? spot.priceUsd, spot.priceUsd)
        this.peakSinceEntry.set(key, peak)
        const drawdown = peak > 0 ? 1 - spot.priceUsd / peak : 0
        if (drawdown >= this.p.trailingStopPct) {
          intents.push(this.exitIntent(pos, ctx, `trailing stop: ${(drawdown * 100).toFixed(1)}% off peak $${peak.toFixed(6)}`))
          this.peakSinceEntry.delete(key)
          continue
        }
      }
      if (ageSec >= this.p.maxHoldSeconds) {
        intents.push(this.exitIntent(pos, ctx, `time-exit ${Math.round(ageSec)}s held`))
        this.peakSinceEntry.delete(key)
      }
    }

    // ── entries: breakout over the lookback window ──────────────────────────────
    for (const h of this.history.values()) {
      if (h.samples.length < this.p.lookbackSamples) continue
      if (ctx.positions.some((p) => p.token.toLowerCase() === h.token.toLowerCase())) continue
      const first = h.samples[h.samples.length - this.p.lookbackSamples]
      const last = h.samples[h.samples.length - 1]
      if (!first || !last || first.priceUsd <= 0) continue
      const gain = last.priceUsd / first.priceUsd - 1
      if (gain >= this.p.breakoutPct) {
        const amountIn = parseUsdg(String(this.p.entryUsdg))
        intents.push({
          side: 'buy',
          token: h.token,
          tokenSymbol: h.symbol,
          amountIn,
          quoteToken: ctx.quoteToken,
          quoteSymbol: ctx.quoteSymbol,
          reason: `breakout +${(gain * 100).toFixed(1)}% over ${this.p.lookbackSamples} samples ($${first.priceUsd.toFixed(6)}→$${last.priceUsd.toFixed(6)})`,
          meta: { gain, entryPriceUsd: last.priceUsd },
        })
        this.peakSinceEntry.set(h.token.toLowerCase(), last.priceUsd)
      } else {
        alerts.push({
          level: 'info',
          message: `${h.symbol} watch: ${(gain * 100).toFixed(1)}% vs ${(this.p.breakoutPct * 100).toFixed(0)}% breakout threshold`,
        })
      }
    }

    return { intents, alerts }
  }

  private exitIntent(pos: StrategyTickContext['positions'][number], ctx: StrategyTickContext, reason: string): Intent {
    return {
      side: 'sell',
      token: pos.token,
      tokenSymbol: pos.tokenSymbol,
      amountIn: pos.amount,
      quoteToken: pos.quoteToken,
      quoteSymbol: pos.quoteSymbol,
      reason,
    }
  }

  private async discover(ctx: StrategyTickContext): Promise<void> {
    let launches: Launch[]
    try {
      launches = await getRecentLaunches(ctx.market.client, { lookbackBlocks: this.p.discoveryLookbackBlocks })
    } catch (err) {
      ctx.log(`momentum discovery failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // NOXA tokens are tradable from block one; Odyssey tokens need a migrated pool —
    // approximated here by simply attempting a spot price and dropping tokens with none.
    const graduated = launches.filter((l) => l.launchpad === 'noxa' || l.pool !== null)
    const candidates = graduated.slice(-this.p.maxTracked)
    for (const l of candidates) {
      const key = l.token.toLowerCase()
      if (this.history.has(key)) continue
      const spot = await ctx.market.spotPrice(l.token)
      if (!spot) continue
      this.history.set(key, { token: l.token, symbol: shortToken(l.token), samples: [{ ts: ctx.now, priceUsd: spot.priceUsd }] })
    }
    // Evict tokens no longer in the discovered window to keep the tracked set fresh.
    const keep = new Set(candidates.map((l) => l.token.toLowerCase()))
    for (const key of [...this.history.keys()]) {
      if (!keep.has(key) && !ctx.positions.some((p) => p.token.toLowerCase() === key)) this.history.delete(key)
    }
  }
}

function shortToken(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
