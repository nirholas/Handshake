/**
 * Per-subscriber delivery gating: token-bucket rate limiting, quiet hours,
 * digest mode, and the free-tier minimum granularity. Pure logic, injectable
 * clock, unit-tested against the state machine in tests/dedup-gate.test.ts.
 */

export interface GateInput {
  /** Is the subscriber premium right now? */
  premium: boolean
  /** Has the subscriber turned digest mode on? */
  digest: boolean
  /** Quiet hours in the subscriber's configured UTC hours, or null. */
  quietStart: number | null
  quietEnd: number | null
  /** Unix seconds of this subscriber's last immediate delivery. */
  lastDeliveredAt: number | null
  /** Deliveries in the last 60s (for the burst bucket). */
  deliveredLastMinute: number
}

export type GateDecision =
  | { action: 'deliver' }
  | { action: 'digest'; reason: 'digest-mode' | 'quiet-hours' | 'free-granularity' }
  | { action: 'drop'; reason: 'rate-limited' }

/** Free tier: at most one immediate delivery per 60s; extras fold into a batch. */
export const FREE_MIN_INTERVAL_S = 60
/** Hard per-subscriber burst cap (platform API safety), premium included. */
export const MAX_PER_MINUTE = 20

/** Is `hourUtc` inside the [start, end) quiet window? Handles wrap-around. */
export function inQuietHours(hourUtc: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false
  if (start < end) return hourUtc >= start && hourUtc < end
  return hourUtc >= start || hourUtc < end
}

/** Decide how to handle one matched alert for one subscriber. */
export function gate(input: GateInput, nowS: number): GateDecision {
  if (input.deliveredLastMinute >= MAX_PER_MINUTE) return { action: 'drop', reason: 'rate-limited' }

  const hourUtc = Math.floor((nowS % 86_400) / 3600)
  if (inQuietHours(hourUtc, input.quietStart, input.quietEnd)) {
    return { action: 'digest', reason: 'quiet-hours' }
  }
  if (input.digest) return { action: 'digest', reason: 'digest-mode' }

  if (!input.premium) {
    const last = input.lastDeliveredAt ?? 0
    if (nowS - last < FREE_MIN_INTERVAL_S) return { action: 'digest', reason: 'free-granularity' }
  }
  return { action: 'deliver' }
}
