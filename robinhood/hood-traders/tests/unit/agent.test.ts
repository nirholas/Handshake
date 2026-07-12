import { afterEach, describe, expect, it } from 'vitest'
import { parseEther, parseUnits, type Address } from 'viem'
import { Agent } from '../../src/framework/agent.js'
import { Journal } from '../../src/framework/journal.js'
import { KillSwitch } from '../../src/framework/kill.js'
import type { Market } from '../../src/framework/market.js'
import type { Strategy, StrategyTickContext } from '../../src/framework/strategy.js'
import type { Decision, Intent, RiskLimits } from '../../src/framework/types.js'
import { FakeMarket } from './helpers/fake-market.js'

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const TOKEN_A = '0x2222222222222222222222222222222222222b' as Address

/** A test strategy that returns whatever intents the test enqueues, one shot per tick. */
class ScriptedStrategy implements Strategy {
  readonly id = 'scripted'
  readonly title = 'Scripted'
  readonly quote = 'usdg' as const
  readonly meta = { edge: 'test double', failureModes: ['n/a'], params: {} }
  private queue: Intent[][] = []

  enqueue(intents: Intent[]): void {
    this.queue.push(intents)
  }

  async tick(_ctx: StrategyTickContext): Promise<Decision> {
    const intents = this.queue.shift() ?? []
    return { intents, alerts: [] }
  }
}

function buyIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    side: 'buy',
    token: TOKEN_A,
    tokenSymbol: 'MEME',
    amountIn: parseUnits('10', 6), // 10 USDG
    quoteToken: USDG,
    quoteSymbol: 'USDG',
    reason: 'test entry',
    ...overrides,
  }
}

const LIMITS: RiskLimits = {
  maxPositionUsdg: 50,
  maxDailySpendUsdg: 100,
  maxSlippageBps: 100,
  cooldownSeconds: 0,
}

function makeAgent(opts: {
  market: FakeMarket
  journal: Journal
  kill: KillSwitch
  strategy: ScriptedStrategy
  limits?: RiskLimits
  fleetMaxDailySpendUsdg?: number
  clock?: () => number
}) {
  let fleetSpent = 0
  return new Agent({
    id: 'agent-1',
    strategy: opts.strategy,
    market: opts.market as unknown as Market,
    limits: opts.limits ?? LIMITS,
    journal: opts.journal,
    kill: opts.kill,
    mode: 'paper',
    account: null,
    fleetMaxDailySpendUsdg: opts.fleetMaxDailySpendUsdg ?? 250,
    fleetSpentTodayUsd: () => fleetSpent,
    reportFleetSpend: (usd) => {
      fleetSpent += usd
    },
    tickIntervalMs: 999_999_999, // never auto-fires; tests call tick() directly
    clock: opts.clock,
  })
}

