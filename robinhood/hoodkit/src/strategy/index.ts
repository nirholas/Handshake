import { type Address, type Hash } from 'viem'
import {
  buildSwapTx,
  ensureApproval,
  quoteSwap,
  type HoodClient,
  type SwapQuote,
} from 'hoodchain'
import { streamPrices, type PriceTick, type StreamPollOptions } from '../stream/index.js'

/**
 * Concise error text for a failed slice. Prefers viem's `shortMessage` (a
 * one-line summary) over the default `message`, which on a reverted `eth_call`
 * embeds the full raw calldata and is unreadable in a log line.
 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'shortMessage' in error && typeof error.shortMessage === 'string') {
    return error.shortMessage
  }
  return error instanceof Error ? error.message : String(error)
}

export { Position } from './position.js'
export type { Fill, PnlSnapshot } from './position.js'

/** Thrown when an action would exceed a {@link SpendCap}. */
export class SpendCapExceededError extends Error {
  constructor(
    readonly attempted: bigint,
    readonly remaining: bigint,
  ) {
    super(`spend cap exceeded: attempted ${attempted}, only ${remaining} remaining`)
    this.name = 'SpendCapExceededError'
  }
}

/**
 * A hard cumulative spend limit in the raw units of one token. Every spending
 * primitive here consults a `SpendCap`; once the cap is hit, further spends
 * throw {@link SpendCapExceededError} rather than silently proceeding.
 */
export class SpendCap {
  private spentAmount = 0n
  constructor(readonly cap: bigint) {
    if (cap < 0n) throw new Error('cap must be non-negative')
  }
  /** Amount spent so far. */
  get spent(): bigint {
    return this.spentAmount
  }
  /** Remaining headroom. */
  get remaining(): bigint {
    return this.cap > this.spentAmount ? this.cap - this.spentAmount : 0n
  }
  /** `true` if `amount` still fits under the cap. */
  canSpend(amount: bigint): boolean {
    return this.spentAmount + amount <= this.cap
  }
  /** Reserve `amount`, or throw if it would breach the cap. */
  spend(amount: bigint): void {
    if (!this.canSpend(amount)) throw new SpendCapExceededError(amount, this.remaining)
    this.spentAmount += amount
  }
}

/** Direction of a price crossing. */
export type CrossDirection = 'up' | 'down' | 'any'

/** A fired price-cross event. */
export interface CrossEvent {
  symbol: string
  threshold: number
  direction: 'up' | 'down'
  price: number
  previous: number
}

/**
 * Fire callbacks when Stock Token prices cross thresholds. Wraps
 * {@link streamPrices}; tracks the last price per symbol and emits a
 * {@link CrossEvent} each time a configured threshold is crossed.
 *
 * @example
 * ```ts
 * const triggers = createPriceTriggers(hood)
 * triggers.onCross('AAPL', 250, 'up', (e) => console.log('AAPL broke $250', e.price))
 * // later: triggers.stop()
 * ```
 */
export interface PriceTriggers {
  /** Register a threshold crossing callback. Returns an unsubscribe fn. */
  onCross(symbol: string, threshold: number, direction: CrossDirection, callback: (event: CrossEvent) => void): () => void
  /** Stop the underlying price stream and clear all triggers. */
  stop(): void
}

interface Trigger {
  symbol: string
  threshold: number
  direction: CrossDirection
  callback: (event: CrossEvent) => void
}

/** Create a {@link PriceTriggers} controller over live Stock Token prices. */
export function createPriceTriggers(client: HoodClient, options: StreamPollOptions = {}): PriceTriggers {
  const triggers = new Set<Trigger>()
  const last = new Map<string, number>()
  let stream: ReturnType<typeof streamPrices> | null = null

  function ensureStream(): void {
    if (stream) return
    const symbols = [...new Set([...triggers].map((t) => t.symbol.toUpperCase()))]
    stream = streamPrices(client, symbols, options)
    stream.on('data', (tick: PriceTick) => {
      const prev = last.get(tick.symbol)
      last.set(tick.symbol, tick.priceUsd)
      if (prev === undefined) return
      for (const trigger of triggers) {
        if (trigger.symbol.toUpperCase() !== tick.symbol.toUpperCase()) continue
        const crossedUp = prev < trigger.threshold && tick.priceUsd >= trigger.threshold
        const crossedDown = prev > trigger.threshold && tick.priceUsd <= trigger.threshold
        if ((trigger.direction === 'up' || trigger.direction === 'any') && crossedUp) {
          trigger.callback({ symbol: tick.symbol, threshold: trigger.threshold, direction: 'up', price: tick.priceUsd, previous: prev })
        } else if ((trigger.direction === 'down' || trigger.direction === 'any') && crossedDown) {
          trigger.callback({ symbol: tick.symbol, threshold: trigger.threshold, direction: 'down', price: tick.priceUsd, previous: prev })
        }
      }
    })
  }

  return {
    onCross(symbol, threshold, direction, callback) {
      const trigger: Trigger = { symbol, threshold, direction, callback }
      triggers.add(trigger)
      // Restart the stream so a newly-referenced symbol is polled.
      if (stream) {
        stream.close()
        stream = null
      }
      ensureStream()
      return () => triggers.delete(trigger)
    },
    stop() {
      stream?.close()
      stream = null
      triggers.clear()
    },
  }
}

