import { describe, expect, it } from 'vitest'
import {
  FeedNotFoundError,
  NoAccountError,
  NoRouteError,
  StaleFeedError,
  StockTokenEligibilityError,
  UnknownSymbolError,
} from 'hoodchain'
import { HoodError, toHoodError } from '../../src/errors.js'

describe('toHoodError', () => {
  it('passes an existing HoodError through unchanged', () => {
    const original = new HoodError('already friendly', 'BAD_INPUT')
    expect(toHoodError(original)).toBe(original)
  })

  it('maps UnknownSymbolError to UNKNOWN_SYMBOL with a plain-language message', () => {
    const err = toHoodError(new UnknownSymbolError('NOTREAL'))
    expect(err).toBeInstanceOf(HoodError)
    expect(err.code).toBe('UNKNOWN_SYMBOL')
    expect(err.message).toContain('NOTREAL')
    expect(err.message).not.toMatch(/registry\.ts|readContract|viem/i)
  })

  it('maps FeedNotFoundError to NO_FEED', () => {
    const err = toHoodError(new FeedNotFoundError('XYZ'))
    expect(err.code).toBe('NO_FEED')
  })

  it('maps StaleFeedError to STALE_PRICE and keeps the age in the message', () => {
    const err = toHoodError(new StaleFeedError('AAPL', 1_700_000_000, 999_999, 259_200))
    expect(err.code).toBe('STALE_PRICE')
    expect(err.message).toContain('999999')
  })

  it('maps NoRouteError to NO_ROUTE', () => {
    const err = toHoodError(new NoRouteError('0xabc', '0xdef', 'no liquidity'))
    expect(err.code).toBe('NO_ROUTE')
  })

  it('maps StockTokenEligibilityError to NEEDS_ELIGIBILITY with the config hint', () => {
    const err = toHoodError(new StockTokenEligibilityError())
    expect(err.code).toBe('NEEDS_ELIGIBILITY')
    expect(err.message).toContain('acknowledgeEligibility')
  })

  it('maps NoAccountError to NEEDS_WALLET with hood-js call-shape guidance', () => {
    const err = toHoodError(new NoAccountError('executeSwap'))
    expect(err.code).toBe('NEEDS_WALLET')
    expect(err.message).toContain('hood.swap')
  })

  it('wraps an unrelated Error as UNKNOWN, preserving it on cause', () => {
    const cause = new Error('boom')
    const err = toHoodError(cause)
    expect(err.code).toBe('UNKNOWN')
    expect(err.cause).toBe(cause)
  })

  it('classifies a network-shaped message as NETWORK', () => {
    const err = toHoodError(new Error('fetch failed: ECONNREFUSED'))
    expect(err.code).toBe('NETWORK')
  })

  it('every HoodError is instanceof Error and carries a stable name', () => {
    const err = toHoodError(new Error('x'))
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('HoodError')
  })
})
