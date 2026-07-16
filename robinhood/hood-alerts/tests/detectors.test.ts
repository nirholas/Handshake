import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { PriceMoveTracker } from '../src/engine/detectors/prices.js'
import { PremiumLadder, PREMIUM_LADDER } from '../src/engine/detectors/premium-ladder.js'
import { HolderMilestones, HOLDER_MILESTONES } from '../src/engine/detectors/holders.js'
import { LiquidityMonitor } from '../src/engine/detectors/liquidity.js'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const prices = JSON.parse(readFileSync(join(FIXTURES, 'prices.json'), 'utf8')) as {
  prices: Array<{ symbol: string; priceUsd: number }>
}
// Anchor the state-machine tests on a real captured Chainlink price.
const REAL = prices.prices.find((p) => p.priceUsd > 1) ?? prices.prices[0]
const TOKEN = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address
const POOL = '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B' as Address

describe('PriceMoveTracker', () => {
  it('emits only when the move crosses the threshold, then resets its window', () => {
    const t = new PriceMoveTracker(900, 2)
    const base = (REAL as { priceUsd: number }).priceUsd
    expect(t.update('X', base, 0)).toBeNull() // seed
    expect(t.update('X', base * 1.01, 60)).toBeNull() // +1% < 2%
    const up = t.update('X', base * 1.03, 120) // +3% from seed
    expect(up?.type).toBe('price_move')
    expect(up?.pct).toBeCloseTo(3, 5)
    expect(up?.fromUsd).toBeCloseTo(base, 5)
    // Window reset: a further small move does not re-alert.
    expect(t.update('X', base * 1.035, 180)).toBeNull()
  })

  it('detects downward moves and reports a signed percent', () => {
    const t = new PriceMoveTracker(900, 5)
    expect(t.update('Y', 100, 0)).toBeNull()
    const down = t.update('Y', 94, 60)
    expect(down?.pct).toBeCloseTo(-6, 5)
    expect(down?.toUsd).toBe(94)
  })

  it('evicts out-of-window samples so an old price is not the baseline', () => {
    const t = new PriceMoveTracker(300, 2)
    expect(t.update('Z', 100, 0)).toBeNull()
    // 400s later the first sample is out of the 300s window; this becomes the new baseline.
    expect(t.update('Z', 130, 400)).toBeNull()
    expect(t.update('Z', 133, 420)?.pct).toBeCloseTo(2.307, 2)
  })

  it('ignores non-positive prices', () => {
    const t = new PriceMoveTracker(900, 1)
    expect(t.update('Q', 0, 0)).toBeNull()
    expect(t.update('Q', -5, 1)).toBeNull()
  })
})

describe('PremiumLadder (Stock Token arb signal)', () => {
  it('emits once per rung crossed upward and re-arms after falling below (hysteresis)', () => {
    const l = new PremiumLadder()
    const feed = (REAL as { priceUsd: number }).priceUsd
    // 3.2% premium: crosses rungs 1,2,3 -> emits highest = 3.
    const e1 = l.update('NVDA', TOKEN, POOL, feed * 1.032, feed, 1)
    expect(e1?.level).toBe(3)
    expect(e1?.direction).toBe('premium')
    expect(e1?.premiumPct).toBeCloseTo(3.2, 4)
    // Still 3.2%: no new rung.
    expect(l.update('NVDA', TOKEN, POOL, feed * 1.032, feed, 2)).toBeNull()
    // Jump to 5.5%: crosses rung 5.
    expect(l.update('NVDA', TOKEN, POOL, feed * 1.055, feed, 3)?.level).toBe(5)
    // Fall back under 3% then climb to 4% -> rung 3 re-arms and emits again.
    expect(l.update('NVDA', TOKEN, POOL, feed * 1.02, feed, 4)).toBeNull()
    expect(l.update('NVDA', TOKEN, POOL, feed * 1.04, feed, 5)?.level).toBe(3)
  })

  it('tracks discount crossings independently', () => {
    const l = new PremiumLadder()
    const feed = 100
    const d = l.update('AMD', TOKEN, POOL, 89, feed, 1) // -11% -> rung 10
    expect(d?.direction).toBe('discount')
    expect(d?.level).toBe(10)
    expect(d?.premiumPct).toBeCloseTo(-11, 5)
  })

  it('ignores invalid prices', () => {
    const l = new PremiumLadder()
    expect(l.update('X', TOKEN, POOL, 0, 100, 1)).toBeNull()
    expect(l.update('X', TOKEN, POOL, 100, 0, 1)).toBeNull()
  })

  it('exposes the rung ladder used by the UI', () => {
    expect(PREMIUM_LADDER).toContain(1)
    expect(PREMIUM_LADDER).toContain(50)
  })
})

