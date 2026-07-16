import type { Address } from 'viem'
import type { HolderMilestoneEvent } from '../events.js'

/** Milestones a token's holder count can cross (ascending). */
export const HOLDER_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000] as const

/**
 * Holder-count milestone detector. Feed it periodic counts (Blockscout
 * `token_holders_count`); it emits the highest newly-crossed milestone.
 * The first observation seeds the baseline without alerting, so subscribing
 * to an established token does not replay its whole history.
 */
export class HolderMilestones {
  private readonly lastCount = new Map<string, number>()

  update(token: Address, count: number, atS: number): HolderMilestoneEvent | null {
    if (!Number.isFinite(count) || count < 0) return null
    const key = token.toLowerCase()
    const previous = this.lastCount.get(key)
    this.lastCount.set(key, count)
    if (previous === undefined) return null

    let crossed: number | null = null
    for (const m of HOLDER_MILESTONES) {
      if (previous < m && count >= m) crossed = m
    }
    if (crossed === null) return null
    return { type: 'holders', token, symbol: null, milestone: crossed, count, at: atS }
  }

  /** Forget a token (unwatched). */
  forget(token: Address): void {
    this.lastCount.delete(token.toLowerCase())
  }
}
