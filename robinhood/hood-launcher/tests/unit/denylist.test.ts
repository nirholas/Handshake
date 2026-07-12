import { describe, it, expect } from 'vitest'
import { checkDenylist } from '../../src/concept/denylist.js'
import { ConceptRejectedError } from '../../src/errors.js'

describe('checkDenylist', () => {
  it('rejects a name that impersonates a denylisted brand', () => {
    expect(() => checkDenylist({ name: 'Robinhood Coin', symbol: 'RHC', description: '' })).toThrow(
      ConceptRejectedError,
    )
  })

  it('rejects a symbol that exactly matches a denylisted term', () => {
    expect(() => checkDenylist({ name: 'Foo', symbol: 'NOXA', description: '' })).toThrow(ConceptRejectedError)
  })

  it('rejects a description that names a denylisted platform', () => {
    expect(() =>
      checkDenylist({ name: 'Foo', symbol: 'FOO', description: 'built to look exactly like uniswap' }),
    ).toThrow(ConceptRejectedError)
  })

  it('allows an unrelated word that merely contains a denylisted substring (word-boundary matching, not substring)', () => {
    // "noxaless" contains "noxa" as a substring but is not the word "noxa" —
    // this is exactly the false-positive class naive substring matching hit
    // elsewhere in this workspace (see denylist.ts doc comment).
    expect(() => checkDenylist({ name: 'Noxaless Dreams', symbol: 'NXD', description: '' })).not.toThrow()
  })

  it('allows a generic, unrelated coin concept', () => {
    expect(() => checkDenylist({ name: 'Sleepy Capybara', symbol: 'NAP', description: 'a very tired rodent' })).not.toThrow()
  })

  it('is case-insensitive', () => {
    expect(() => checkDenylist({ name: 'COINBASE Killer', symbol: 'CBK', description: '' })).toThrow(
      ConceptRejectedError,
    )
  })

  it('honors an operator-supplied person denylist via env', () => {
    const env = { HOOD_LAUNCHER_PERSON_DENYLIST: 'Jane Regular Person' } as NodeJS.ProcessEnv
    expect(() =>
      checkDenylist({ name: 'Jane Regular Person Coin', symbol: 'JRP', description: '' }, env),
    ).toThrow(ConceptRejectedError)
  })
})
