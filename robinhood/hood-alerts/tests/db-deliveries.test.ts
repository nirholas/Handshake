import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { SubscriberRepo } from '../src/db/subscribers.js'
import { DeliveryRepo } from '../src/db/deliveries.js'

let db: Db
let clock = 1_700_000_000
const now = (): number => clock
let repo: DeliveryRepo
let subscriberId: number

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_700_000_000
  repo = new DeliveryRepo(db, now)
  subscriberId = new SubscriberRepo(db).ensure('telegram', 'chat-1').id
})

afterEach(() => {
  db.close()
})

describe('DeliveryRepo.claimFingerprint', () => {
  it('claims a fresh fingerprint and rejects the same one again within its TTL', () => {
    expect(repo.claimFingerprint('fp-1', 3600)).toBe(true)
    expect(repo.claimFingerprint('fp-1', 3600)).toBe(false)
  })

  it('reclaims a fingerprint once its TTL has expired', () => {
    expect(repo.claimFingerprint('fp-1', 60)).toBe(true)
    clock += 61
    expect(repo.claimFingerprint('fp-1', 60)).toBe(true)
  })

  it('treats distinct fingerprints independently', () => {
    expect(repo.claimFingerprint('fp-1', 3600)).toBe(true)
    expect(repo.claimFingerprint('fp-2', 3600)).toBe(true)
  })
})

describe('DeliveryRepo delivery log', () => {
  it('logDelivery records a row queryable by recentCount', () => {
    repo.logDelivery(subscriberId, 'fp-1', 'sent')
    expect(repo.recentCount(subscriberId, 60)).toBe(1)
  })

  it('recentCount only counts "sent" status within the window', () => {
    repo.logDelivery(subscriberId, 'fp-1', 'sent')
    repo.logDelivery(subscriberId, 'fp-2', 'failed')
    repo.logDelivery(subscriberId, 'fp-3', 'digested')
    expect(repo.recentCount(subscriberId, 60)).toBe(1)
  })

  it('recentCount excludes deliveries outside the trailing window', () => {
    repo.logDelivery(subscriberId, 'fp-1', 'sent')
    clock += 120
    expect(repo.recentCount(subscriberId, 60)).toBe(0)
    expect(repo.recentCount(subscriberId, 300)).toBe(1)
  })

  it('lastDeliveredAt returns null with no sent deliveries, and the max timestamp otherwise', () => {
    expect(repo.lastDeliveredAt(subscriberId)).toBeNull()
    repo.logDelivery(subscriberId, 'fp-1', 'sent')
    clock += 10
    repo.logDelivery(subscriberId, 'fp-2', 'sent')
    expect(repo.lastDeliveredAt(subscriberId)).toBe(clock)
  })

  it('lastDeliveredAt ignores non-sent statuses', () => {
    repo.logDelivery(subscriberId, 'fp-1', 'failed')
    expect(repo.lastDeliveredAt(subscriberId)).toBeNull()
  })

  it('keeps subscribers independent', () => {
    repo.logDelivery(subscriberId, 'fp-1', 'sent')
    expect(repo.recentCount(999, 60)).toBe(0)
  })
})
