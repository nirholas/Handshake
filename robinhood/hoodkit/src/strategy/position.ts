/** A single fill fed into a {@link Position}. */
export interface Fill {
  side: 'buy' | 'sell'
  /** Token quantity filled (human units). */
  quantity: number
  /** Execution price per token, in the quote asset (e.g. USD). */
  price: number
  /** Fee paid in the quote asset. @defaultValue `0` */
  fee?: number
  /** Unix seconds. Optional; used only for reporting. */
  timestamp?: number
}

/** A point-in-time PnL snapshot. */
export interface PnlSnapshot {
  quantity: number
  /** Weighted-average cost per token (quote asset). */
  averageCost: number
  /** Realized PnL banked from sells so far (quote asset, fees included). */
  realized: number
  /** Unrealized PnL at `markPrice`. */
  unrealized: number
  /** Position market value at `markPrice`. */
  marketValue: number
  /** realized + unrealized. */
  total: number
  /** Share-equivalent quantity if a multiplier was supplied (else equals `quantity`). */
  shareEquivalent: number
}

/**
 * A multiplier-aware position tracker with weighted-average-cost PnL.
 *
 * PnL is computed in the **quote asset per token**. Robinhood's Chainlink feeds
 * are total-return (already multiplier-adjusted), so comparing average cost per
 * token to the current per-token price is corporate-action correct without
 * re-applying `uiMultiplier` — a reinvested dividend shows up as a price move,
 * captured in unrealized PnL. The multiplier is used only to report
 * share-equivalent quantity.
 */
export class Position {
  private qty = 0
  private avgCost = 0
  private realizedPnl = 0
  /** 1e18-scaled ERC-8056 multiplier for share-equivalent reporting. */
  multiplier: bigint

  constructor(options: { multiplier?: bigint } = {}) {
    this.multiplier = options.multiplier ?? 10n ** 18n
  }

  /** Apply a fill, updating average cost (buys) or banking realized PnL (sells). */
  record(fill: Fill): void {
    const fee = fill.fee ?? 0
    if (fill.quantity <= 0) throw new Error('fill.quantity must be positive')
    if (fill.side === 'buy') {
      const cost = this.avgCost * this.qty + fill.price * fill.quantity + fee
      this.qty += fill.quantity
      this.avgCost = this.qty > 0 ? cost / this.qty : 0
    } else {
      const sold = Math.min(fill.quantity, this.qty)
      this.realizedPnl += (fill.price - this.avgCost) * sold - fee
      this.qty -= sold
      if (this.qty <= 1e-12) {
        this.qty = 0
        this.avgCost = 0
      }
    }
  }

  /** Current token quantity. */
  get quantity(): number {
    return this.qty
  }

  /** Weighted-average cost per token. */
  get averageCost(): number {
    return this.avgCost
  }

  /** Realized PnL banked so far. */
  get realized(): number {
    return this.realizedPnl
  }

  /** Share-equivalent quantity given the current multiplier. */
  get shareEquivalent(): number {
    return (this.qty * Number(this.multiplier)) / 1e18
  }

  /** Unrealized PnL at `markPrice`. */
  unrealized(markPrice: number): number {
    return (markPrice - this.avgCost) * this.qty
  }

  /** Full PnL snapshot at `markPrice`. */
  snapshot(markPrice: number): PnlSnapshot {
    const unrealized = this.unrealized(markPrice)
    return {
      quantity: this.qty,
      averageCost: this.avgCost,
      realized: this.realizedPnl,
      unrealized,
      marketValue: markPrice * this.qty,
      total: this.realizedPnl + unrealized,
      shareEquivalent: this.shareEquivalent,
    }
  }
}
