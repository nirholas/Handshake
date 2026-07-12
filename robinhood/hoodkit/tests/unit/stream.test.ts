import { describe, expect, it, vi } from 'vitest'
import { Stream } from '../../src/stream/stream.js'
import { runLogCursor, type LogSource } from '../../src/stream/log-cursor.js'

describe('Stream', () => {
  it('delivers pushed values to data listeners synchronously', () => {
    const stream = new Stream<number>()
    const seen: number[] = []
    stream.on('data', (v) => seen.push(v))
    stream.push(1)
    stream.push(2)
    stream.push(3)
    expect(seen).toEqual([1, 2, 3])
  })

  it('supports the async-iterator form alongside listeners', async () => {
    const stream = new Stream<number>()
    const iterated: number[] = []
    const consume = (async () => {
      for await (const v of stream) {
        iterated.push(v)
        if (iterated.length === 3) break
      }
    })()
    stream.push(1)
    stream.push(2)
    stream.push(3)
    await consume
    expect(iterated).toEqual([1, 2, 3])
  })

  it('applies drop-oldest overflow policy on the buffered queue', () => {
    const stream = new Stream<number>({ highWaterMark: 2, overflow: 'drop-oldest' })
    stream.push(1)
    stream.push(2)
    stream.push(3) // should evict 1
    expect(stream.buffered).toBe(2)
    expect(stream.dropped).toBe(1)
  })

  it('applies latest overflow policy: buffer always holds exactly the newest value', () => {
    const stream = new Stream<number>({ overflow: 'latest' })
    stream.push(1)
    stream.push(2)
    stream.push(3)
    expect(stream.buffered).toBe(1)
  })

  it('block overflow never drops', () => {
    const stream = new Stream<number>({ highWaterMark: 2, overflow: 'block' })
    for (let i = 0; i < 10; i++) stream.push(i)
    expect(stream.buffered).toBe(10)
    expect(stream.dropped).toBe(0)
  })

  it('emits errors to error listeners without closing the stream', () => {
    const stream = new Stream<number>()
    const errors: Error[] = []
    stream.on('error', (e) => errors.push(e))
    stream.fail(new Error('transient'))
    expect(errors).toHaveLength(1)
    expect(stream.isClosed).toBe(false)
    stream.push(1)
    expect(stream.buffered).toBe(1)
  })

  it('close() ends the async iterator and fires close listeners', async () => {
    const stream = new Stream<number>()
    let closed = false
    stream.on('close', () => (closed = true))
    const results: IteratorResult<number>[] = []
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    stream.close()
    results.push(await pending)
    expect(closed).toBe(true)
    expect(results[0]?.done).toBe(true)
  })

  it('unsubscribing via the returned function stops delivery', () => {
    const stream = new Stream<number>()
    const seen: number[] = []
    const off = stream.on('data', (v) => seen.push(v))
    stream.push(1)
    off()
    stream.push(2)
    expect(seen).toEqual([1])
  })
})

describe('runLogCursor (reconnect gap-fill)', () => {
  it('never drops confirmed logs when getLogs throws mid-stream — the failed range is retried', async () => {
    vi.useFakeTimers()
    const head = { value: 100n }
    const source: LogSource = { getBlockNumber: async () => head.value }

    // Simulate a real chain: logs exist at every block number in [0, head].
    // getLogs fails exactly once (simulating a dropped socket / RPC blip),
    // and must be retried for the SAME range on the next tick.
    let callCount = 0
    let failedOnce = false
    const getLogs = vi.fn(async (from: bigint, to: bigint) => {
      callCount++
      if (callCount === 2 && !failedOnce) {
        failedOnce = true
        throw new Error('simulated socket drop')
      }
      const out: bigint[] = []
      for (let b = from; b <= to; b++) out.push(b)
      return out
    })

    const stream = new Stream<bigint>({ overflow: 'block' })
    const delivered: bigint[] = []
    stream.on('data', (b) => delivered.push(b))
    const errors: Error[] = []
    stream.on('error', (e) => errors.push(e))

    const stop = runLogCursor<bigint, bigint>({
      source,
      stream,
      fromBlock: 0n,
      pollingIntervalMs: 100,
      chunkSize: 10n,
      confirmations: 0n,
      getLogs,
      decode: (log) => log,
    })

    // Drain enough ticks to cover the full backfill (0..100 in chunks of 10 = 11 chunks)
    // plus the retry of the one that failed.
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }
    stop()
    vi.useRealTimers()

    expect(errors.length).toBeGreaterThan(0) // the transient failure was surfaced
    // Every block from 0 to 100 was eventually delivered exactly once — the
    // gap from the failed chunk was filled by the retry, not skipped.
    const expected = Array.from({ length: 101 }, (_, i) => BigInt(i))
    expect([...delivered].sort((a, b) => (a < b ? -1 : 1))).toEqual(expected)
  })

  it('advances the cursor only after a chunk is fully delivered', async () => {
    vi.useFakeTimers()
    const source: LogSource = { getBlockNumber: async () => 5n }
    const calls: Array<[bigint, bigint]> = []
    const getLogs = vi.fn(async (from: bigint, to: bigint) => {
      calls.push([from, to])
      return []
    })
    const stream = new Stream<never>()
    const stop = runLogCursor({
      source,
      stream,
      fromBlock: 0n,
      pollingIntervalMs: 50,
      chunkSize: 100n,
      confirmations: 0n,
      getLogs,
      decode: () => null,
    })
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    stop()
    vi.useRealTimers()
    // First tick scans [0,5] once; second tick has nothing new (cursor is 6, head is 5).
    expect(calls).toEqual([[0n, 5n]])
  })
})
