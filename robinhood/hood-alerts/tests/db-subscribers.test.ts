import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { SubscriberRepo } from '../src/db/subscribers.js'

let db: Db
let repo: SubscriberRepo

beforeEach(() => {
  db = openDb(':memory:')
  repo = new SubscriberRepo(db)
})

afterEach(() => {
  db.close()
})

describe('SubscriberRepo.ensure/get/byId', () => {
  it('creates a subscriber on first ensure and returns the same row after', () => {
    const first = repo.ensure('telegram', 'chat-1', 'My Chat')
    expect(first.platform).toBe('telegram')
    expect(first.chatId).toBe('chat-1')
    expect(first.title).toBe('My Chat')
    expect(first.digest).toBe(false)
    expect(first.quietStart).toBeNull()

    const second = repo.ensure('telegram', 'chat-1')
    expect(second.id).toBe(first.id)
  })

  it('preserves the existing title when ensure is called without one', () => {
    repo.ensure('telegram', 'chat-1', 'Original')
    const again = repo.ensure('telegram', 'chat-1')
    expect(again.title).toBe('Original')
  })

  it('keeps platforms independent for the same chat id', () => {
    const tg = repo.ensure('telegram', 'chat-1')
    const dc = repo.ensure('discord', 'chat-1')
    expect(tg.id).not.toBe(dc.id)
  })

  it('get returns null for an unknown chat', () => {
    expect(repo.get('telegram', 'nope')).toBeNull()
  })

  it('byId returns null for an unknown id', () => {
    expect(repo.byId(999)).toBeNull()
  })
})

describe('SubscriberRepo settings', () => {
  it('setDigest toggles on/off and optionally sets the interval', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.setDigest(s.id, true, 1800)
    expect(repo.byId(s.id)).toMatchObject({ digest: true, digestIntervalS: 1800 })
    repo.setDigest(s.id, false)
    expect(repo.byId(s.id)).toMatchObject({ digest: false, digestIntervalS: 1800 })
  })

  it('setQuietHours stores and clears the window', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.setQuietHours(s.id, 22, 7)
    expect(repo.byId(s.id)).toMatchObject({ quietStart: 22, quietEnd: 7 })
    repo.setQuietHours(s.id, null, null)
    expect(repo.byId(s.id)).toMatchObject({ quietStart: null, quietEnd: null })
  })
})

describe('SubscriberRepo subscriptions', () => {
  it('subscribe creates, and re-subscribing updates the threshold instead of duplicating', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.subscribe(s.id, 'whales', 5000)
    repo.subscribe(s.id, 'whales', 10_000)
    const subs = repo.list(s.id)
    expect(subs).toHaveLength(1)
    expect(subs[0]?.threshold).toBe(10_000)
  })

  it('unsubscribe removes a subscription and reports whether it existed', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.subscribe(s.id, 'whales', 5000)
    expect(repo.unsubscribe(s.id, 'whales')).toBe(true)
    expect(repo.unsubscribe(s.id, 'whales')).toBe(false)
    expect(repo.list(s.id)).toHaveLength(0)
  })

  it('unsubscribeAll removes every subscription and returns the count removed', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.subscribe(s.id, 'whales', 5000)
    repo.subscribe(s.id, 'launches', null)
    expect(repo.unsubscribeAll(s.id)).toBe(2)
    expect(repo.count(s.id)).toBe(0)
  })

  it('setThreshold updates only an existing subscription', () => {
    const s = repo.ensure('telegram', 'chat-1')
    expect(repo.setThreshold(s.id, 'whales', 9000)).toBe(false)
    repo.subscribe(s.id, 'whales', 5000)
    expect(repo.setThreshold(s.id, 'whales', 9000)).toBe(true)
    expect(repo.list(s.id)[0]?.threshold).toBe(9000)
  })

  it('list orders subscriptions by creation time and count matches it', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.subscribe(s.id, 'launches', null)
    repo.subscribe(s.id, 'whales', 5000)
    const subs = repo.list(s.id)
    expect(subs.map((x) => x.topic)).toEqual(['launches', 'whales'])
    expect(repo.count(s.id)).toBe(2)
  })

  it('allWithSubscribers joins every subscription to its subscriber', () => {
    const a = repo.ensure('telegram', 'chat-a')
    const b = repo.ensure('discord', 'chat-b')
    repo.subscribe(a.id, 'whales', 5000)
    repo.subscribe(b.id, 'launches', null)
    const rows = repo.allWithSubscribers()
    expect(rows).toHaveLength(2)
    const forA = rows.find((r) => r.subscriber.id === a.id)
    expect(forA?.subscription.topic).toBe('whales')
    expect(forA?.subscriber.platform).toBe('telegram')
  })

  it('activeTopics returns distinct topics across all subscribers', () => {
    const a = repo.ensure('telegram', 'chat-a')
    const b = repo.ensure('discord', 'chat-b')
    repo.subscribe(a.id, 'whales', 5000)
    repo.subscribe(b.id, 'whales', 8000)
    repo.subscribe(b.id, 'launches', null)
    expect(repo.activeTopics().sort()).toEqual(['launches', 'whales'])
  })

  it('cascades subscription deletion when the subscriber row is deleted', () => {
    const s = repo.ensure('telegram', 'chat-1')
    repo.subscribe(s.id, 'whales', 5000)
    db.prepare('DELETE FROM subscribers WHERE id = ?').run(s.id)
    expect(repo.list(s.id)).toHaveLength(0)
  })
})
