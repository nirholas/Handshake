import { parseTransaction, keccak256, type Address, type Hash, type TransactionSerializable } from 'viem'
import { erc20Abi } from './abis.js'
import { MAINNET_FEED_URL } from './addresses.js'
import type { HoodClient } from './client.js'
import { FeedConnectionError } from './errors.js'

/**
 * Sequencer firehose client for Robinhood Chain.
 *
 * The chain publishes its Arbitrum Nitro sequencer feed at
 * `wss://feed.mainnet.chain.robinhood.com` — no auth, frames of the exact
 * Nitro broadcast shape (verified live during SDK development):
 *
 * ```json
 * { "version": 1, "messages": [ {
 *     "sequenceNumber": 123,
 *     "message": { "message": { "header": { "kind": 3, "sender": "0x…",
 *       "blockNumber": 456, "timestamp": 1780000000 },
 *       "l2Msg": "<base64>" }, "delayedMessagesRead": 7 },
 *     "blockHash": "0x…" } ] }
 * ```
 *
 * `l2Msg` is a Nitro L2 message: first byte is the kind — `0x04`
 * (SignedTx: the rest is one RLP/typed raw transaction) or `0x03` (Batch:
 * length-prefixed nested L2 messages). This client decodes both into viem
 * transactions and hands everything else through raw.
 *
 * Works in Node ≥ 20. Uses the global `WebSocket` when available (Node 22+,
 * browsers, bun/deno) and falls back to the optional `ws` peer dependency.
 */

/** One frame from the sequencer feed, decoded. */
export interface FeedMessage {
  sequenceNumber: number
  /** L1 message kind from the Nitro header (3 = L2Message, the common case). */
  kind: number
  /** Header sender (the sequencer for kind-3 messages). */
  sender: Address
  /** L1 block number stamped in the header. */
  l1BlockNumber: number
  /** Header timestamp (seconds). */
  timestamp: number
  /** Raw base64 `l2Msg` payload. */
  l2MsgBase64: string
  /**
   * Transactions decoded out of the payload (empty for non-transaction
   * kinds or unparseable payloads — never throws).
   */
  transactions: DecodedFeedTransaction[]
}

/** A transaction recovered from the firehose before it lands in a block. */
export interface DecodedFeedTransaction {
  /** keccak256 of the raw signed bytes — the eventual transaction hash. */
  hash: Hash
  /** Parsed viem transaction (type, to, value, data, …). */
  transaction: TransactionSerializable
  /** The raw signed transaction bytes. */
  raw: `0x${string}`
}

/** Options for {@link subscribeFeed}. */
export interface FeedOptions {
  /** Feed endpoint. @defaultValue {@link MAINNET_FEED_URL} */
  url?: string
  /** Max reconnect attempts before giving up. @defaultValue `10` */
  maxReconnects?: number
  /** Base reconnect delay in ms (doubles per attempt, capped at 30s). @defaultValue `1000` */
  reconnectDelayMs?: number
  /** Called on connection errors (the client keeps reconnecting). */
  onError?: (error: Error) => void
  /** Called on (re)connect. */
  onConnect?: () => void
}

/** Handle returned by {@link subscribeFeed}. */
export interface FeedSubscription {
  /** Close the socket and stop reconnecting. */
  close: () => void
}

const L2MSG_KIND_BATCH = 0x03
const L2MSG_KIND_SIGNED_TX = 0x04

function decodeL2Msg(bytes: Uint8Array, depth = 0): DecodedFeedTransaction[] {
  if (bytes.length < 2 || depth > 4) return []
  const kind = bytes[0]
  const body = bytes.subarray(1)
  if (kind === L2MSG_KIND_SIGNED_TX) {
    const raw = `0x${Buffer.from(body).toString('hex')}` as const
    try {
      return [{ hash: keccak256(raw), transaction: parseTransaction(raw), raw }]
    } catch {
      return []
    }
  }
  if (kind === L2MSG_KIND_BATCH) {
    // Batch: repeated [8-byte big-endian length][nested L2 message].
    const out: DecodedFeedTransaction[] = []
    let offset = 0
    while (offset + 8 <= body.length) {
      const view = new DataView(body.buffer, body.byteOffset + offset, 8)
      const length = Number(view.getBigUint64(0))
      offset += 8
      if (length <= 0 || offset + length > body.length) break
      out.push(...decodeL2Msg(body.subarray(offset, offset + length), depth + 1))
      offset += length
    }
    return out
  }
  return []
}

