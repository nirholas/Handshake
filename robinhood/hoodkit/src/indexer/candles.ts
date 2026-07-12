/** Supported candle intervals. */
export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

/** Interval string → seconds. */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

/** One trade fed into {@link buildCandles}. */
export interface TradePoint {
  /** Unix seconds. */
  ts: number
  /** Executed price (quote per base). */
  price: number
  /** Trade volume in base-token units. */
  volume: number
}

/** An OHLCV candle. */
export interface Candle {
  /** Bucket start, unix seconds (aligned to the interval). */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Summed base-token volume in the bucket. */
  volume: number
  /** Number of trades in the bucket. */
  trades: number
}

/**
 * Build OHLCV candles from raw trades. Trades are bucketed by
 * `floor(ts / intervalSec) * intervalSec`; each bucket's open/close are the
 * first/last trade **by time order**, high/low the extremes, volume the sum.
 *
 * Input need not be pre-sorted — it is sorted by `ts` internally. Buckets with
 * no trades are omitted (sparse series); call {@link fillGaps} to forward-fill.
 */
export function buildCandles(trades: readonly TradePoint[], intervalSec: number): Candle[] {
  if (intervalSec <= 0) throw new Error('intervalSec must be positive')
  const sorted = [...trades].sort((a, b) => a.ts - b.ts)
  const buckets = new Map<number, Candle>()

  for (const trade of sorted) {
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue
    const time = Math.floor(trade.ts / intervalSec) * intervalSec
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, {
        time,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.volume,
        trades: 1,
      })
    } else {
      existing.high = Math.max(existing.high, trade.price)
      existing.low = Math.min(existing.low, trade.price)
      existing.close = trade.price
      existing.volume += trade.volume
      existing.trades += 1
    }
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

/**
 * Forward-fill gaps between candles: for every empty interval between two
 * populated buckets, emit a flat candle at the previous close with zero volume.
 * Produces a continuous series suitable for charting.
 */
export function fillGaps(candles: readonly Candle[], intervalSec: number): Candle[] {
  if (candles.length === 0) return []
  const out: Candle[] = []
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i] as Candle
    out.push(current)
    const next = candles[i + 1]
    if (!next) break
    for (let t = current.time + intervalSec; t < next.time; t += intervalSec) {
      out.push({ time: t, open: current.close, high: current.close, low: current.close, close: current.close, volume: 0, trades: 0 })
    }
  }
  return out
}
