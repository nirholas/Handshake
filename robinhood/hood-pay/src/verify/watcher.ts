import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem'
import { networkInfo, type HoodPayNetwork } from '../networks.js'
import type { MatchedTransfer, PaymentResult, PaymentStatus } from './types.js'

/**
 * The merchant-side payment watcher. Amounts are verified ON-CHAIN - never
 * trusted from the DOM, a callback, or a webhook body. Reorg policy:
 *
 * - Only blocks at depth >= `confirmations` below the head are ever
 *   scanned, so a log must survive `confirmations` blocks before it can
 *   count (default 30; ~3s of Robinhood Chain's ~100ms blocks).
 * - Every candidate log's block hash is re-fetched by number and compared;
 *   a mismatch means the block was reorged out after our scan and the log
 *   is dropped.
 *
 * Together this makes a confirmed result stable under any reorg shallower
 * than `confirmations` blocks, and immune to deeper ones that happen
 * between scanning and re-checking.
 */

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const paymentReceivedEvent = parseAbiItem(
  'event PaymentReceived(bytes32 indexed ref, address indexed payer, address indexed payTo, address token, uint256 amount)',
)

/** The narrow slice of a viem `PublicClient` the watcher needs (stub-friendly). */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null }>
  getLogs(args: {
    address: Address
    event: typeof transferEvent | typeof paymentReceivedEvent
    args?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
  }): Promise<
    Array<{
      transactionHash: Hex | null
      logIndex: number | null
      blockNumber: bigint | null
      blockHash: Hex | null
      args: Record<string, unknown>
    }>
  >
}

/** Build a {@link ChainReader} for a network from viem's public client. */
export function createReader(network: HoodPayNetwork, rpcUrl?: string): ChainReader {
  const info = networkInfo(network)
  return createPublicClient({ transport: http(rpcUrl ?? info.rpcUrl) }) as unknown as ChainReader
}

/** What to watch for. Exactly one of `reference` (router mode) or plain direct mode. */
export interface WatchSpec {
  /** Token contract the invoice settles in. */
  token: Address
  /** Merchant receiving address. */
  payTo: Address
  /** Raw token units expected. */
  expectedRaw: bigint
  /** Router mode: the 32-byte reference and the router emitting it. */
  reference?: Hex
  router?: Address
  /**
   * Direct mode: the buyer's address, when known (the widget reports it on
   * success). With a payer, every transfer payer -> payTo is attributed, so
   * under/overpayment is detected. Without one, only an EXACT match of the
   * fingerprinted amount is attributable.
   */
  payer?: Address
}

/** Options shared by {@link awaitPayment} and {@link checkPayment}. */
export interface WatchOptions {
  reader: ChainReader
  /** First block to scan (e.g. the block height when the invoice was created). */
  fromBlock: bigint
  /** Confirmation depth before a log may count. @defaultValue 30 */
  confirmations?: number
  /** Max blocks per `eth_getLogs` call. @defaultValue 5000 */
  chunkSize?: bigint
}

export interface AwaitPaymentOptions extends WatchOptions {
  /** Give up after this long. @defaultValue 600_000 (10 minutes) */
  timeoutMs?: number
  /** Delay between head polls. @defaultValue 1500 */
  pollIntervalMs?: number
  /** Observer called whenever the aggregate status changes. */
  onState?: (result: PaymentResult) => void
  /** Abort from outside (e.g. buyer cancelled). */
  signal?: AbortSignal
}

function statusFor(expected: bigint, received: bigint): PaymentStatus {
  if (received === 0n) return 'pending'
  if (received < expected) return 'underpaid'
  if (received === expected) return 'paid'
  return 'overpaid'
}

function toResult(spec: WatchSpec, transfers: MatchedTransfer[]): PaymentResult {
  const receivedRaw = transfers.reduce((sum, t) => sum + t.amountRaw, 0n)
  const status = statusFor(spec.expectedRaw, receivedRaw)
  const result: PaymentResult = {
    status,
    expectedRaw: spec.expectedRaw,
    receivedRaw,
    overageRaw: receivedRaw > spec.expectedRaw ? receivedRaw - spec.expectedRaw : 0n,
    transfers,
  }
  if (transfers[0]) result.payer = transfers[0].payer
  if (spec.reference) result.reference = spec.reference
  return result
}