async function resolveWebSocket(): Promise<new (url: string) => WebSocket> {
  const g = globalThis as { WebSocket?: new (url: string) => WebSocket }
  if (typeof g.WebSocket === 'function') return g.WebSocket
  try {
    const ws = await import('ws')
    return ws.default as unknown as new (url: string) => WebSocket
  } catch {
    throw new FeedConnectionError(
      MAINNET_FEED_URL,
      0,
      'no WebSocket implementation available — use Node ≥ 22 or install the optional "ws" peer dependency',
    )
  }
}

/**
 * Subscribe to the sequencer firehose: every L2 message the sequencer
 * publishes, decoded to transactions ~100–300ms before they are queryable
 * over RPC. Reconnects automatically with exponential backoff.
 *
 * @example Print every transaction hash the sequencer emits
 * ```ts
 * const sub = await subscribeFeed((msg) => {
 *   for (const tx of msg.transactions) console.log(tx.hash, tx.transaction.to)
 * })
 * // later: sub.close()
 * ```
 */
export async function subscribeFeed(
  onMessage: (message: FeedMessage) => void,
  options: FeedOptions = {},
): Promise<FeedSubscription> {
  const url = options.url ?? MAINNET_FEED_URL
  const maxReconnects = options.maxReconnects ?? 10
  const WS = await resolveWebSocket()

  let socket: WebSocket | null = null
  let closed = false
  let attempts = 0

  const connect = () => {
    if (closed) return
    socket = new WS(url)
    socket.onopen = () => {
      attempts = 0
      options.onConnect?.()
    }
    socket.onmessage = (event: MessageEvent) => {
      let payload: { messages?: unknown[] }
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString())
      } catch {
        return
      }
      for (const entry of payload.messages ?? []) {
        const m = entry as {
          sequenceNumber?: number
          message?: { message?: { header?: { kind?: number; sender?: string; blockNumber?: number; timestamp?: number }; l2Msg?: string } }
        }
        const header = m.message?.message?.header
        const l2Msg = m.message?.message?.l2Msg
        if (!header || typeof l2Msg !== 'string') continue
        onMessage({
          sequenceNumber: m.sequenceNumber ?? 0,
          kind: header.kind ?? 0,
          sender: (header.sender ?? '0x0000000000000000000000000000000000000000') as Address,
          l1BlockNumber: header.blockNumber ?? 0,
          timestamp: header.timestamp ?? 0,
          l2MsgBase64: l2Msg,
          transactions: header.kind === 3 ? decodeL2Msg(Buffer.from(l2Msg, 'base64')) : [],
        })
      }
    }
    socket.onerror = () => {
      options.onError?.(new Error(`sequencer feed socket error (${url})`))
    }
    socket.onclose = () => {
      if (closed) return
      attempts += 1
      if (attempts > maxReconnects) {
        options.onError?.(new FeedConnectionError(url, attempts))
        return
      }
      const delay = Math.min((options.reconnectDelayMs ?? 1000) * 2 ** (attempts - 1), 30_000)
      setTimeout(connect, delay)
    }
  }
  connect()

  return {
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

/** A decoded ERC-20 transfer from {@link watchTransfers}. */
export interface TokenTransfer {
  token: Address
  from: Address
  to: Address
  value: bigint
  blockNumber: bigint
  transactionHash: Hash
}

/**
 * Simpler event stream for consumers who don't need the firehose: watch
 * confirmed `Transfer` logs for a token over RPC polling.
 *
 * @returns An unwatch function.
 *
 * @example Watch USDG transfers
 * ```ts
 * const unwatch = watchTransfers(hood, { token: MAINNET_ADDRESSES.usdg }, (t) => {
 *   console.log(`${t.from} → ${t.to}: ${formatUsdg(t.value)} USDG`)
 * })
 * ```
 */
export function watchTransfers(
  client: HoodClient,
  args: { token: Address; pollingInterval?: number; onError?: (error: Error) => void },
  onTransfer: (transfer: TokenTransfer) => void,
): () => void {
  return client.public.watchContractEvent({
    address: args.token,
    abi: erc20Abi,
    eventName: 'Transfer',
    pollingInterval: args.pollingInterval ?? 2000,
    onError: args.onError,
    onLogs: (logs) => {
      for (const log of logs) {
        const a = log.args as { from?: Address; to?: Address; value?: bigint }
        if (!a.from || !a.to || a.value === undefined) continue
        onTransfer({
          token: args.token,
          from: a.from,
          to: a.to,
          value: a.value,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    },
  })
}