/** Configuration for a {@link TwapExecutor}. */
export interface TwapConfig {
  tokenIn: Address
  tokenOut: Address
  /** Total input amount to work, in `tokenIn` raw units. */
  totalAmountIn: bigint
  /** Number of equal slices. @defaultValue `4` */
  slices?: number
  /** Delay between slices in ms. @defaultValue `60_000` */
  intervalMs?: number
  /** Per-slice slippage tolerance in basis points. @defaultValue `50` */
  slippageBps?: number
  /** Hard spend cap on `tokenIn`. Defaults to `totalAmountIn`. */
  spendCap?: SpendCap
  /** Kill switch — abort between slices. */
  signal?: AbortSignal
  /**
   * When `true`, quote + build + `eth_call` simulate each slice WITHOUT sending.
   * Defaults to `true` unless the client has a wallet. Set `false` explicitly to
   * send real transactions.
   */
  dryRun?: boolean
  /**
   * Output recipient. Defaults to `client.account?.address`. Required when
   * dry-running a TWAP on a read-only client (no account) — planning and
   * simulating a swap for an address you're merely watching needs no keys.
   */
  recipient?: Address
  /** Called before each slice; return `false` to skip it. */
  onBeforeSlice?: (slice: TwapSlicePlan) => boolean | Promise<boolean>
  /** Called after each slice with its result. */
  onSlice?: (result: TwapSliceResult) => void
}

/** The plan for one TWAP slice. */
export interface TwapSlicePlan {
  index: number
  total: number
  amountIn: bigint
}

/** The outcome of one TWAP slice. */
export interface TwapSliceResult extends TwapSlicePlan {
  status: 'sent' | 'simulated' | 'skipped' | 'failed'
  quote?: SwapQuote
  amountOutMinimum?: bigint
  hash?: Hash
  error?: string
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })

/**
 * Execute a large swap as a Time-Weighted Average Price schedule: split
 * `totalAmountIn` into equal slices spaced `intervalMs` apart, each quoted and
 * slippage-bounded independently. Enforces a hard {@link SpendCap}, honors an
 * `AbortSignal` kill switch between slices, and defaults to **dry-run**
 * (simulate via `eth_call`, send nothing) until you opt into live execution.
 *
 * @example Dry-run a 1000-USDG TWAP over 5 slices
 * ```ts
 * const twap = createTwapExecutor(hood, {
 *   tokenIn: usdg, tokenOut: weth, totalAmountIn: parseUsdg('1000'), slices: 5,
 * })
 * const results = await twap.run() // dryRun defaults on with no wallet
 * ```
 */
export interface TwapExecutor {
  /** The slice schedule that will be worked. */
  plan(): TwapSlicePlan[]
  /** Work the schedule; resolves with each slice's result. */
  run(): Promise<TwapSliceResult[]>
}

/** Create a {@link TwapExecutor}. */
export function createTwapExecutor(client: HoodClient, config: TwapConfig): TwapExecutor {
  const slices = Math.max(1, config.slices ?? 4)
  const intervalMs = config.intervalMs ?? 60_000
  const slippageBps = config.slippageBps ?? 50
  const spendCap = config.spendCap ?? new SpendCap(config.totalAmountIn)
  const dryRun = config.dryRun ?? client.wallet === null

  const base = config.totalAmountIn / BigInt(slices)
  const remainder = config.totalAmountIn - base * BigInt(slices)

  function buildPlan(): TwapSlicePlan[] {
    const out: TwapSlicePlan[] = []
    for (let i = 0; i < slices; i++) {
      // Put the rounding remainder on the last slice so the sum is exact.
      const amountIn = i === slices - 1 ? base + remainder : base
      out.push({ index: i, total: slices, amountIn })
    }
    return out
  }

  async function executeSlice(planItem: TwapSlicePlan): Promise<TwapSliceResult> {
    const { index, total, amountIn } = planItem
    try {
      if (config.onBeforeSlice) {
        const proceed = await config.onBeforeSlice(planItem)
        if (!proceed) return { index, total, amountIn, status: 'skipped' }
      }
      if (!spendCap.canSpend(amountIn)) {
        return { index, total, amountIn, status: 'skipped', error: 'spend cap reached' }
      }

      const quote = await quoteSwap(client, { tokenIn: config.tokenIn, tokenOut: config.tokenOut, amountIn })
      const tx = buildSwapTx(client, quote, { slippageBps, recipient: config.recipient })

      if (dryRun) {
        // Simulate via eth_call — no state change, no signature.
        await client.public.call({ to: tx.to, data: tx.data, value: tx.value, account: client.account ?? undefined })
        return { index, total, amountIn, status: 'simulated', quote, amountOutMinimum: tx.amountOutMinimum }
      }

      if (!client.wallet || !client.account) throw new Error('live TWAP requires a wallet account on the client')
      await ensureApproval(client, config.tokenIn, amountIn)
      const hash = await client.wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, account: client.account, chain: client.chain })
      await client.public.waitForTransactionReceipt({ hash })
      spendCap.spend(amountIn)
      return { index, total, amountIn, status: 'sent', quote, amountOutMinimum: tx.amountOutMinimum, hash }
    } catch (error) {
      return { index, total, amountIn, status: 'failed', error: describeError(error) }
    }
  }

  return {
    plan: buildPlan,
    async run() {
      const plan = buildPlan()
      const results: TwapSliceResult[] = []
      for (let i = 0; i < plan.length; i++) {
        if (config.signal?.aborted) break
        const result = await executeSlice(plan[i] as TwapSlicePlan)
        results.push(result)
        config.onSlice?.(result)
        if (i < plan.length - 1) {
          try {
            await sleep(intervalMs, config.signal)
          } catch {
            break // aborted
          }
        }
      }
      return results
    },
  }
}
