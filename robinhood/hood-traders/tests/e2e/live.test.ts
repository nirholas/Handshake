/**
 * Real E2E — no mocks. Talks to live Robinhood Chain mainnet RPC through the
 * full Market → Agent → Journal pipeline. This is the fast confirmation that
 * every layer wires to a real chain; the ≥30-minute paper soak (see README /
 * docs/architecture.html) is run separately as a long-lived process because a
 * 30-minute `it()` block is a poor fit for a CI-style test run.
 *
 * Run: npm run test:e2e
 */
import { afterEach, describe, expect, it } from 'vitest'
import { loadFleetConfig } from '../../src/framework/config.js'
import { Fleet } from '../../src/framework/fleet.js'
import { Market } from '../../src/framework/market.js'
import { LaunchSniper } from '../../src/strategies/launch-sniper.js'
import { Momentum } from '../../src/strategies/momentum.js'
import { PremiumWatch } from '../../src/strategies/premium-watch.js'

describe('live: mainnet reads through the Market adapter', () => {
  const market = new Market(loadFleetConfig({ HOOD_NETWORK: 'mainnet' } as NodeJS.ProcessEnv))

  it('reads the current mainnet block number', async () => {
    const bn = await market.blockNumber()
    expect(bn).toBeGreaterThan(7_000_000n) // mainnet launched 2026-07-01; sanity floor
  })

  it('reads a live Chainlink stock quote (AAPL)', async () => {
    const quote = await market.stockChainlinkPrice('AAPL')
    expect(quote).not.toBeNull()
    expect(quote!.priceUsd).toBeGreaterThan(0)
  })

  it('resolves a real ETH/USD reference from the on-chain USDG/WETH pool', async () => {
    const eth = await market.ethUsd(0) // force a fresh read, bypass cache
    expect(eth).not.toBeNull()
    expect(eth!).toBeGreaterThan(0)
  })

  it('quotes a real Uniswap v3 route (USDG -> WETH)', async () => {
    const q = await market.quoteBuy(market.usdg, market.weth, 10_000_000n) // 10 USDG
    expect(q).not.toBeNull()
    expect(q!.amountOut).toBeGreaterThan(0n)
  })
})

describe('live: a full fleet boots against mainnet and ticks without error', () => {
  let fleet: Fleet

  afterEach(() => {
    fleet?.close()
  })

  it('runs one real tick per agent against live data with zero errors', async () => {
    const config = loadFleetConfig({ HOOD_NETWORK: 'mainnet', HOOD_TRADERS_DB: ':memory:' } as NodeJS.ProcessEnv)
    fleet = new Fleet(config)
    fleet.addAgents([
      { id: 'e2e-sniper', strategy: new LaunchSniper(), tickIntervalMs: 999_999_999 },
      { id: 'e2e-momentum', strategy: new Momentum(), tickIntervalMs: 999_999_999 },
      { id: 'e2e-premium', strategy: new PremiumWatch(), tickIntervalMs: 999_999_999 },
    ])
    fleet.kill.arm()
    // One real pass through observe/decide/simulate/journal per agent, against
    // live mainnet data, without arming fleet.start()'s interval scheduler.
    await fleet.tickAllOnce()

    const statuses = fleet.agentStatuses()
    expect(statuses).toHaveLength(3)
    for (const s of statuses) {
      expect(s.ticks).toBe(1)
      expect(s.lastError).toBeNull()
    }
  }, 60_000)
})
