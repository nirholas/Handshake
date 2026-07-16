import { describe, expect, it } from 'vitest'
import { DigestBuffer, type BufferedAlert } from '../src/engine/digest.js'
import type { AlertEvent } from '../src/engine/events.js'

function alert(at: number): BufferedAlert {
  const event = { type: 'graduation', token: '0xabc', symbol: 'X', name: null, pool: '0xdef', blockNumber: 1n, transactionHash: '0x1', at } as unknown as AlertEvent
  return { event, fingerprint: `grad:${at}`, bufferedAt: at }
}

describe('DigestBuffer', () => {
  it('reports zero pending for an unknown subscriber', () => {
    const buf = new DigestBuffer()
    expect(buf.pending(1)).toBe(0)
  })

  it('accumulates alerts for the same subscriber', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 60, 100)
    buf.add(1, alert(101), 60, 101)
    expect(buf.pending(1)).toBe(2)
  })

  it('keeps subscribers independent', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 60, 100)
    buf.add(2, alert(100), 60, 100)
    expect(buf.pending(1)).toBe(1)
    expect(buf.pending(2)).toBe(1)
  })

  it('drain returns nothing before notBefore', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 60, 100)
    expect(buf.drain(159)).toEqual([])
    expect(buf.pending(1)).toBe(1)
  })

  it('drain returns and clears a bucket once due', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 60, 100)
    const due = buf.drain(160)
    expect(due).toHaveLength(1)
    expect(due[0]?.subscriberId).toBe(1)
    expect(due[0]?.alerts).toHaveLength(1)
    expect(buf.pending(1)).toBe(0)
  })

  it('a shorter delay on a later add wins (batch is not held hostage)', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 3600, 100) // notBefore = 3700
    buf.add(1, alert(200), 60, 200) // notBefore = min(3700, 260) = 260
    expect(buf.drain(259)).toEqual([])
    const due = buf.drain(260)
    expect(due).toHaveLength(1)
    expect(due[0]?.alerts).toHaveLength(2)
  })

  it('drainAll returns every bucket regardless of notBefore', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 3600, 100)
    buf.add(2, alert(100), 7200, 100)
    const all = buf.drainAll()
    expect(all).toHaveLength(2)
    expect(buf.pending(1)).toBe(0)
    expect(buf.pending(2)).toBe(0)
  })

  it('drain only returns due buckets, leaving others buffered', () => {
    const buf = new DigestBuffer()
    buf.add(1, alert(100), 60, 100) // due at 160
    buf.add(2, alert(100), 3600, 100) // due at 3700
    const due = buf.drain(160)
    expect(due.map((d) => d.subscriberId)).toEqual([1])
    expect(buf.pending(2)).toBe(1)
  })
})
