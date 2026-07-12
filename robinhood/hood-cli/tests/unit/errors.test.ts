import { describe, expect, it } from 'vitest'
import { CliError, EXIT, toCliError, usageError, guardError } from '../../src/errors.js'

describe('CliError', () => {
  it('defaults to the generic ERROR exit code', () => {
    const err = new CliError('boom')
    expect(err.exitCode).toBe(EXIT.ERROR)
  })
  it('carries a hint and cause through', () => {
    const cause = new Error('root cause')
    const err = new CliError('boom', { exitCode: EXIT.GUARD, hint: 'try X', cause })
    expect(err.hint).toBe('try X')
    expect(err.cause).toBe(cause)
    expect(err.exitCode).toBe(EXIT.GUARD)
  })
})

describe('constructors', () => {
  it('usageError uses the USAGE exit code', () => {
    expect(usageError('bad args').exitCode).toBe(EXIT.USAGE)
  })
  it('guardError uses the GUARD exit code', () => {
    expect(guardError('refused').exitCode).toBe(EXIT.GUARD)
  })
})

describe('toCliError', () => {
  it('passes an existing CliError through unchanged', () => {
    const original = guardError('already a CliError')
    expect(toCliError(original)).toBe(original)
  })

  it('maps StockTokenEligibilityError to a GUARD exit with an eligibility hint', () => {
    const sdkError = Object.assign(new Error('gated'), { name: 'StockTokenEligibilityError' })
    const mapped = toCliError(sdkError)
    expect(mapped.exitCode).toBe(EXIT.GUARD)
    expect(mapped.hint).toMatch(/acknowledge-eligibility/)
  })

  it('maps UnknownSymbolError to NOT_FOUND', () => {
    const sdkError = Object.assign(new Error('no such symbol'), { name: 'UnknownSymbolError' })
    expect(toCliError(sdkError).exitCode).toBe(EXIT.NOT_FOUND)
  })

  it('maps NoAccountError to WALLET with a config hint', () => {
    const sdkError = Object.assign(new Error('no account'), { name: 'NoAccountError' })
    const mapped = toCliError(sdkError)
    expect(mapped.exitCode).toBe(EXIT.WALLET)
    expect(mapped.hint).toMatch(/hood config set wallet/)
  })

  it('maps NoRouteError to NOT_FOUND', () => {
    const sdkError = Object.assign(new Error('no route'), { name: 'NoRouteError' })
    expect(toCliError(sdkError).exitCode).toBe(EXIT.NOT_FOUND)
  })

  it('maps a generic network failure message to NETWORK', () => {
    const err = new Error('fetch failed: ECONNREFUSED')
    expect(toCliError(err).exitCode).toBe(EXIT.NETWORK)
  })

  it('falls back to ERROR for an unrecognised failure', () => {
    const err = new Error('something unexpected')
    expect(toCliError(err).exitCode).toBe(EXIT.ERROR)
  })

  it('wraps a non-Error thrown value', () => {
    const mapped = toCliError('a plain string throw')
    expect(mapped.message).toBe('a plain string throw')
    expect(mapped.exitCode).toBe(EXIT.ERROR)
  })
})
