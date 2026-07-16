import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { EntitlementRepo } from '../src/db/entitlements.js'

let db: Db
let clock = 1_700_000_000
const now = (): number => clock

let repo: EntitlementRepo

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_700_000_000
  repo = new EntitlementRepo(db, now)
})

afterEach(() => {
  db.close()
})

describe('EntitlementRepo', () => {
  it('is free before any activation', () => {
    expect(repo.get('telegram', 'chat-1')).toBeNull()
    expect(repo.isPremium('telegram', 'chat-1')).toBe(false)
    expect(repo.remainingS('telegram', 'chat-1')).toBe(0)
  })

  it('activate grants premium for the given duration', () => {
    const e = repo.activate('telegram', 'chat-1', 30 * 86_400)
    expect(e.tier).toBe('premium')
    expect(e.expiresAt).toBe(clock + 30 * 86_400)
    expect(repo.isPremium('telegram', 'chat-1')).toBe(true)
    expect(repo.remainingS('telegram', 'chat-1')).toBe(30 * 86_400)
  })

  it('records payment tx and payer when provided', () => {
    const e = repo.activate('telegram', 'chat-1', 86_400, { tx: '0xabc', payer: '0xdef' })
    expect(e.paymentTx).toBe('0xabc')
    expect(e.payer).toBe('0xdef')
  })

  it('stacks an extension on top of remaining time while still active', () => {
    repo.activate('telegram', 'chat-1', 10 * 86_400)
    clock += 3 * 86_400 // 7 days remain
    const extended = repo.activate('telegram', 'chat-1', 5 * 86_400)
    // base = current expiry (10 days from original activation), + 5 more days
    expect(extended.expiresAt).toBe(1_700_000_000 + 10 * 86_400 + 5 * 86_400)
  })

  it('does not stack on top of an already-expired entitlement (starts from now)', () => {
    repo.activate('telegram', 'chat-1', 1 * 86_400)
    clock += 2 * 86_400 // expired 1 day ago
    const reactivated = repo.activate('telegram', 'chat-1', 5 * 86_400)
    expect(reactivated.expiresAt).toBe(clock + 5 * 86_400)
  })

  it('preserves payment_tx/payer on a renewal that supplies none', () => {
    repo.activate('telegram', 'chat-1', 10 * 86_400, { tx: '0xabc', payer: '0xdef' })
    const renewed = repo.activate('telegram', 'chat-1', 10 * 86_400)
    expect(renewed.paymentTx).toBe('0xabc')
    expect(renewed.payer).toBe('0xdef')
  })

  it('isPremium flips to false once the clock passes expiry', () => {
    repo.activate('telegram', 'chat-1', 100)
    expect(repo.isPremium('telegram', 'chat-1')).toBe(true)
    clock += 101
    expect(repo.isPremium('telegram', 'chat-1')).toBe(false)
    expect(repo.remainingS('telegram', 'chat-1')).toBe(0)
  })

  it('revoke drops back to free and reports whether a row existed', () => {
    repo.activate('telegram', 'chat-1', 86_400)
    expect(repo.revoke('telegram', 'chat-1')).toBe(true)
    expect(repo.isPremium('telegram', 'chat-1')).toBe(false)
    expect(repo.revoke('telegram', 'chat-1')).toBe(false)
  })

  it('keeps platforms independent for the same chat id', () => {
    repo.activate('telegram', 'chat-1', 86_400)
    expect(repo.isPremium('telegram', 'chat-1')).toBe(true)
    expect(repo.isPremium('discord', 'chat-1')).toBe(false)
  })

  it('get returns the stored entitlement even after it expires', () => {
    repo.activate('telegram', 'chat-1', 10)
    clock += 20
    const e = repo.get('telegram', 'chat-1')
    expect(e).not.toBeNull()
    expect(repo.isPremium('telegram', 'chat-1')).toBe(false)
  })
})
