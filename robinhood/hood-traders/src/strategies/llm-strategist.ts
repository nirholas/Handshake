import { erc20Abi, watchLaunches, type Launch } from 'hoodchain'
import { formatUnits, parseEther, type Address } from 'viem'
import type {
  Strategy,
  StrategyMeta,
  StrategyStartContext,
  StrategyTickContext,
} from '../framework/strategy.js'
import type { Decision, Intent, Alert } from '../framework/types.js'
import { judgeLaunch, type LlmClientConfig, type LlmVerdict } from '../framework/llm.js'

/** Tunables for {@link LlmStrategist}. */
export interface LlmStrategistParams {
  llm: LlmClientConfig
  /** WETH spent per entry when the LLM says buy. */
  entryWeth: number
  /** Take profit as a fraction (0.5 = +50%). */
  takeProfitPct: number
  /** Stop loss as a fraction (0.3 = -30%). */
  stopLossPct: number
  /** Force-exit a position after this many seconds regardless of PnL. */
  maxHoldSeconds: number
  /** Minimum LLM confidence required to convert a `buy` verdict into an Intent. */
  minConfidence: number
  /** Only consider launches at most this many seconds old when first seen. */
  maxLaunchAgeSeconds: number
}

const DEFAULTS: Omit<LlmStrategistParams, 'llm'> = {
  entryWeth: 0.01,
  takeProfitPct: 0.6,
  stopLossPct: 0.35,
  maxHoldSeconds: 30 * 60,
  minConfidence: 0.6,
  maxLaunchAgeSeconds: 5 * 60,
}

interface Candidate {
  launch: Launch
  seenAt: number
}

/**
 * llm-strategist — an LLM (bring your own key: Claude, OpenAI, Groq, or
 * OpenRouter) judges each new launch from the same real on-chain signals
 * launch-sniper uses mechanically (round-trip retention, deployer
 * concentration), instead of applying fixed threshold cutoffs.
 *
 * EDGE HYPOTHESIS: launch-sniper's hard cutoffs treat every signal
 * independently — a launch either clears every threshold or it doesn't. A
 * model can weigh weak, correlated signals holistically (e.g. "retention is
 * only okay but deployer concentration is very low" vs "retention is great
 * but deployer concentration is borderline") and may make better marginal
 * calls than a fixed rule. It cannot see anything launch-sniper can't — same
 * inputs, different judgment function.
 *
 * FAILURE MODES: an LLM can be confidently wrong — high stated confidence is
 * not calibrated probability, and this strategy trusts it anyway once it
 * clears `minConfidence`. On-chain metadata (token/creator addresses, launch
 * names if ever added to the brief) is attacker-controlled input reaching the
 * model — a prompt-injection payload disguised as a token name could attempt
 * to manipulate the verdict; the current brief only includes numeric signals
 * for this reason, but any future addition of free-text on-chain fields to
 * the brief must be treated as untrusted. LLM latency means this strategy
 * reacts slower than launch-sniper to the same launch. Every LLM call costs
 * money regardless of verdict; a launch storm inflates API spend with no
 * trading to show for it. A single configured provider has no fallback — a
 * provider outage silently means zero coverage for the outage's duration.
 */
export class LlmStrategist implements Strategy {
  readonly id = 'llm-strategist'
  readonly title = 'LLM Strategist'
  readonly quote = 'weth' as const
  private readonly p: LlmStrategistParams
  private readonly queue: Candidate[] = []
  private readonly seen = new Set<string>()
  private readonly judged = new Set<string>()
  private unwatch: (() => void) | null = null

  constructor(params: Partial<Omit<LlmStrategistParams, 'llm'>> & { llm: LlmClientConfig }) {
    this.p = { ...DEFAULTS, ...params }
  }

