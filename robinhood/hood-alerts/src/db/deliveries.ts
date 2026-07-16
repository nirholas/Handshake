import type { Db } from './index.js'

/** Delivery log + persisted dedup state. */
export class DeliveryRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * Atomically claim a fingerprint. Returns true the FIRST time a fingerprint
   * is seen inside its TTL; false for duplicates. Expired rows are reclaimed.
   */
  claimFingerprint(fingerprint: string, ttlS: number): boolean {
    const now = this.now()
    this.db.prepare('DELETE FROM dedup WHERE expires_at <= ?').run(now)
    const res = this.db
      .prepare('INSERT OR IGNORE INTO dedup (fingerprint, first_seen, expires_at) VALUES (?, ?, ?)')
      .run(fingerprint, now, now + ttlS)
    return res.changes > 0
  }

  logDelivery(subscriberId: number, fingerprint: string, status: 'sent' | 'failed' | 'digested', detail?: string): void {
    this.db
      .prepare('INSERT INTO deliveries (subscriber_id, fingerprint, delivered_at, status, detail) VALUES (?, ?, ?, ?, ?)')
      .run(subscriberId, fingerprint, this.now(), status, detail ?? null)
  }

  /** Deliveries in the trailing `windowS` seconds for one subscriber. */
  recentCount(subscriberId: number, windowS: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE subscriber_id = ? AND delivered_at > ? AND status = ?')
      .get(subscriberId, this.now() - windowS, 'sent') as { n: number }
    return row.n
  }

  /** Unix seconds of the most recent successful delivery, or null. */
  lastDeliveredAt(subscriberId: number): number | null {
    const row = this.db
      .prepare('SELECT MAX(delivered_at) AS t FROM deliveries WHERE subscriber_id = ? AND status = ?')
      .get(subscriberId, 'sent') as { t: number | null }
    return row.t
  }
}
