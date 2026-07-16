import { describe, expect, it } from 'vitest'
import {
  applyDust,
  DUST_MODULUS,
  DUST_SLOTS,
  directCollisionProbability,
  isReference,
  newReference,
  randomDust,
  referenceCollisionProbability,
  splitDust,
} from '../../src/reference.js'

describe('newReference', () => {
  it('produces well-formed, unique 32-byte references', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const ref = newReference()
      expect(isReference(ref)).toBe(true)
      expect(seen.has(ref)).toBe(false)
      seen.add(ref)
    }
  })
})

describe('isReference', () => {
  it('accepts 32-byte hex and rejects everything else', () => {
    expect(isReference(`0x${'ab'.repeat(32)}`)).toBe(true)
    expect(isReference(`0x${'ab'.repeat(31)}`)).toBe(false)
    expect(isReference(`0x${'ab'.repeat(33)}`)).toBe(false)
    expect(isReference('ab'.repeat(32))).toBe(false)
    expect(isReference(`0x${'zz'.repeat(32)}`)).toBe(false)
    expect(isReference(42)).toBe(false)
    expect(isReference(null)).toBe(false)
  })
})

describe('dust fingerprinting', () => {
  it('randomDust stays in [1, DUST_SLOTS] and covers the range', () => {
    const seen = new Set<bigint>()
    for (let i = 0; i < 5000; i++) {
      const dust = randomDust()
      expect(dust >= 1n && dust <= BigInt(DUST_SLOTS)).toBe(true)
      seen.add(dust)
    }
    expect(seen.size).toBeGreaterThan(2000) // ~40%+ of 9999 slots after 5k draws
  })

  it('applyDust/splitDust round-trip', () => {
    const base = 12_500_000n // 12.50 USDG
    const dust = 42n
    const fingerprinted = applyDust(base, dust)
    expect(fingerprinted).toBe(12_500_042n)
    expect(splitDust(fingerprinted)).toEqual({ base, dust })
  })

  it('rejects a base amount that already uses the dust digits', () => {
    expect(() => applyDust(12_500_042n, 7n)).toThrow(/low 4 decimal digits/)
  })

  it('rejects out-of-range dust', () => {
    expect(() => applyDust(1_000_000n, 0n)).toThrow(RangeError)
    expect(() => applyDust(1_000_000n, DUST_MODULUS)).toThrow(RangeError)
    expect(() => applyDust(-1n, 5n)).toThrow(RangeError)
  })
})

describe('collision math', () => {
  it('direct-mode collision probability matches the birthday bound', () => {
    expect(directCollisionProbability(0)).toBe(0)
    expect(directCollisionProbability(1)).toBe(0)
    // exact for k=2: 1/9999
    expect(directCollisionProbability(2)).toBeCloseTo(1 / DUST_SLOTS, 10)
    // documented figure: ~0.45% at 10 concurrent same-price invoices
    expect(directCollisionProbability(10)).toBeGreaterThan(0.004)
    expect(directCollisionProbability(10)).toBeLessThan(0.005)
    expect(directCollisionProbability(DUST_SLOTS + 1)).toBe(1)
  })

  it('router references never realistically collide', () => {
    expect(referenceCollisionProbability(1e12)).toBeLessThan(1e-50)
    expect(referenceCollisionProbability(0)).toBe(0)
    expect(() => directCollisionProbability(-1)).toThrow(RangeError)
    expect(() => referenceCollisionProbability(-1)).toThrow(RangeError)
  })
})
