import type { Db } from './index.js'

export type Platform = 'telegram' | 'discord' | 'console' | 'x'

export interface Subscriber {
  id: number
  platform: Platform
  chatId: string
  title: string | null
  digest: boolean
  digestIntervalS: number
  quietStart: number | null
  quietEnd: number | null
  createdAt: number
}

export interface Subscription {
  id: number
  subscriberId: number
  topic: string
  threshold: number | null
  createdAt: number
}

interface SubscriberRow {
  id: number
  platform: Platform
  chat_id: string
  title: string | null
  digest: number
  digest_interval_s: number
  quiet_start: number | null
  quiet_end: number | null
  created_at: number
}

interface SubscriptionRow {
  id: number
  subscriber_id: number
  topic: string
  threshold: number | null
  created_at: number
}

function toSubscriber(r: SubscriberRow): Subscriber {
  return {
    id: r.id,
    platform: r.platform,
    chatId: r.chat_id,
    title: r.title,
    digest: r.digest === 1,
    digestIntervalS: r.digest_interval_s,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    createdAt: r.created_at,
  }
}

function toSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    subscriberId: r.subscriber_id,
    topic: r.topic,
    threshold: r.threshold,
    createdAt: r.created_at,
  }
}

/** Subscriptions + subscriber settings repository. */
export class SubscriberRepo {
  constructor(private readonly db: Db) {}

  /** Find or create the subscriber for a chat. */
  ensure(platform: Platform, chatId: string, title?: string): Subscriber {
    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare(
        'INSERT INTO subscribers (platform, chat_id, title, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (platform, chat_id) DO UPDATE SET title = COALESCE(excluded.title, subscribers.title)',
      )
      .run(platform, chatId, title ?? null, now)
    const row = this.db
      .prepare('SELECT * FROM subscribers WHERE platform = ? AND chat_id = ?')
      .get(platform, chatId) as SubscriberRow
    return toSubscriber(row)
  }

  get(platform: Platform, chatId: string): Subscriber | null {
    const row = this.db
      .prepare('SELECT * FROM subscribers WHERE platform = ? AND chat_id = ?')
      .get(platform, chatId) as SubscriberRow | undefined
    return row ? toSubscriber(row) : null
  }

  byId(id: number): Subscriber | null {
    const row = this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id) as SubscriberRow | undefined
    return row ? toSubscriber(row) : null
  }

  setDigest(subscriberId: number, on: boolean, intervalS?: number): void {
    if (intervalS !== undefined) {
      this.db
        .prepare('UPDATE subscribers SET digest = ?, digest_interval_s = ? WHERE id = ?')
        .run(on ? 1 : 0, intervalS, subscriberId)
    } else {
      this.db.prepare('UPDATE subscribers SET digest = ? WHERE id = ?').run(on ? 1 : 0, subscriberId)
    }
  }

  setQuietHours(subscriberId: number, start: number | null, end: number | null): void {
    this.db.prepare('UPDATE subscribers SET quiet_start = ?, quiet_end = ? WHERE id = ?').run(start, end, subscriberId)
  }

  subscribe(subscriberId: number, topic: string, threshold: number | null): Subscription {
    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare(
        'INSERT INTO subscriptions (subscriber_id, topic, threshold, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (subscriber_id, topic) DO UPDATE SET threshold = excluded.threshold',
      )
      .run(subscriberId, topic, threshold, now)
    const row = this.db
      .prepare('SELECT * FROM subscriptions WHERE subscriber_id = ? AND topic = ?')
      .get(subscriberId, topic) as SubscriptionRow
    return toSubscription(row)
  }

  unsubscribe(subscriberId: number, topic: string): boolean {
    const res = this.db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND topic = ?').run(subscriberId, topic)
    return res.changes > 0
  }

  unsubscribeAll(subscriberId: number): number {
    return this.db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ?').run(subscriberId).changes
  }

  setThreshold(subscriberId: number, topic: string, threshold: number): boolean {
    const res = this.db
      .prepare('UPDATE subscriptions SET threshold = ? WHERE subscriber_id = ? AND topic = ?')
      .run(threshold, subscriberId, topic)
    return res.changes > 0
  }

  list(subscriberId: number): Subscription[] {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions WHERE subscriber_id = ? ORDER BY created_at')
      .all(subscriberId) as SubscriptionRow[]
    return rows.map(toSubscription)
  }

  count(subscriberId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber_id = ?')
      .get(subscriberId) as { n: number }
    return row.n
  }

  /** Every subscription, joined with its subscriber, for engine routing. */
  allWithSubscribers(): Array<{ subscription: Subscription; subscriber: Subscriber }> {
    const rows = this.db
      .prepare(
        'SELECT s.id AS sub_id, s.subscriber_id, s.topic, s.threshold, s.created_at AS sub_created, ' +
          'u.id, u.platform, u.chat_id, u.title, u.digest, u.digest_interval_s, u.quiet_start, u.quiet_end, u.created_at ' +
          'FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id',
      )
      .all() as Array<SubscriberRow & { sub_id: number; subscriber_id: number; topic: string; threshold: number | null; sub_created: number }>
    return rows.map((r) => ({
      subscription: {
        id: r.sub_id,
        subscriberId: r.subscriber_id,
        topic: r.topic,
        threshold: r.threshold,
        createdAt: r.sub_created,
      },
      subscriber: toSubscriber(r),
    }))
  }

  /** Distinct topics with at least one subscription (drives detector lifecycles). */
  activeTopics(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT topic FROM subscriptions').all() as Array<{ topic: string }>
    return rows.map((r) => r.topic)
  }
}