describe('HolderMilestones', () => {
  it('seeds silently on first observation then emits the highest crossed milestone', () => {
    const h = new HolderMilestones()
    expect(h.update(TOKEN, 8, 1)).toBeNull() // seed, no replay
    const e = h.update(TOKEN, 120, 2) // crosses 10, 25, 50, 100 -> highest 100
    expect(e?.milestone).toBe(100)
    expect(e?.count).toBe(120)
  })

  it('does not re-alert a milestone already passed', () => {
    const h = new HolderMilestones()
    expect(h.update(TOKEN, 90, 1)).toBeNull()
    expect(h.update(TOKEN, 105, 2)?.milestone).toBe(100)
    expect(h.update(TOKEN, 110, 3)).toBeNull()
  })

  it('forgets a token on unwatch (re-seeds without replay)', () => {
    const h = new HolderMilestones()
    h.update(TOKEN, 40, 1)
    h.forget(TOKEN)
    expect(h.update(TOKEN, 300, 2)).toBeNull() // re-seed, silent
  })

  it('milestone ladder is ascending and covers small and large counts', () => {
    expect(HOLDER_MILESTONES[0]).toBe(10)
    expect(HOLDER_MILESTONES.at(-1)).toBe(100_000)
  })
})

describe('LiquidityMonitor (rug early-warning)', () => {
  it('emits when quote reserves drop past the threshold from the trailing peak', () => {
    const m = new LiquidityMonitor(1800, 30, 500)
    m.track(POOL, TOKEN, 'USDG')
    expect(m.update(POOL, 10_000, 0)).toBeNull() // baseline
    expect(m.update(POOL, 9_000, 60)).toBeNull() // -10%, under 30%
    const pull = m.update(POOL, 6_000, 120) // -40% from peak 10k
    expect(pull?.type).toBe('liquidity_pull')
    expect(pull?.droppedPct).toBeCloseTo(40, 5)
    expect(pull?.beforeUsd).toBe(10_000)
    expect(pull?.afterUsd).toBe(6_000)
    expect(pull?.quoteAsset).toBe('USDG')
  })

  it('resets the baseline after a pull so the same drain does not re-alert', () => {
    const m = new LiquidityMonitor(1800, 30, 500)
    m.track(POOL, TOKEN, 'USDG')
    m.update(POOL, 10_000, 0)
    expect(m.update(POOL, 5_000, 60)?.droppedPct).toBeCloseTo(50, 5)
    expect(m.update(POOL, 4_900, 120)).toBeNull()
  })

  it('ignores dust pools below the minimum', () => {
    const m = new LiquidityMonitor(1800, 30, 500)
    m.track(POOL, TOKEN, 'WETH')
    m.update(POOL, 200, 0)
    expect(m.update(POOL, 10, 60)).toBeNull() // peak 200 < minPoolUsd 500
  })

  it('tracks and untracks pools', () => {
    const m = new LiquidityMonitor(1800, 30)
    m.track(POOL, TOKEN, 'USDG')
    expect(m.tracked().map((p) => p.toLowerCase())).toContain(POOL.toLowerCase())
    expect(m.quoteAssetOf(POOL)).toBe('USDG')
    m.untrack(POOL)
    expect(m.tracked()).toHaveLength(0)
  })
})
