import { describe, expect, it } from 'vitest'
import { buildCandles, fillGaps, INTERVAL_SECONDS } from '../../src/indexer/candles.js'

describe('buildCandles', () => {
  it('computes open/high/low/close/volume correctly for a single bucket', () => {
    const trades = [
      { ts: 0, price: 10, volume: 1 },
      { ts: 10, price: 15, volume: 2 },
      { ts: 20, price: 8, volume: 3 },
      { ts: 30, price: 12, volume: 4 },
    ]
    const candles = buildCandles(trades, 60)
    expect(candles).toHaveLength(1)
    const c = candles[0]!
    expect(c.time).toBe(0)
    expect(c.open).toBe(10) // first trade by time
    expect(c.close).toBe(12) // last trade by time
    expect(c.high).toBe(15)
    expect(c.low).toBe(8)
    expect(c.volume).toBe(10) // 1+2+3+4
    expect(c.trades).toBe(4)
  })

  it('buckets trades into the correct interval-aligned time windows', () => {
    const trades = [
      { ts: 5, price: 100, volume: 1 },
      { ts: 65, price: 110, volume: 1 },
      { ts: 125, price: 120, volume: 1 },
    ]
    const candles = buildCandles(trades, 60)
    expect(candles.map((c) => c.time)).toEqual([0, 60, 120])
  })

  it('handles out-of-order input by sorting on ts first', () => {
    const trades = [
      { ts: 30, price: 3, volume: 1 },
      { ts: 10, price: 1, volume: 1 },
      { ts: 20, price: 2, volume: 1 },
    ]
    const candles = buildCandles(trades, 60)
    expect(candles[0]?.open).toBe(1) // ts=10 is earliest
    expect(candles[0]?.close).toBe(3) // ts=30 is latest
  })

  it('skips non-positive or non-finite prices', () => {
    const trades = [
      { ts: 0, price: 10, volume: 1 },
      { ts: 10, price: 0, volume: 1 },
      { ts: 20, price: -5, volume: 1 },
      { ts: 30, price: NaN, volume: 1 },
      { ts: 40, price: 20, volume: 1 },
    ]
    const candles = buildCandles(trades, 60)
    expect(candles[0]?.trades).toBe(2) // only the two valid trades counted
    expect(candles[0]?.high).toBe(20)
    expect(candles[0]?.low).toBe(10)
  })

  it('produces no candles for empty input', () => {
    expect(buildCandles([], 60)).toEqual([])
  })

  it('throws on non-positive interval', () => {
    expect(() => buildCandles([{ ts: 0, price: 1, volume: 1 }], 0)).toThrow()
  })

  it('every documented interval maps to the correct second count', () => {
    expect(INTERVAL_SECONDS['1m']).toBe(60)
    expect(INTERVAL_SECONDS['5m']).toBe(300)
    expect(INTERVAL_SECONDS['15m']).toBe(900)
    expect(INTERVAL_SECONDS['1h']).toBe(3600)
    expect(INTERVAL_SECONDS['4h']).toBe(14_400)
    expect(INTERVAL_SECONDS['1d']).toBe(86_400)
  })
})

describe('fillGaps', () => {
  it('forward-fills empty buckets between two populated candles at the previous close', () => {
    const candles = buildCandles(
      [
        { ts: 0, price: 100, volume: 1 },
        { ts: 180, price: 200, volume: 1 }, // 3 buckets later at interval=60
      ],
      60,
    )
    const filled = fillGaps(candles, 60)
    expect(filled.map((c) => c.time)).toEqual([0, 60, 120, 180])
    expect(filled[1]).toMatchObject({ open: 100, high: 100, low: 100, close: 100, volume: 0, trades: 0 })
    expect(filled[2]).toMatchObject({ open: 100, high: 100, low: 100, close: 100, volume: 0, trades: 0 })
    expect(filled[3]?.close).toBe(200)
  })

  it('returns the input unchanged when there are no gaps', () => {
    const candles = buildCandles(
      [
        { ts: 0, price: 1, volume: 1 },
        { ts: 60, price: 2, volume: 1 },
      ],
      60,
    )
    expect(fillGaps(candles, 60)).toHaveLength(2)
  })

  it('returns an empty array for empty input', () => {
    expect(fillGaps([], 60)).toEqual([])
  })
})
