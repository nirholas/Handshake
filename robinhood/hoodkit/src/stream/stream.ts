/**
 * `Stream<T>` — the real-time primitive every `hoodkit` stream returns.
 *
 * It is BOTH:
 * - an **event emitter**: `stream.on('data', cb)`, `.on('error', cb)`, `.on('close', cb)`;
 * - a **backpressure-safe async iterable**: `for await (const v of stream) { ... }`.
 *
 * The two forms share one source. Event listeners fire synchronously as values
 * arrive (no buffering — a slow listener never grows memory). The async-iterator
 * form buffers into a bounded queue and applies an explicit overflow policy so a
 * slow consumer degrades predictably instead of leaking memory:
 *
 * - `'drop-oldest'` (default): keep the newest `highWaterMark` values, dropping the
 *   oldest and counting them in {@link Stream.dropped}. Right for firehose-style feeds.
 * - `'latest'`: keep only the single most-recent value. Right for price ticks where
 *   only the current price matters.
 * - `'block'`: never drop; the buffer grows unbounded. Use only when the producer is
 *   naturally slow (e.g. a 1s price poll) or the consumer is guaranteed to keep up.
 */
export type OverflowPolicy = 'drop-oldest' | 'latest' | 'block'

/** Options for a {@link Stream}. */
export interface StreamOptions {
  /**
   * Max buffered values for the async-iterator form before {@link OverflowPolicy}
   * applies. Ignored by event listeners (they never buffer). @defaultValue `1024`
   */
  highWaterMark?: number
  /** Overflow behavior for the async-iterator buffer. @defaultValue `'drop-oldest'` */
  overflow?: OverflowPolicy
}

type Listener<T> = (value: T) => void
type ErrorListener = (error: Error) => void

/**
 * A live stream of `T`. Construct one via the `stream*` helpers; you rarely
 * `new` this directly. Producers call {@link Stream.push}, {@link Stream.fail},
 * and {@link Stream.end}; consumers use listeners or `for await`.
 */
export class Stream<T> implements AsyncIterable<T> {
  private readonly highWaterMark: number
  private readonly overflow: OverflowPolicy
  private readonly dataListeners = new Set<Listener<T>>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly closeListeners = new Set<() => void>()

  /** Async-iterator buffer of undelivered values. */
  private readonly queue: T[] = []
  /** Iterator consumers parked waiting for the next value. */
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false
  private failure: Error | null = null
  private onClose: (() => void) | null

  /** Count of values dropped by the `'drop-oldest'`/`'latest'` overflow policy. */
  dropped = 0

  constructor(options: StreamOptions & { onClose?: () => void } = {}) {
    this.highWaterMark = options.highWaterMark ?? 1024
    this.overflow = options.overflow ?? 'drop-oldest'
    this.onClose = options.onClose ?? null
  }

  /** `true` once the stream has been closed (by {@link Stream.close}/{@link Stream.end}/{@link Stream.fail}). */
  get isClosed(): boolean {
    return this.closed
  }

  /** Number of values currently buffered for async-iterator consumers. */
  get buffered(): number {
    return this.queue.length
  }

  /** Subscribe to values (`'data'`), errors (`'error'`), or close (`'close'`). Returns an unsubscribe fn. */
  on(event: 'data', listener: Listener<T>): () => void
  on(event: 'error', listener: ErrorListener): () => void
  on(event: 'close', listener: () => void): () => void
  on(event: 'data' | 'error' | 'close', listener: Listener<T> | ErrorListener | (() => void)): () => void {
    if (event === 'data') {
      this.dataListeners.add(listener as Listener<T>)
      return () => this.dataListeners.delete(listener as Listener<T>)
    }
    if (event === 'error') {
      this.errorListeners.add(listener as ErrorListener)
      return () => this.errorListeners.delete(listener as ErrorListener)
    }
    this.closeListeners.add(listener as () => void)
    return () => this.closeListeners.delete(listener as () => void)
  }

  /** Remove a previously-added listener. */
  off(event: 'data', listener: Listener<T>): void
  off(event: 'error', listener: ErrorListener): void
  off(event: 'close', listener: () => void): void
  off(event: 'data' | 'error' | 'close', listener: Listener<T> | ErrorListener | (() => void)): void {
    if (event === 'data') this.dataListeners.delete(listener as Listener<T>)
    else if (event === 'error') this.errorListeners.delete(listener as ErrorListener)
    else this.closeListeners.delete(listener as () => void)
  }

  /** Push a value to every listener and the async-iterator buffer. No-op once closed. */
  push(value: T): void {
    if (this.closed) return
    for (const listener of this.dataListeners) listener(value)

    // Hand directly to a parked iterator consumer if one is waiting.
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }

    if (this.overflow === 'latest') {
      this.queue.length = 0
      this.queue.push(value)
      return
    }
    this.queue.push(value)
    if (this.overflow === 'drop-oldest' && this.queue.length > this.highWaterMark) {
      this.queue.shift()
      this.dropped += 1
    }
  }

  /** Emit an error to `'error'` listeners. Does not close the stream (transient errors keep the stream alive). */
  fail(error: Error): void {
    if (this.closed) return
    if (this.errorListeners.size === 0 && this.waiters.length === 0) return
    for (const listener of this.errorListeners) listener(error)
  }

  /** Close the stream with a terminal error, rejecting any parked async iterators. */
  destroy(error: Error): void {
    this.failure = error
    for (const listener of this.errorListeners) listener(error)
    this.finish()
  }

  /** Gracefully end the stream: iterators drain the buffer then complete. */
  end(): void {
    this.finish()
  }

  /** Alias for {@link Stream.end} — stop the underlying source and close. */
  close(): void {
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.onClose?.()
    this.onClose = null
    for (const listener of this.closeListeners) listener()
    // Wake every parked consumer.
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as (result: IteratorResult<T>) => void
      waiter({ value: undefined as unknown as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.queue.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.failure) {
          const err = this.failure
          this.failure = null
          return Promise.reject(err)
        }
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => {
        this.finish()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
    }
  }
}
