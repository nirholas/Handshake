import type { AlertEvent } from './events.js'

/** One buffered alert awaiting a digest flush. */
export interface BufferedAlert {
  event: AlertEvent
  fingerprint: string
  bufferedAt: number
}

interface Bucket {
  alerts: BufferedAlert[]
  /** Unix seconds when this bucket becomes flushable. */
  notBefore: number
}

/**
 * Per-subscriber digest buffers. Alerts gated into digest mode (or deferred by
 * quiet hours / free-tier granularity) accumulate here; `drain(now)` returns
 * every bucket whose flush time has arrived. In-memory by design: the delivery
 * log records what was actually sent, and a restart loses at most one pending
 * batch, never a subscription.
 */
export class DigestBuffer {
  private readonly buckets = new Map<number, Bucket>()

  /** Queue an alert for `subscriberId`, flushable after `delayS` seconds. */
  add(subscriberId: number, alert: BufferedAlert, delayS: number, nowS: number): void {
    const existing = this.buckets.get(subscriberId)
    if (existing) {
      existing.alerts.push(alert)
      // A shorter delay (e.g. free-granularity 60s vs digest 3600s) wins so
      // the batch is not held hostage by the longest deferral.
      existing.notBefore = Math.min(existing.notBefore, nowS + delayS)
      return
    }
    this.buckets.set(subscriberId, { alerts: [alert], notBefore: nowS + delayS })
  }

  /** Number of alerts currently buffered for a subscriber. */
  pending(subscriberId: number): number {
    return this.buckets.get(subscriberId)?.alerts.length ?? 0
  }

  /** Remove and return every due bucket. */
  drain(nowS: number): Array<{ subscriberId: number; alerts: BufferedAlert[] }> {
    const due: Array<{ subscriberId: number; alerts: BufferedAlert[] }> = []
    for (const [subscriberId, bucket] of this.buckets) {
      if (bucket.notBefore <= nowS && bucket.alerts.length > 0) {
        due.push({ subscriberId, alerts: bucket.alerts })
        this.buckets.delete(subscriberId)
      }
    }
    return due
  }

  /** Remove and return everything, due or not (shutdown flush). */
  drainAll(): Array<{ subscriberId: number; alerts: BufferedAlert[] }> {
    const all: Array<{ subscriberId: number; alerts: BufferedAlert[] }> = []
    for (const [subscriberId, bucket] of this.buckets) {
      if (bucket.alerts.length > 0) all.push({ subscriberId, alerts: bucket.alerts })
    }
    this.buckets.clear()
    return all
  }
}
