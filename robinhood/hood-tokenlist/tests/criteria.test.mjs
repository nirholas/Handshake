import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMECOIN_CRITERIA,
  checkErc20Identity,
  displayName,
  passesAge,
  passesHolders,
  passesLiquidity,
  isSymbolSpoof,
  resolveSymbolCollisions,
} from '../scripts/lib/criteria.mjs'

const DAY = 86_400

test('age rule: exactly the minimum age passes, one second younger fails', () => {
  const now = 1_800_000_000
  assert.ok(passesAge(now - MEMECOIN_CRITERIA.minAgeDays * DAY, now))
  assert.ok(!passesAge(now - MEMECOIN_CRITERIA.minAgeDays * DAY + 1, now))
})

test('holders rule: threshold inclusive, non-numbers fail', () => {
  assert.ok(passesHolders(MEMECOIN_CRITERIA.minHolders))
  assert.ok(!passesHolders(MEMECOIN_CRITERIA.minHolders - 1))
  assert.ok(!passesHolders(NaN))
  assert.ok(!passesHolders(undefined))
})

test('liquidity rule: total pool value is 2x quote side', () => {
  assert.ok(passesLiquidity(MEMECOIN_CRITERIA.minLiquidityUsd / 2))
  assert.ok(!passesLiquidity(MEMECOIN_CRITERIA.minLiquidityUsd / 2 - 0.01))
  assert.ok(!passesLiquidity(NaN))
})

test('identity rule rejects schema-invalid symbols and names', () => {
  assert.deepEqual(checkErc20Identity({ symbol: 'PEPE', name: 'Pepe', decimals: 18 }), [])
  assert.ok(checkErc20Identity({ symbol: '', name: 'x', decimals: 18 }).length > 0)
  assert.ok(checkErc20Identity({ symbol: 'HAS SPACE', name: 'x', decimals: 18 }).length > 0)
  assert.ok(checkErc20Identity({ symbol: 'A'.repeat(21), name: 'x', decimals: 18 }).length > 0)
  assert.ok(checkErc20Identity({ symbol: 'OK', name: '', decimals: 18 }).length > 0)
  assert.ok(checkErc20Identity({ symbol: 'OK', name: 'x', decimals: -1 }).length > 0)
  assert.ok(checkErc20Identity({ symbol: 'OK', name: 'x', decimals: 1.5 }).length > 0)
})

test('displayName strips the Stock Token suffix only when over the 60-char cap', () => {
  assert.equal(displayName('Apple • Robinhood Token'), 'Apple • Robinhood Token')
  assert.equal(
    displayName('Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token'),
    'Space Exploration Technologies Corp. Class A Common Stock',
  )
  assert.equal(displayName('  spaced   out  '), 'spaced out')
})

test('anti-spoof rule is case-insensitive', () => {
  const reserved = new Set(['TSLA', 'USDG'])
  assert.ok(isSymbolSpoof('tsla', reserved))
  assert.ok(isSymbolSpoof('USDG', reserved))
  assert.ok(!isSymbolSpoof('PEPE', reserved))
})

test('symbol collisions: deepest quote-side liquidity wins, address tie-break is deterministic', () => {
  const a = { symbol: 'ROBIN', address: '0x' + 'a'.repeat(40), quoteSideUsd: 100 }
  const b = { symbol: 'ROBIN', address: '0x' + 'b'.repeat(40), quoteSideUsd: 900 }
  const c = { symbol: 'robin', address: '0x' + 'c'.repeat(40), quoteSideUsd: 900 }
  const { included, excluded } = resolveSymbolCollisions([a, b, c])
  assert.equal(included.length, 1)
  assert.equal(included[0].address, b.address, 'tie at 900 breaks to lowest address')
  assert.equal(excluded.length, 2)

  const solo = resolveSymbolCollisions([a])
  assert.equal(solo.included.length, 1)
  assert.equal(solo.excluded.length, 0)
})
