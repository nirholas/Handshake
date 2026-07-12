import { erc20Abi, watchLaunches, type Launch } from 'hoodchain'
import { formatUnits, parseEther, type Address } from 'viem'
import type {
  Strategy,
  StrategyMeta,
  StrategyStartContext,
  StrategyTickContext,
} from '../framework/strategy.js'
import type { Decision, Intent, Alert } from '../framework/types.js'

/** Tunables for {@link LaunchSniper}. */
export interface LaunchSniperParams {
  /** WETH spent per entry. */
  entryWeth: number
  /** Take profit as a fraction (0.5 = +50%). */
  takeProfitPct: number
  /** Stop loss as a fraction (0.3 = -30%). */
  stopLossPct: number
  /** Force-exit a position after this many seconds regardless of PnL. */
  maxHoldSeconds: number
  /** Reject a launch if the deployer still holds more than this fraction of supply. */
  maxDeployerPct: number
  /** Reject if an immediate buy→sell round trip would lose more than this fraction (honeypot/thin-pool guard). */
  maxRoundTripLossPct: number
  /** Only consider launches at most this many seconds old when first seen. */
  maxLaunchAgeSeconds: number
}

const DEFAULTS: LaunchSniperParams = {
  entryWeth: 0.01,
  takeProfitPct: 0.6,
  stopLossPct: 0.35,
  maxHoldSeconds: 30 * 60,
  maxDeployerPct: 0.15,
  maxRoundTripLossPct: 0.35,
  maxLaunchAgeSeconds: 5 * 60,
}

interface Candidate {
  launch: Launch
  seenAt: number
}

/**
 * launch-sniper — enter brand-new launchpad coins that clear objective safety
 * filters, then exit on take-profit, stop, or a hard time limit.
 *
 * EDGE HYPOTHESIS: the first minutes after a NOXA instant-listing are the most
 * information-rich and most volatile window a memecoin ever has. A disciplined
 * buyer who (a) only touches tokens that are actually round-trippable (not
 * honeypots) and whose deployer is not sitting on the supply, and (b) exits
 * mechanically instead of falling in love, harvests a slice of that opening
 * volatility. The edge is speed + discipline, not prediction.
 *
 * FAILURE MODES: most new launches go to zero — the stop loss WILL fire often
 * and the strategy is negative-carry unless the winners pay for the losers.
 * Honeypots evolve (sell-tax toggled AFTER you buy); the round-trip check only
 * sees the state at entry. Odyssey tokens on the bonding curve have no Uniswap
 * pool yet, so they are skipped until graduation — this strategy is really a
 * NOXA/graduated-pool sniper. Paper fills assume the QuoterV2 mid; a real
 * sniper competes with faster bots and eats worse fills.
 */
export class LaunchSniper implements Strategy {
  readonly id = 'launch-sniper'
  readonly title = 'Launch Sniper'
  readonly quote = 'weth' as const
  private readonly p: LaunchSniperParams
  private readonly queue: Candidate[] = []
  private readonly seen = new Set<string>()
  private unwatch: (() => void) | null = null

  constructor(params: Partial<LaunchSniperParams> = {}) {
    this.p = { ...DEFAULTS, ...params }
  }

  get meta(): StrategyMeta {
    return {
      edge:
        'Harvest opening-minutes volatility of freshly launched memecoins by buying only round-trippable, ' +
        'non-deployer-heavy launches and exiting mechanically on TP/stop/time.',
      failureModes: [
        'Most launches trend to zero — the stop loss fires frequently; profitability depends on winners covering losers.',
        'Honeypots can enable a sell tax AFTER entry; the entry-time round-trip check cannot see that.',
        'Odyssey bonding-curve tokens have no Uniswap pool pre-graduation and are skipped (this is effectively a NOXA sniper).',
        'Paper fills use the QuoterV2 mid; live, faster bots win the best fills and you eat slippage.',
      ],
      params: { ...this.p },
    }
  }

