import { describe, it, expect } from 'vitest'
import { fullRangeTicks, isqrt, sortTokens, sqrtPriceX96FromAmounts } from '../../src/core/univ3-math.js'

describe('isqrt', () => {
  it('computes exact integer square roots', () => {
    expect(isqrt(0n)).toBe(0n)
    expect(isqrt(1n)).toBe(1n)
    expect(isqrt(4n)).toBe(2n)
    expect(isqrt(1_000_000n)).toBe(1_000n)
  })

  it('floors non-perfect squares', () => {
    expect(isqrt(2n)).toBe(1n)
    expect(isqrt(99n)).toBe(9n) // 9^2=81, 10^2=100
    expect(isqrt(24n)).toBe(4n) // 4^2=16, 5^2=25
  })

  it('handles very large numbers (2^192 scale, matching sqrtPriceX96 inputs)', () => {
    const n = 1n << 192n
    const root = isqrt(n)
    expect(root * root <= n).toBe(true)
    expect((root + 1n) * (root + 1n) > n).toBe(true)
  })
})

describe('sqrtPriceX96FromAmounts', () => {
  it('produces the canonical Q96 value for a 1:1 price', () => {
    const sqrtPriceX96 = sqrtPriceX96FromAmounts(1_000_000n, 1_000_000n)
    expect(sqrtPriceX96).toBe(1n << 96n)
  })

  it('scales correctly for a 4x price ratio (sqrt(4) = 2)', () => {
    const sqrtPriceX96 = sqrtPriceX96FromAmounts(1_000_000n, 4_000_000n)
    expect(sqrtPriceX96).toBe(2n * (1n << 96n))
  })

  it('throws on a zero amount0 (division by zero)', () => {
    expect(() => sqrtPriceX96FromAmounts(0n, 1n)).toThrow(RangeError)
  })
})

describe('fullRangeTicks', () => {
  it('produces ticks that are multiples of the spacing and within Uniswap v3 bounds', () => {
    for (const spacing of [1, 10, 60, 200]) {
      const { tickLower, tickUpper } = fullRangeTicks(spacing)
      expect(tickLower % spacing === 0).toBe(true)
      expect(tickUpper % spacing === 0).toBe(true)
      expect(tickLower).toBeGreaterThanOrEqual(-887272)
      expect(tickUpper).toBeLessThanOrEqual(887272)
      expect(tickLower).toBeLessThan(0)
      expect(tickUpper).toBeGreaterThan(0)
    }
  })

  it('matches the well-known full-range ticks for the 1% tier (spacing 200)', () => {
    const { tickLower, tickUpper } = fullRangeTicks(200)
    expect(tickLower).toBe(-887200)
    expect(tickUpper).toBe(887200)
  })
})

describe('sortTokens', () => {
  it('orders token0 < token1 by address regardless of input order', () => {
    const low = '0x0000000000000000000000000000000000000001'
    const high = '0xffffffffffffffffffffffffffffffffffffffff'
    const a = sortTokens({ address: high, amount: 100n }, { address: low, amount: 200n })
    expect(a.token0).toBe(low)
    expect(a.token1).toBe(high)
    expect(a.amount0).toBe(200n)
    expect(a.amount1).toBe(100n)

    const b = sortTokens({ address: low, amount: 200n }, { address: high, amount: 100n })
    expect(b.token0).toBe(low)
    expect(b.amount0).toBe(200n)
  })
})
