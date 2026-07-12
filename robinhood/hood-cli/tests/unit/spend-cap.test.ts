import { describe, expect, it } from 'vitest'
import { checkSpendCap } from '../../src/spend-cap.js'
import { EXIT } from '../../src/errors.js'

describe('checkSpendCap (the --maxSpendUsd guard rail)', () => {
  it('is a no-op when no cap is configured', () => {
    expect(() => checkSpendCap({ maxSpendUsd: undefined, estimatedUsd: 1_000_000 })).not.toThrow()
  })

  it('is a no-op when the spend could not be priced (never blocks an unpriceable send)', () => {
    expect(() => checkSpendCap({ maxSpendUsd: 100, estimatedUsd: null })).not.toThrow()
  })

  it('allows a spend under the cap', () => {
    expect(() => checkSpendCap({ maxSpendUsd: 100, estimatedUsd: 99.99 })).not.toThrow()
  })

  it('allows a spend exactly at the cap', () => {
    expect(() => checkSpendCap({ maxSpendUsd: 100, estimatedUsd: 100 })).not.toThrow()
  })

  it('refuses a spend over the cap with a GUARD exit code', () => {
    try {
      checkSpendCap({ maxSpendUsd: 100, estimatedUsd: 100.01 })
      expect.unreachable('expected checkSpendCap to throw')
    } catch (err) {
      expect((err as { exitCode: number }).exitCode).toBe(EXIT.GUARD)
      expect((err as Error).message).toMatch(/exceeds your configured cap/)
    }
  })
})
