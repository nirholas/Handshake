import type { PriceMoveEvent } from '../events.js'

interface Sample {
  at: number
  priceUsd: number
}

/**
 * Rolling-window price-move detector. Feed it every Chainlink tick; it emits a
 * {@link PriceMoveEvent} when the change from the oldest in-window sample
 * exceeds `minEmitPct`. After an emit the window resets to the current price,
 * so the same leg never re-alerts; a continuing move alerts again only after
 * moving `minEmitPct` further. Pure logic, unit-tested on captured feed data.
 */
export class PriceMoveTracker {
  private readonly samples = new Map<string, Sample[]>()

  constructor(
    private readonly windowS: number,
    private readonly minEmitPct: number,
  ) {}

  update(symbol: string, priceUsd: number, atS: number): PriceMoveEvent | null {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null
    const list = this.samples.get(symbol) ?? []
    // Evict out-of-window samples.
    const cutoff = atS - this.windowS
    while (list.length > 0 && (list[0] as Sample).at < cutoff) list.shift()

    if (list.length > 0) {
      const oldest = list[0] as Sample
      const pct = ((priceUsd - oldest.priceUsd) / oldest.priceUsd) * 100
      if (Math.abs(pct) >= this.minEmitPct) {
        this.samples.set(symbol, [{ at: atS, priceUsd }])
        return {
          type: 'price_move',
          symbol,
          pct,
          fromUsd: oldest.priceUsd,
          toUsd: priceUsd,
          windowS: this.windowS,
          at: atS,
        }
      }
    }
    list.push({ at: atS, priceUsd })
    this.samples.set(symbol, list)
    return null
  }
}
