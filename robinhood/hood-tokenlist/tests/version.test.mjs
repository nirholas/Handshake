import test from 'node:test'
import assert from 'node:assert/strict'
import { nextVersion, stableStringify } from '../scripts/lib/version.mjs'

const token = (address, overrides = {}) => ({
  chainId: 4663,
  address,
  symbol: 'T',
  name: 'Token',
  decimals: 18,
  ...overrides,
})

const A = token('0x' + '1'.repeat(40))
const B = token('0x' + '2'.repeat(40))

test('no change keeps the version untouched', () => {
  const result = nextVersion({ major: 1, minor: 2, patch: 3 }, [A, B], [A, B])
  assert.deepEqual(result.version, { major: 1, minor: 2, patch: 3 })
  assert.equal(result.changed, false)
})

test('token order does not matter for change detection', () => {
  const result = nextVersion({ major: 1, minor: 0, patch: 0 }, [A, B], [B, A])
  assert.equal(result.changed, false)
})

test('adding a token bumps minor and resets patch', () => {
  const result = nextVersion({ major: 1, minor: 2, patch: 3 }, [A], [A, B])
  assert.deepEqual(result.version, { major: 1, minor: 3, patch: 0 })
  assert.equal(result.added.length, 1)
})

test('removing a token bumps major and resets minor/patch', () => {
  const result = nextVersion({ major: 1, minor: 2, patch: 3 }, [A, B], [A])
  assert.deepEqual(result.version, { major: 2, minor: 0, patch: 0 })
  assert.equal(result.removed.length, 1)
})

test('removal outranks addition (major wins)', () => {
  const C = token('0x' + '3'.repeat(40))
  const result = nextVersion({ major: 1, minor: 2, patch: 3 }, [A, B], [A, C])
  assert.deepEqual(result.version, { major: 2, minor: 0, patch: 0 })
})

test('metadata change bumps patch only', () => {
  const changed = token(A.address, { name: 'Renamed' })
  const result = nextVersion({ major: 1, minor: 2, patch: 3 }, [A], [changed])
  assert.deepEqual(result.version, { major: 1, minor: 2, patch: 4 })
  assert.equal(result.modified.length, 1)
})

test('address case difference is not a change', () => {
  const upper = token(A.address.toUpperCase().replace('0X', '0x'))
  const result = nextVersion({ major: 1, minor: 0, patch: 0 }, [A], [upper])
  // same identity key; the address string itself differing is a metadata change
  assert.equal(result.removed.length, 0)
  assert.equal(result.added.length, 0)
})

test('stableStringify sorts keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}')
})