  start(ctx: StrategyStartContext): void {
    // Real-time launch subscription across NOXA + The Odyssey.
    this.unwatch = watchLaunches(
      ctx.market.client,
      (launch) => {
        const key = launch.token.toLowerCase()
        if (this.seen.has(key)) return
        this.seen.add(key)
        this.queue.push({ launch, seenAt: Date.now() })
        ctx.log(`new launch queued: ${launch.launchpad} ${launch.token}`, { creator: launch.creator })
      },
      { onError: (e) => ctx.log(`launch watcher error: ${e.message}`) },
    )
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  async tick(ctx: StrategyTickContext): Promise<Decision> {
    const intents: Intent[] = []
    const alerts: Alert[] = []

    // ── exits first (protect open risk before taking on more) ──────────────────
    for (const pos of ctx.positions) {
      const ageSec = (ctx.now - pos.openedAt) / 1000
      const pnlPct = pos.markUsd !== null && pos.investedUsd > 0 ? pos.markUsd / pos.investedUsd - 1 : null
      let exitReason: string | null = null
      if (pnlPct !== null && pnlPct >= this.p.takeProfitPct) exitReason = `take-profit ${(pnlPct * 100).toFixed(1)}%`
      else if (pnlPct !== null && pnlPct <= -this.p.stopLossPct) exitReason = `stop-loss ${(pnlPct * 100).toFixed(1)}%`
      else if (ageSec >= this.p.maxHoldSeconds) exitReason = `time-exit ${Math.round(ageSec)}s held`
      if (exitReason) {
        intents.push({
          side: 'sell',
          token: pos.token,
          tokenSymbol: pos.tokenSymbol,
          amountIn: pos.amount,
          quoteToken: pos.quoteToken,
          quoteSymbol: pos.quoteSymbol,
          reason: exitReason,
          meta: { pnlPct },
        })
      }
    }

    // ── one new entry per tick (evaluate the oldest queued candidate) ──────────
    const candidate = this.queue.shift()
    if (candidate) {
      const decisionOrReject = await this.evaluate(ctx, candidate)
      if (decisionOrReject.intent) intents.push(decisionOrReject.intent)
      else if (decisionOrReject.alert) alerts.push(decisionOrReject.alert)
    }

    return { intents, alerts }
  }

  private async evaluate(
    ctx: StrategyTickContext,
    candidate: Candidate,
  ): Promise<{ intent?: Intent; alert?: Alert }> {
    const { launch } = candidate
    const ageSec = (ctx.now - candidate.seenAt) / 1000
    if (ageSec > this.p.maxLaunchAgeSeconds) {
      return { alert: { level: 'info', message: `skip ${launch.token}: stale (${Math.round(ageSec)}s old)`, meta: {} } }
    }
    // already holding it?
    if (ctx.positions.some((p) => p.token.toLowerCase() === launch.token.toLowerCase())) return {}

    const amountIn = parseEther(String(this.p.entryWeth))

    // Filter 1 — route exists (Odyssey pre-graduation tokens fail here and are skipped).
    const buyQuote = await ctx.market.quoteBuy(ctx.quoteToken, launch.token, amountIn)
    if (!buyQuote || buyQuote.amountOut <= 0n) {
      return { alert: { level: 'info', message: `skip ${launch.token}: no liquid Uniswap route`, meta: { launchpad: launch.launchpad } } }
    }

    // Filter 2 — round-trip retention (honeypot / thin-pool guard).
    const sellQuote = await ctx.market.quoteSell(launch.token, ctx.quoteToken, buyQuote.amountOut)
    if (!sellQuote || sellQuote.amountOut <= 0n) {
      return { alert: { level: 'warn', message: `skip ${launch.token}: cannot sell back (honeypot?)`, meta: {} } }
    }
    const retention = Number(sellQuote.amountOut) / Number(amountIn)
    if (1 - retention > this.p.maxRoundTripLossPct) {
      return {
        alert: {
          level: 'warn',
          message: `skip ${launch.token}: round-trip loss ${((1 - retention) * 100).toFixed(1)}% > ${(this.p.maxRoundTripLossPct * 100).toFixed(0)}%`,
          meta: { retention },
        },
      }
    }

    // Filter 3 — deployer concentration.
    const deployerPct = await this.deployerConcentration(ctx, launch)
    if (deployerPct !== null && deployerPct > this.p.maxDeployerPct) {
      return {
        alert: {
          level: 'warn',
          message: `skip ${launch.token}: deployer holds ${(deployerPct * 100).toFixed(1)}% > ${(this.p.maxDeployerPct * 100).toFixed(0)}%`,
          meta: { deployerPct },
        },
      }
    }

    return {
      intent: {
        side: 'buy',
        token: launch.token,
        tokenSymbol: shortToken(launch.token),
        amountIn,
        quoteToken: ctx.quoteToken,
        quoteSymbol: ctx.quoteSymbol,
        reason: `sniped ${launch.launchpad} launch — retention ${(retention * 100).toFixed(1)}%, deployer ${deployerPct === null ? 'n/a' : (deployerPct * 100).toFixed(1) + '%'}`,
        meta: { launchpad: launch.launchpad, deployerPct, retention },
      },
    }
  }

  private async deployerConcentration(ctx: StrategyTickContext, launch: Launch): Promise<number | null> {
    try {
      const [supply, bal] = await ctx.market.client.public.multicall({
        contracts: [
          { address: launch.token, abi: erc20Abi, functionName: 'totalSupply' as const },
          { address: launch.token, abi: erc20Abi, functionName: 'balanceOf' as const, args: [launch.creator] as const },
        ],
        allowFailure: false,
      })
      if ((supply as bigint) === 0n) return null
      return Number(formatUnits((bal as bigint) * 10_000n / (supply as bigint), 4))
    } catch {
      return null
    }
  }
}

function shortToken(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
