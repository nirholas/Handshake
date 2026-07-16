import type { Address } from 'viem'
import type { LiquidityPullEvent } from '../events.js'

interface PoolState {
  token: Address | null
  quoteAsset: 'USDG' | 'WETH'
  /** Trailing samples of the pool's quote-side reserves in USD. */
  samples: Array<{ at: number; usd: number }>
}

/**
 * Rug early-warning: watches the quote-token reserves (USDG or WETH, valued in
 * USD) of tracked pools. A drop of `minEmitPct` percent from the trailing-window
 * maximum emits a {@link LiquidityPullEvent}; the baseline then resets to the
 * post-drop level so one pull alerts once. Balance polling catches every exit
 * path (burn + collect, direct transfers) without decoding position NFTs.
 */
export class LiquidityMonitor {
  private readonly pools = new Map<string, PoolState>()

  constructor(
    private readonly windowS: number,
    private readonly minEmitPct: number,
    /** Ignore pools below this many quote-USD (dust pools "rug" on noise). */
    private readonly minPoolUsd = 500,
  ) {}

  track(pool: Address, token: Address | null, quoteAsset: 'USDG' | 'WETH'): void {
    const key = pool.toLowerCase()
    if (!this.pools.has(key)) this.pools.set(key, { token, quoteAsset, samples: [] })
  }

  untrack(pool: Address): void {
    this.pools.delete(pool.toLowerCase())
  }

  tracked(): Address[] {
    return [...this.pools.keys()] as Address[]
  }

  quoteAssetOf(pool: Address): 'USDG' | 'WETH' | null {
    return this.pools.get(pool.toLowerCase())?.quoteAsset ?? null
  }

  update(pool: Address, quoteUsd: number, atS: number): LiquidityPullEvent | null {
    const state = this.pools.get(pool.toLowerCase())
    if (!state || !Number.isFinite(quoteUsd) || quoteUsd < 0) return null

    const cutoff = atS - this.windowS
    state.samples = state.samples.filter((s) => s.at >= cutoff)

    const peak = state.samples.reduce((max, s) => Math.max(max, s.usd), 0)
    state.samples.push({ at: atS, usd: quoteUsd })

    if (peak < this.minPoolUsd) return null
    const droppedPct = ((peak - quoteUsd) / peak) * 100
    if (droppedPct < this.minEmitPct) return null

    // Reset the baseline so the same pull does not re-alert every poll.
    state.samples = [{ at: atS, usd: quoteUsd }]
    return {
      type: 'liquidity_pull',
      token: state.token,
      symbol: null,
      pool,
      quoteAsset: state.quoteAsset,
      droppedPct,
      beforeUsd: peak,
      afterUsd: quoteUsd,
      at: atS,
    }
  }
}