  get meta(): StrategyMeta {
    return {
      edge:
        'An LLM (bring your own key) weighs the same real on-chain launch signals launch-sniper checks ' +
        'mechanically — buy/sell round-trip retention and deployer supply concentration — holistically ' +
        'instead of against fixed cutoffs, and only trades when its stated confidence clears a threshold.',
      failureModes: [
        'LLM confidence is not calibrated probability — a confidently wrong verdict trades exactly like a confidently right one.',
        'On-chain data reaching the prompt is attacker-controlled; only numeric signals are included today specifically to limit prompt-injection surface.',
        'LLM round-trip latency means this strategy reacts to a launch after launch-sniper already has (or hasn’t).',
        'Every judged launch costs a real LLM API call regardless of verdict — a launch storm inflates spend with nothing to show for it.',
        'One configured provider, no fallback chain — a provider outage means zero coverage until it recovers.',
      ],
      params: { ...this.p, llm: { ...this.p.llm, apiKey: this.p.llm.apiKey ? '<redacted>' : '' } },
    }
  }

  start(ctx: StrategyStartContext): void {
    this.unwatch = watchLaunches(
      ctx.market.client,
      (launch) => {
        const key = launch.token.toLowerCase()
        if (this.seen.has(key)) return
        this.seen.add(key)
        this.queue.push({ launch, seenAt: Date.now() })
        ctx.log(`llm-strategist: new launch queued: ${launch.launchpad} ${launch.token}`, { creator: launch.creator })
      },
      { onError: (e) => ctx.log(`llm-strategist: launch watcher error: ${e.message}`) },
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

    // ── one new candidate judged per tick ───────────────────────────────────────
    const candidate = this.queue.shift()
    if (candidate) {
      const key = candidate.launch.token.toLowerCase()
      if (!this.judged.has(key)) {
        this.judged.add(key)
        const result = await this.evaluate(ctx, candidate)
        if (result.intent) intents.push(result.intent)
        if (result.alert) alerts.push(result.alert)
      }
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
      return { alert: { level: 'info', message: `llm-strategist: skip ${launch.token}: stale (${Math.round(ageSec)}s old)`, meta: {} } }
    }
    if (ctx.positions.some((p) => p.token.toLowerCase() === launch.token.toLowerCase())) return {}

    const amountIn = parseEther(String(this.p.entryWeth))

    const buyQuote = await ctx.market.quoteBuy(ctx.quoteToken, launch.token, amountIn)
    if (!buyQuote || buyQuote.amountOut <= 0n) {
      return { alert: { level: 'info', message: `llm-strategist: skip ${launch.token}: no liquid Uniswap route`, meta: { launchpad: launch.launchpad } } }
    }
    const sellQuote = await ctx.market.quoteSell(launch.token, ctx.quoteToken, buyQuote.amountOut)
    const retention = sellQuote && sellQuote.amountOut > 0n ? Number(sellQuote.amountOut) / Number(amountIn) : 0
    const deployerPct = await this.deployerConcentration(ctx, launch)

    const brief = [
      `Launchpad: ${launch.launchpad}`,
      `Round-trip retention (buy then immediately sell back): ${(retention * 100).toFixed(1)}% of input value returned.`,
      `Deployer wallet holds: ${deployerPct === null ? 'unknown (could not read on-chain balance)' : (deployerPct * 100).toFixed(1) + '% of total supply'}.`,
      `Age since first seen: ${Math.round(ageSec)} seconds.`,
    ].join('\n')

    let verdict: LlmVerdict
    try {
      verdict = await judgeLaunch(this.p.llm, brief)
    } catch (err) {
      return {
        alert: {
          level: 'warn',
          message: `llm-strategist: skip ${launch.token}: LLM judge failed — ${(err as Error).message}`,
          meta: { launchpad: launch.launchpad },
        },
      }
    }

    if (!verdict.buy || verdict.confidence < this.p.minConfidence) {
      return {
        alert: {
          level: 'info',
          message: `llm-strategist: skip ${launch.token}: verdict buy=${verdict.buy} confidence=${verdict.confidence.toFixed(2)} — ${verdict.thesis}`,
          meta: { retention, deployerPct, verdict },
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
        reason: `LLM (${this.p.llm.provider}, confidence ${verdict.confidence.toFixed(2)}): ${verdict.thesis}`,
        meta: { launchpad: launch.launchpad, deployerPct, retention, llmProvider: this.p.llm.provider, confidence: verdict.confidence },
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
