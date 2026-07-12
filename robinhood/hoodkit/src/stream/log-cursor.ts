import type { Stream } from './stream.js'

/** A source of block heads and logs — satisfied by a viem public client, or a fake in tests. */
export interface LogSource {
  /** Current chain head block number. */
  getBlockNumber(): Promise<bigint>
}

/** Options for {@link runLogCursor}. */
export interface LogCursorOptions<TLog, TEvent> {
  /** Head/height source (a viem public client works directly). */
  source: LogSource
  /** Fetch confirmed logs in `[from, to]` inclusive. Throwing triggers gap-fill on the next tick. */
  getLogs: (from: bigint, to: bigint) => Promise<readonly TLog[]>
  /** Decode a raw log into an event, or `null` to skip it. */
  decode: (log: TLog) => TEvent | null
  /** The stream to push decoded events into. */
  stream: Stream<TEvent>
  /**
   * First block to scan. `undefined` starts at the current head (only new events).
   * A concrete value backfills history from there first.
   */
  fromBlock?: bigint
  /** Poll interval in ms. @defaultValue `1500` */
  pollingIntervalMs?: number
  /** Max blocks per `getLogs` request (public-RPC friendly). @defaultValue `5000n` */
  chunkSize?: bigint
  /**
   * Confirmations to wait before treating a block as final. Reorg-safe streaming
   * re-reads the last `confirmations` blocks each tick. @defaultValue `1`
   */
  confirmations?: bigint
  /** Called when a poll errors (the cursor does NOT advance, so the range is retried). */
  onError?: (error: Error) => void
}

/**
 * The gap-fill engine behind every RPC-backed `hoodkit` stream.
 *
 * It maintains a persistent block **cursor** and only advances it after the
 * logs for a range have been decoded and pushed. If a poll throws — an RPC
 * blip, a dropped socket, a rate limit — the cursor stays put, so the *next*
 * successful poll re-requests the exact same range. No confirmed event is ever
 * silently skipped, which is the property the reconnect gap-fill test asserts.
 *
 * @returns A `stop()` function that halts polling (does not close the stream).
 */
export function runLogCursor<TLog, TEvent>(options: LogCursorOptions<TLog, TEvent>): () => void {
  const pollingIntervalMs = options.pollingIntervalMs ?? 1500
  const chunkSize = options.chunkSize ?? 5000n
  const confirmations = options.confirmations ?? 1n

  let cursor: bigint | null = options.fromBlock ?? null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const head = await options.source.getBlockNumber()
      const safeHead = head > confirmations ? head - confirmations : 0n

      if (cursor === null) {
        // First tick with no explicit start: begin from the next new block.
        cursor = safeHead + 1n
      } else if (safeHead >= cursor) {
        for (let from = cursor; from <= safeHead; from += chunkSize) {
          if (stopped) return
          const to = from + chunkSize - 1n > safeHead ? safeHead : from + chunkSize - 1n
          const logs = await options.getLogs(from, to)
          for (const log of logs) {
            const event = options.decode(log)
            if (event !== null) options.stream.push(event)
          }
          // Advance only after this chunk is fully delivered — an error above
          // leaves `cursor` at the failed range so it is retried next tick.
          cursor = to + 1n
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      options.onError?.(err)
      options.stream.fail(err)
      // Cursor intentionally NOT advanced: the failed range is retried.
    } finally {
      if (!stopped) timer = setTimeout(tick, pollingIntervalMs)
    }
  }

  void tick()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
