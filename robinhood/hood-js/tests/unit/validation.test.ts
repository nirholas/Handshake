import { describe, expect, it } from 'vitest'
import hood, { HoodError } from '../../src/index.js'

describe('argument validation (fails before any network call)', () => {
  it('price() rejects a non-string / empty symbol', async () => {
    // @ts-expect-error intentionally wrong type
    await expect(hood.price(123)).rejects.toThrow(HoodError)
    await expect(hood.price('')).rejects.toThrow(HoodError)
    await expect(hood.price('  ')).rejects.toThrow(/ticker string/)
  })

  it('prices() rejects a non-array or empty array', async () => {
    // @ts-expect-error intentionally wrong type
    await expect(hood.prices('AAPL')).rejects.toThrow(HoodError)
    await expect(hood.prices([])).rejects.toThrow(/non-empty array/)
  })

  it('prices() rejects a blank entry inside the array', async () => {
    await expect(hood.prices(['AAPL', ''])).rejects.toThrow(/non-empty string/)
  })

  it('portfolio() rejects a non-address', async () => {
    await expect(hood.portfolio('not-an-address')).rejects.toThrow(/wallet address/)
  })

  it('quote() rejects a missing field', async () => {
    // @ts-expect-error intentionally missing amount
    await expect(hood.quote({ sell: 'USDG', buy: 'AAPL' })).rejects.toThrow(HoodError)
  })

  it('quote() rejects a non-positive amount', async () => {
    await expect(hood.quote({ sell: 'USDG', buy: 'AAPL', amount: 0 })).rejects.toThrow(/positive number/)
    await expect(hood.quote({ sell: 'USDG', buy: 'AAPL', amount: -5 })).rejects.toThrow(/positive number/)
    await expect(hood.quote({ sell: 'USDG', buy: 'AAPL', amount: 'abc' })).rejects.toThrow(/positive number/)
  })

  it('quote() accepts a numeric string amount', async () => {
    // normalizeAmount validates the shape; this should get past validation and
    // fail on network instead (JSDOM/node has no fetch context here so it may
    // throw NETWORK/UNKNOWN, but never BAD_INPUT for a well-formed amount).
    const result = hood.quote({ sell: 'USDG', buy: 'AAPL', amount: '12.5' }).catch((e: HoodError) => e)
    const outcome = await result
    if (outcome instanceof HoodError) expect(outcome.code).not.toBe('BAD_INPUT')
  })

  it('swap() rejects a call with no wallet', async () => {
    // @ts-expect-error intentionally missing wallet
    await expect(hood.swap({ sell: 'USDG', buy: 'AAPL', amount: 1 })).rejects.toThrow(/wallet/)
  })

  it('swap() rejects a malformed private key string', async () => {
    await expect(
      hood.swap({ sell: 'USDG', buy: 'AAPL', amount: 1, wallet: '0xdeadbeef' }),
    ).rejects.toThrow(/32-byte private key/)
  })

  it('config/testnet/mainnet are chainable and return the same facade', () => {
    expect(hood.config({})).toBe(hood)
    expect(hood.testnet()).toBe(hood)
    expect(hood.mainnet()).toBe(hood)
  })
})
