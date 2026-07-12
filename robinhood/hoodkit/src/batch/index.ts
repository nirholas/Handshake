import type { Abi, Address } from 'viem'
import type { HoodClient } from 'hoodchain'

/** A single contract read: the same shape viem's `multicall` accepts per entry. */
export interface ContractRead {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

/** Result of a read that may fail when `allowFailure` is on. */
export type BatchResult<T = unknown> =
  | { status: 'success'; result: T }
  | { status: 'failure'; error: Error }

/** Options controlling multicall chunking. */
export interface BatchOptions {
  /**
   * Max calls per `aggregate3` round-trip. Large batches can exceed a node's
   * `eth_call` gas cap, so reads are chunked. @defaultValue `500`
   */
  maxBatchSize?: number
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Execute many contract reads in the fewest possible Multicall3 round-trips.
 * Reads are chunked to `maxBatchSize` and the chunks run concurrently; results
 * come back in the exact input order.
 *
 * Unlike `client.public.multicall`, `plan` never rejects on a single failing
 * read — every result carries a `status`, so one reverting call can't sink the
 * whole batch.
 *
 * @example
 * ```ts
 * const results = await plan(hood, [
 *   { address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [me] },
 *   { address: weth, abi: erc20Abi, functionName: 'totalSupply' },
 * ])
 * if (results[0].status === 'success') console.log(results[0].result)
 * ```
 */
export async function plan<T = unknown>(
  client: HoodClient,
  reads: readonly ContractRead[],
  options: BatchOptions = {},
): Promise<BatchResult<T>[]> {
  if (reads.length === 0) return []
  const size = options.maxBatchSize ?? 500
  const chunks = chunk(reads, size)

  const chunkResults = await Promise.all(
    chunks.map((c) =>
      client.public.multicall({
        contracts: c as unknown as Parameters<typeof client.public.multicall>[0]['contracts'],
        allowFailure: true,
      }),
    ),
  )

  const flat: BatchResult<T>[] = []
  for (const results of chunkResults) {
    for (const r of results as readonly { status: string; result?: unknown; error?: unknown }[]) {
      if (r.status === 'success') flat.push({ status: 'success', result: r.result as T })
      else flat.push({ status: 'failure', error: r.error instanceof Error ? r.error : new Error(String(r.error)) })
    }
  }
  return flat
}

/**
 * A DataLoader-style multicall batcher. Reads enqueued within the same tick are
 * coalesced into one Multicall3 call automatically — code paths that don't know
 * about each other still share a round-trip. Ideal behind an HTTP handler where
 * many independent reads fire per request.
 *
 * @example
 * ```ts
 * const batch = createBatcher(hood)
 * // These three run as ONE multicall even though they're separate awaits:
 * const [a, b, c] = await Promise.all([
 *   batch.call({ address: t1, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
 *   batch.call({ address: t2, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
 *   batch.call({ address: t3, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
 * ])
 * ```
 */
export interface Batcher {
  /** Enqueue a read; resolves with its result (throws only if the call reverts). */
  call<T = unknown>(read: ContractRead): Promise<T>
  /** Enqueue a read; resolves with a `{status}` result and never rejects. */
  callSafe<T = unknown>(read: ContractRead): Promise<BatchResult<T>>
  /** Force-flush the current queue immediately (rarely needed — flush is automatic). */
  flush(): Promise<void>
  /** Number of reads waiting for the next flush. */
  readonly pending: number
}

interface QueuedRead {
  read: ContractRead
  resolve: (result: BatchResult) => void
}

/** Create a {@link Batcher}. */
export function createBatcher(client: HoodClient, options: BatchOptions = {}): Batcher {
  let queue: QueuedRead[] = []
  let scheduled = false

  async function runFlush(): Promise<void> {
    scheduled = false
    if (queue.length === 0) return
    const batch = queue
    queue = []
    try {
      const results = await plan(client, batch.map((q) => q.read), options)
      batch.forEach((q, i) => q.resolve(results[i] as BatchResult))
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      for (const q of batch) q.resolve({ status: 'failure', error: err })
    }
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => void runFlush())
  }

  function enqueue(read: ContractRead): Promise<BatchResult> {
    return new Promise<BatchResult>((resolve) => {
      queue.push({ read, resolve })
      schedule()
    })
  }

  return {
    get pending() {
      return queue.length
    },
    callSafe: <T>(read: ContractRead) => enqueue(read) as Promise<BatchResult<T>>,
    call: async <T>(read: ContractRead): Promise<T> => {
      const result = await enqueue(read)
      if (result.status === 'failure') throw result.error
      return result.result as T
    },
    flush: runFlush,
  }
}
