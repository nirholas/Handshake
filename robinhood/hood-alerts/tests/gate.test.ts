import { describe, expect, it } from 'vitest'
import { FREE_MIN_INTERVAL_S, MAX_PER_MINUTE, gate, inQuietHours } from '../src/engine/gate.js'

describe('inQuietHours', () => {
  it('returns false when either bound is null', () => {
    expect(inQuietHours(3, null, 7)).toBe(false)
    expect(inQuietHours(3, 22, null)).toBe(false)
  })

  it('returns false when start equals end (no window)', () => {
    expect(inQuietHours(5, 8, 8)).toBe(false)
  })

  it('handles a same-day window', () => {
    expect(inQuietHours(9, 8, 17)).toBe(true)
    expect(inQuietHours(8, 8, 17)).toBe(true)
    expect(inQuietHours(17, 8, 17)).toBe(false)
    expect(inQuietHours(7, 8, 17)).toBe(false)
  })

  it('handles a wrap-around window (e.g. 22 -> 7)', () => {
    expect(inQuietHours(23, 22, 7)).toBe(true)
    expect(inQuietHours(22, 22, 7)).toBe(true)
    expect(inQuietHours(3, 22, 7)).toBe(true)
    expect(inQuietHours(6, 22, 7)).toBe(true)
    expect(inQuietHours(7, 22, 7)).toBe(false)
    expect(inQuietHours(12, 22, 7)).toBe(false)
  })
})

describe('gate', () => {
  const base = {
    premium: false,
    digest: false,
    quietStart: null,
    quietEnd: null,
    lastDeliveredAt: null,
    deliveredLastMinute: 0,
  }

  it('delivers immediately when nothing gates it', () => {
    expect(gate(base, 1_700_000_000)).toEqual({ action: 'deliver' })
  })

  it('drops when the per-minute burst cap is hit, before any other check', () => {
    const input = { ...base, premium: true, deliveredLastMinute: MAX_PER_MINUTE }
    expect(gate(input, 1_700_000_000)).toEqual({ action: 'drop', reason: 'rate-limited' })
  })

  it('digests during quiet hours even for premium subscribers', () => {
    // 1_700_000_000 is a Tuesday; hourUtc = floor((t % 86400) / 3600)
    const nowS = 1_700_000_000
    const hourUtc = Math.floor((nowS % 86_400) / 3600)
    const input = { ...base, premium: true, quietStart: hourUtc, quietEnd: (hourUtc + 1) % 24 }
    expect(gate(input, nowS)).toEqual({ action: 'digest', reason: 'quiet-hours' })
  })

  it('digests when the subscriber has digest mode on', () => {
    const input = { ...base, premium: true, digest: true }
    expect(gate(input, 1_700_000_000)).toEqual({ action: 'digest', reason: 'digest-mode' })
  })

  it('enforces free-tier minimum granularity between deliveries', () => {
    const nowS = 1_700_000_000
    const input = { ...base, lastDeliveredAt: nowS - (FREE_MIN_INTERVAL_S - 1) }
    expect(gate(input, nowS)).toEqual({ action: 'digest', reason: 'free-granularity' })
  })

  it('allows a free-tier delivery once the granularity window has passed', () => {
    const nowS = 1_700_000_000
    const input = { ...base, lastDeliveredAt: nowS - FREE_MIN_INTERVAL_S }
    expect(gate(input, nowS)).toEqual({ action: 'deliver' })
  })

  it('never applies free-granularity to premium subscribers', () => {
    const nowS = 1_700_000_000
    const input = { ...base, premium: true, lastDeliveredAt: nowS }
    expect(gate(input, nowS)).toEqual({ action: 'deliver' })
  })

  it('quiet-hours takes priority over digest-mode', () => {
    const nowS = 1_700_000_000
    const hourUtc = Math.floor((nowS % 86_400) / 3600)
    const input = { ...base, digest: true, quietStart: hourUtc, quietEnd: (hourUtc + 1) % 24 }
    expect(gate(input, nowS)).toEqual({ action: 'digest', reason: 'quiet-hours' })
  })
})
