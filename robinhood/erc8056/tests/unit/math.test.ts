import { describe, expect, it } from 'vitest'
import {
  adjustedPrice,
  fromUiAmount,
  MULTIPLIER_ONE,
  rawPrice,
  toUiAmount,
  trueBalance,
  trueValue,
} from '../../src/index.js'

// Real on-chain values, read from Robinhood Chain mainnet (chain 4663) at
// block 10745112 on 2026-07-15. See tests/live/live.test.ts for the reads.
const SGOV_MULTIPLIER = 1000957519890990718n
const WEEK_MULTIPLIER = 2006182524271844660n
const SGOV_TOTAL_SUPPLY = 7069093172680000000000n
const SGOV_TOTAL_SUPPLY_UI = 7075861970004107782455n
const WEEK_TOTAL_SUPPLY = 5949085750295341500n
const WEEK_TOTAL_SUPPLY_UI = 11934951867637169149n
const SGOV_FEED_USD = 100.62147097 // Chainlink answer 10062147097, 8 decimals

const ONE_TOKEN = 10n ** 18n

describe('trueBalance', () => {
  it('reproduces on-chain totalSupplyUI for SGOV bit-for-bit', () => {
    expect(trueBalance({ raw: SGOV_TOTAL_SUPPLY, multiplier: SGOV_MULTIPLIER })).toBe(
      SGOV_TOTAL_SUPPLY_UI,
    )
  })

  it('reproduces on-chain totalSupplyUI for WEEK bit-for-bit', () => {
    expect(trueBalance({ raw: WEEK_TOTAL_SUPPLY, multiplier: WEEK_MULTIPLIER })).toBe(
      WEEK_TOTAL_SUPPLY_UI,
    )
  })

  it('is identity at multiplier 1e18', () => {
    expect(trueBalance({ raw: 123456789n, multiplier: MULTIPLIER_ONE })).toBe(123456789n)
  })

  it('floors like the EVM (integer division)', () => {
    // 3 raw units at multiplier 1.5: 3 * 1.5 = 4.5 -> floors to 4
    expect(trueBalance({ raw: 3n, multiplier: 1_500_000_000_000_000_000n })).toBe(4n)
  })

  it('rejects non-positive multipliers and negative balances', () => {
    expect(() => trueBalance({ raw: 1n, multiplier: 0n })).toThrow(RangeError)
    expect(() => trueBalance({ raw: 1n, multiplier: -1n })).toThrow(RangeError)
    expect(() => trueBalance({ raw: -1n, multiplier: MULTIPLIER_ONE })).toThrow(RangeError)
  })
})

describe('toUiAmount / fromUiAmount', () => {
  it('round-trips exactly when divisible', () => {
    const raw = 10n * ONE_TOKEN
    const ui = toUiAmount(raw, WEEK_MULTIPLIER)
    expect(ui).toBe((raw * WEEK_MULTIPLIER) / MULTIPLIER_ONE)
    // Round-trip loses at most 1 base unit to flooring.
    const back = fromUiAmount(ui, WEEK_MULTIPLIER)
    expect(raw - back).toBeGreaterThanOrEqual(0n)
    expect(raw - back).toBeLessThanOrEqual(1n)
  })

  it('fromUiAmount inverts the multiplier direction', () => {
    // 2.006182524271844660 shares at WEEK's multiplier is one raw token.
    expect(fromUiAmount(WEEK_MULTIPLIER, WEEK_MULTIPLIER)).toBe(ONE_TOKEN)
  })

  it('rejects invalid inputs', () => {
    expect(() => toUiAmount(1n, 0n)).toThrow(RangeError)
    expect(() => fromUiAmount(-1n, MULTIPLIER_ONE)).toThrow(RangeError)
  })
})

describe('trueValue', () => {
  it('does NOT re-apply the multiplier to an adjusted (feed) price', () => {
    // 1 SGOV token at the real feed answer: worth exactly the feed answer.
    const value = trueValue({
      raw: ONE_TOKEN,
      multiplier: SGOV_MULTIPLIER,
      price: adjustedPrice(SGOV_FEED_USD),
    })
    expect(value).toBeCloseTo(100.62147097, 8)
    // The classic double-count bug would give ~100.72:
    expect(value).not.toBeCloseTo(100.62147097 * 1.000957519890990718, 2)
  })

  it('DOES apply the multiplier to a raw share price', () => {
    // The underlying share price implied by the feed: feed / multiplier.
    const sharePriceUsd = SGOV_FEED_USD / 1.000957519890990718
    const value = trueValue({
      raw: ONE_TOKEN,
      multiplier: SGOV_MULTIPLIER,
      price: rawPrice(sharePriceUsd),
    })
    // Applying the multiplier to the share price recovers the token price.
    expect(value).toBeCloseTo(SGOV_FEED_USD, 6)
  })

  it('adjusted and raw paths agree on the same economic position', () => {
    const raw = 42n * ONE_TOKEN
    const viaToken = trueValue({
      raw,
      multiplier: WEEK_MULTIPLIER,
      price: adjustedPrice(100.31), // hypothetical token price
    })
    const viaShares = trueValue({
      raw,
      multiplier: WEEK_MULTIPLIER,
      price: rawPrice(100.31 / 2.00618252427184466), // same as a share price
    })
    expect(viaToken).toBeCloseTo(viaShares, 6)
  })

  it('respects non-18 token decimals', () => {
    const value = trueValue({
      raw: 5_000_000n, // 5.0 tokens at 6 decimals
      multiplier: MULTIPLIER_ONE,
      price: adjustedPrice(2),
      decimals: 6,
    })
    expect(value).toBe(10)
  })

  it('rejects invalid inputs', () => {
    expect(() =>
      trueValue({ raw: -1n, multiplier: MULTIPLIER_ONE, price: adjustedPrice(1) }),
    ).toThrow(RangeError)
    expect(() => trueValue({ raw: 1n, multiplier: 0n, price: adjustedPrice(1) })).toThrow(
      RangeError,
    )
  })
})

describe('price constructors', () => {
  it('freeze their results and carry runtime discriminants', () => {
    const p = adjustedPrice(1.23)
    expect(p.usd).toBe(1.23)
    expect(p.adjusted).toBe(true)
    expect(Object.isFrozen(p)).toBe(true)
    const r = rawPrice(4.56)
    expect(r.adjusted).toBe(false)
    expect(Object.isFrozen(r)).toBe(true)
  })

  it('reject NaN, Infinity, and negative prices', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(() => adjustedPrice(bad)).toThrow(RangeError)
      expect(() => rawPrice(bad)).toThrow(RangeError)
    }
  })
})