/** Scan one confirmed block range for attributable events. */
async function scanRange(
  spec: WatchSpec,
  reader: ChainReader,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<MatchedTransfer[]> {
  const matches: MatchedTransfer[] = []
  const logs = spec.reference
    ? await reader.getLogs({
        address: spec.router!,
        event: paymentReceivedEvent,
        args: { ref: spec.reference, payTo: spec.payTo },
        fromBlock,
        toBlock,
      })
    : await reader.getLogs({
        address: spec.token,
        event: transferEvent,
        args: spec.payer ? { from: spec.payer, to: spec.payTo } : { to: spec.payTo },
        fromBlock,
        toBlock,
      })

  for (const log of logs) {
    if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
      continue // pending log - not yet mined, cannot count
    }
    let payer: Address
    let amountRaw: bigint
    if (spec.reference) {
      if ((log.args.token as string).toLowerCase() !== spec.token.toLowerCase()) continue
      payer = log.args.payer as Address
      amountRaw = log.args.amount as bigint
    } else {
      payer = log.args.from as Address
      amountRaw = log.args.value as bigint
      // Anonymous direct mode: only the exact fingerprinted amount is
      // attributable to THIS invoice; other transfers belong to other buyers.
      if (!spec.payer && amountRaw !== spec.expectedRaw) continue
    }
    // Reorg re-check: the block that carried this log must still be canonical.
    const canonical = await reader.getBlock({ blockNumber: log.blockNumber })
    if (!canonical.hash || canonical.hash.toLowerCase() !== log.blockHash.toLowerCase()) continue
    matches.push({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      payer,
      amountRaw,
    })
  }
  return matches
}

/**
 * One-shot historical check: scan `[fromBlock, head - confirmations]` once
 * and report. Useful for reconciliation and audits of past invoices.
 */
export async function checkPayment(spec: WatchSpec, options: WatchOptions): Promise<PaymentResult> {
  const confirmations = BigInt(options.confirmations ?? 30)
  const chunkSize = options.chunkSize ?? 5000n
  const head = await options.reader.getBlockNumber()
  const safeHead = head - confirmations
  const transfers: MatchedTransfer[] = []
  let cursor = options.fromBlock
  while (cursor <= safeHead) {
    const to = cursor + chunkSize - 1n > safeHead ? safeHead : cursor + chunkSize - 1n
    transfers.push(...(await scanRange(spec, options.reader, cursor, to)))
    cursor = to + 1n
  }
  return toResult(spec, transfers)
}

class Deferred<T> {
  promise: Promise<T>
  resolve!: (value: T) => void
  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }
}

/**
 * Watch the chain until the invoice is settled (paid or overpaid), the
 * timeout elapses, or `signal` aborts. NEVER rejects on settlement grounds:
 * the returned {@link PaymentResult} carries the terminal status
 * (`paid` / `overpaid` / `underpaid` / `expired`) so merchants handle every
 * outcome explicitly. Network errors during a poll are retried on the next
 * tick; a persistent RPC failure surfaces after the timeout as the current
 * aggregate state.
 */
export async function awaitPayment(spec: WatchSpec, options: AwaitPaymentOptions): Promise<PaymentResult> {
  if (spec.reference && !spec.router) {
    throw new TypeError('router-mode specs (reference set) need the router address')
  }
  const confirmations = BigInt(options.confirmations ?? 30)
  const chunkSize = options.chunkSize ?? 5000n
  const timeoutMs = options.timeoutMs ?? 600_000
  const pollIntervalMs = options.pollIntervalMs ?? 1500
  const startedAt = Date.now()

  const seen = new Set<string>()
  const transfers: MatchedTransfer[] = []
  let cursor = options.fromBlock
  let lastStatus: PaymentStatus | undefined
  const done = new Deferred<PaymentResult>()
  let settled = false

  const finish = (result: PaymentResult) => {
    if (settled) return
    settled = true
    done.resolve(result)
  }

  const tick = async () => {
    const head = await options.reader.getBlockNumber()
    const safeHead = head - confirmations
    while (cursor <= safeHead) {
      const to = cursor + chunkSize - 1n > safeHead ? safeHead : cursor + chunkSize - 1n
      for (const match of await scanRange(spec, options.reader, cursor, to)) {
        const key = `${match.txHash}:${match.logIndex}`
        if (seen.has(key)) continue
        seen.add(key)
        transfers.push(match)
      }
      cursor = to + 1n
    }
    const result = toResult(spec, transfers)
    if (result.status !== lastStatus) {
      lastStatus = result.status
      options.onState?.(result)
    }
    if (result.status === 'paid' || result.status === 'overpaid') finish(result)
  }

  const loop = async () => {
    while (!settled) {
      try {
        await tick()
      } catch {
        // transient RPC failure: retry on the next tick
      }
      if (settled) return
      if (Date.now() - startedAt >= timeoutMs || options.signal?.aborted) {
        const result = toResult(spec, transfers)
        finish(result.status === 'pending' ? { ...result, status: 'expired' } : result)
        return
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
  }
  void loop()
  return done.promise
}
