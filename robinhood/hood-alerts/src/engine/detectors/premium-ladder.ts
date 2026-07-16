import type { Address } from 'viem'
import type { PremiumEvent } from '../events.js'

/** Rungs (absolute percent) at which premium/discount crossings emit. */
export const PREMIUM_LADDER = [1, 2, 3, 5, 10, 20, 50] as const

interface ArmState {
  /** Highest rung currently alerted, per direction. Re-arms when premium falls below it. */
  premium: number
  discount: number
}

/**
 * Ladder-crossing detector for the Stock Token arb signal. Each update
 * compares the DEX mid to the Chainlink feed; when |premium| crosses a rung
 * upward it emits once and stays silent until the value falls back below that
 * rung (hysteresis), so a premium oscillating around a threshold does not spam.
 */
export class PremiumLadder {
  private readonly armed = new Map<string, ArmState>()

  update(symbol: string, token: Address, pool: Address, dexUsd: number, feedUsd: number, atS: number): PremiumEvent | null {
    if (!Number.isFinite(dexUsd) || !Number.isFinite(feedUsd) || dexUsd <= 0 || feedUsd <= 0) return null
    const premiumPct = ((dexUsd - feedUsd) / feedUsd) * 100
    const direction: 'premium' | 'discount' = premiumPct >= 0 ? 'premium' : 'discount'
    const abs = Math.abs(premiumPct)

    const state = this.armed.get(symbol) ?? { premium: 0, discount: 0 }

    // Re-arm rungs the value has fallen below, both directions.
    if (abs < state.premium && direction === 'premium') state.premium = highestRungBelow(abs)
    if (abs < state.discount && direction === 'discount') state.discount = highestRungBelow(abs)
    if (direction === 'premium' && state.discount !== 0) state.discount = 0
    if (direction === 'discount' && state.premium !== 0) state.premium = 0

    const alerted = direction === 'premium' ? state.premium : state.discount
    let crossed: number | null = null
    for (const rung of PREMIUM_LADDER) {
      if (abs >= rung && rung > alerted) crossed = rung
    }
    this.armed.set(symbol, state)
    if (crossed === null) return null

    if (direction === 'premium') state.premium = crossed
    else state.discount = crossed
    return {
      type: 'premium',
      symbol,
      token,
      premiumPct,
      level: crossed,
      direction,
      dexUsd,
      feedUsd,
      pool,
      at: atS,
    }
  }
}

function highestRungBelow(abs: number): number {
  let out = 0
  for (const rung of PREMIUM_LADDER) if (abs >= rung) out = rung
  return out
}
