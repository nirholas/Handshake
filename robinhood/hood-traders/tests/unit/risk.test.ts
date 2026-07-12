import { describe, expect, it } from 'vitest'
import { RiskEngine, utcDayStart } from '../../src/framework/risk.js'
import type { RiskContext } from '../../src/framework/risk.js'
import type { RiskLimits } from '../../src/framework/types.js'

const LIMITS: RiskLimits = {
  maxPositionUsdg: 50,
  maxDailySpendUsdg: 100,
  maxSlippageBps: 100,
  cooldownSeconds: 60,
}

function baseCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    side: 'buy',
    notionalUsd: 10,
    positionUsdAfter: 10,
    spentTodayUsd: 0,
    fleetSpentTodayUsd: 0,
    lastTradeAt: null,
    slippageBps: 50,
    killed: false,
    now: 1_000_000,
    fleetMaxDailySpendUsdg: 250,
    ...overrides,
  }
}

describe('RiskEngine', () => {
  it('approves an order within every limit', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx())
    expect(verdict.ok).toBe(true)
  })

  it('refuses when the kill switch is tripped, before any other check', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ killed: true, notionalUsd: -5 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('kill_switch')
  })

  it('refuses a buy that breaches the per-position cap', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ positionUsdAfter: 51 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('position_cap')
  })

  it('approves a buy exactly at the position cap boundary', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ positionUsdAfter: 50 }))
    expect(verdict.ok).toBe(true)
  })

  it('refuses a buy that breaches the per-agent daily spend cap', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ spentTodayUsd: 95, notionalUsd: 10, positionUsdAfter: 10 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('daily_cap')
  })

  it('refuses a buy that breaches the fleet-wide daily spend cap even under the per-agent cap', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(
      baseCtx({ notionalUsd: 10, positionUsdAfter: 10, fleetSpentTodayUsd: 245, fleetMaxDailySpendUsdg: 250 }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('fleet_daily_cap')
  })

  it('refuses an order whose slippage bound exceeds the cap', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ slippageBps: 150 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('slippage_bound')
  })

  it('refuses a trade inside the cooldown window', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ lastTradeAt: 990_000, now: 1_000_000 })) // 10s elapsed, cap 60s
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('cooldown')
  })

  it('approves a trade once the cooldown has fully elapsed', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(baseCtx({ lastTradeAt: 1_000_000 - 60_000, now: 1_000_000 }))
    expect(verdict.ok).toBe(true)
  })

  it('exempts sells from position and daily-spend caps', () => {
    const risk = new RiskEngine(LIMITS)
    const verdict = risk.check(
      baseCtx({ side: 'sell', notionalUsd: 1000, positionUsdAfter: 0, spentTodayUsd: 99, fleetSpentTodayUsd: 249 }),
    )
    expect(verdict.ok).toBe(true)
  })

  it('still refuses a sell during cooldown or under the kill switch', () => {
    const risk = new RiskEngine(LIMITS)
    expect(risk.check(baseCtx({ side: 'sell', killed: true })).reason).toBe('kill_switch')
    expect(risk.check(baseCtx({ side: 'sell', lastTradeAt: 999_990, now: 1_000_000 })).reason).toBe('cooldown')
  })

  it('refuses a zero or negative notional', () => {
    const risk = new RiskEngine(LIMITS)
    expect(risk.check(baseCtx({ notionalUsd: 0 })).reason).toBe('zero_amount')
    expect(risk.check(baseCtx({ notionalUsd: -1 })).reason).toBe('zero_amount')
  })

  it('checks are evaluated in a stable priority order (kill > amount > cooldown > slippage > caps)', () => {
    const risk = new RiskEngine(LIMITS)
    // Multiple violations at once — kill switch must win.
    const verdict = risk.check(
      baseCtx({ killed: true, notionalUsd: 0, slippageBps: 9999, positionUsdAfter: 999_999 }),
    )
    expect(verdict.reason).toBe('kill_switch')
  })
})

describe('utcDayStart', () => {
  it('returns the same boundary for two timestamps on the same UTC day', () => {
    const a = Date.UTC(2026, 6, 12, 0, 0, 1)
    const b = Date.UTC(2026, 6, 12, 23, 59, 59)
    expect(utcDayStart(a)).toBe(utcDayStart(b))
  })

  it('returns a different boundary across a UTC day rollover', () => {
    const a = Date.UTC(2026, 6, 12, 23, 59, 59)
    const b = Date.UTC(2026, 6, 13, 0, 0, 1)
    expect(utcDayStart(a)).not.toBe(utcDayStart(b))
  })
})