describe('Agent — risk cap enforcement end-to-end', () => {
  let journal: Journal
  let kill: KillSwitch

  afterEach(() => {
    journal?.close()
    kill?.dispose()
  })

  it('executes a paper trade that clears every risk check and journals it', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9.5', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const agent = makeAgent({ market, journal, kill, strategy })

    await agent.tick()

    const status = agent.status()
    expect(status.trades).toBe(1)
    expect(status.refusals).toBe(0)
    const trades = journal.recentTrades('agent-1', 1)
    expect(trades).toHaveLength(1)
    expect(trades[0]?.side).toBe('buy')
    expect(trades[0]?.mode).toBe('paper')
    expect(trades[0]?.txHash).toBeNull()
  })

  it('refuses an intent that would breach the per-position cap and journals the refusal', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    // 10 USDG notional but the cap is 5 — must refuse.
    strategy.enqueue([buyIntent({ amountIn: parseUnits('10', 6) })])
    const agent = makeAgent({ market, journal, kill, strategy, limits: { ...LIMITS, maxPositionUsdg: 5 } })

    await agent.tick()

    const status = agent.status()
    expect(status.trades).toBe(0)
    expect(status.refusals).toBe(1)
    const decisions = journal.recentDecisions('agent-1', 5)
    expect(decisions.some((d) => d.kind === 'refused' && d.meta.reason === 'position_cap')).toBe(true)
  })

  it('refuses once the per-agent daily spend cap is reached across multiple ticks', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    // Cap is 100; three 40-USDG buys — the third must be refused (spent would hit 120).
    strategy.enqueue([buyIntent({ amountIn: parseUnits('40', 6) })])
    strategy.enqueue([buyIntent({ amountIn: parseUnits('40', 6) })])
    strategy.enqueue([buyIntent({ amountIn: parseUnits('40', 6) })])
    const agent = makeAgent({
      market,
      journal,
      kill,
      strategy,
      limits: { ...LIMITS, maxPositionUsdg: 1000, maxDailySpendUsdg: 100, cooldownSeconds: 0 },
    })

    await agent.tick()
    await agent.tick()
    await agent.tick()

    const status = agent.status()
    expect(status.trades).toBe(2)
    expect(status.refusals).toBe(1)
    expect(status.spentTodayUsd).toBeCloseTo(80, 6)
  })

  it('refuses an order whose slippage bound exceeds the agent cap', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent({ maxSlippageBps: 500 })]) // cap is 100
    const agent = makeAgent({ market, journal, kill, strategy })

    await agent.tick()

    expect(agent.status().trades).toBe(0)
    expect(agent.status().refusals).toBe(1)
    const decisions = journal.recentDecisions('agent-1', 5)
    expect(decisions.some((d) => d.meta.reason === 'slippage_bound')).toBe(true)
  })

  it('refuses every subsequent intent once the kill switch trips mid-loop', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9.5', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([buyIntent()])
    strategy.enqueue([buyIntent()])
    const agent = makeAgent({ market, journal, kill, strategy })

    await agent.tick() // fills
    kill.trip('test-mid-loop')
    await agent.tick() // must refuse — kill switch is now tripped
    await agent.tick() // still refuses

    const status = agent.status()
    expect(status.trades).toBe(1)
    expect(status.killed).toBe(true)
    const decisions = journal.recentDecisions('agent-1', 10)
    expect(decisions.filter((d) => d.meta.reason === 'kill_switch')).toHaveLength(0) // agent halts before even asking the strategy
  })

  it('halts proposing new intents once killed, even though the strategy still emits them', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    kill.trip('pre-tripped')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    const agent = makeAgent({ market, journal, kill, strategy })

    await agent.tick()

    expect(agent.status().trades).toBe(0)
    expect(agent.status().killed).toBe(true)
  })

  it('respects the cooldown between trades', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9.5', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent()])
    strategy.enqueue([buyIntent()])
    let now = 0
    const agent = makeAgent({
      market,
      journal,
      kill,
      strategy,
      limits: { ...LIMITS, cooldownSeconds: 60 },
      clock: () => now,
    })

    now = 0
    await agent.tick() // fills
    now = 5_000 // only 5s later — inside the 60s cooldown
    await agent.tick() // must refuse

    const status = agent.status()
    expect(status.trades).toBe(1)
    expect(status.refusals).toBe(1)
  })

  it('exempts a de-risking sell from the position/daily caps', async () => {
    journal = new Journal(':memory:')
    kill = new KillSwitch('/nonexistent/KILL')
    const market = new FakeMarket()
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9.5', 6))
    const strategy = new ScriptedStrategy()
    strategy.enqueue([buyIntent({ amountIn: parseUnits('40', 6) })])
    const agent = makeAgent({
      market,
      journal,
      kill,
      strategy,
      limits: { ...LIMITS, maxPositionUsdg: 45, maxDailySpendUsdg: 45, cooldownSeconds: 0 },
    })
    await agent.tick() // buy 40 USDG, hits near the caps

    // Now propose a huge sell — 1000 tokens, notional value from sellRoutes far
    // exceeds both caps but must NOT be refused because it reduces risk.
    market.sellRoutes.set(TOKEN_A.toLowerCase(), parseUnits('9999', 6))
    strategy.enqueue([
      { side: 'sell', token: TOKEN_A, tokenSymbol: 'MEME', amountIn: parseEther('1000'), quoteToken: USDG, quoteSymbol: 'USDG', reason: 'test exit' },
    ])
    await agent.tick()

    const status = agent.status()
    expect(status.trades).toBe(2)
    expect(status.refusals).toBe(0)
  })
})
