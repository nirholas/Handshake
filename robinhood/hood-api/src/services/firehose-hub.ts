import {
  subscribeFeed,
  watchLaunches,
  watchCurveTrades,
  getQuote,
  listPricedStockTokens,
  type FeedMessage,
  type Launch,
  type CurveTrade,
} from 'hoodchain'
import { mainnetClient } from '../upstreams/rpc.js'

/**
 * Real-time event hub for `/v1/ws`. Fans out four live channels to every
 * connected socket from ONE shared upstream subscription each — N paying
 * clients never cost N sequencer connections or N RPC watchers:
 *
 *  - `firehose`  — raw sequencer transactions, ~100–300ms pre-confirmation
 *  - `launches`  — new NOXA / Odyssey token launches (confirmed log watch)
 *  - `trades`    — Odyssey bonding-curve buys/sells ("big swaps" for coins)
 *  - `ticks`     — Chainlink Stock Token price changes ("stock ticks")
 *
 * Upstreams start lazily on the first subscriber and stop when the last
 * disconnects, so an idle deployment makes zero background RPC/WS calls.
 */

export type ChannelName = 'firehose' | 'launches' | 'trades' | 'ticks'
export const ALL_CHANNELS: ChannelName[] = ['firehose', 'launches', 'trades', 'ticks']

export interface HubEvent {
  channel: ChannelName
  data: unknown
  at: string
}

type Listener = (event: HubEvent) => void

const listeners = new Set<Listener>()
let refCount = 0
let stopFns: Array<() => void> = []
let tickTimer: ReturnType<typeof setInterval> | null = null
let lastPrices = new Map<string, number>()

function emit(channel: ChannelName, data: unknown) {
  const event: HubEvent = { channel, data, at: new Date().toISOString() }
  for (const l of listeners) l(event)
}

async function startUpstreams() {
  const client = mainnetClient()

  const feedSub = await subscribeFeed(
    (msg: FeedMessage) => {
      if (msg.transactions.length === 0) return
      emit(
        'firehose',
        msg.transactions.map((tx) => ({ hash: tx.hash, to: tx.transaction.to, sequenceNumber: msg.sequenceNumber })),
      )
    },
    { onError: (err) => console.warn('[hood-api] firehose upstream error:', err.message) },
  )
  stopFns.push(() => feedSub.close())

  const unwatchLaunches = watchLaunches(
    client,
    (l: Launch) => emit('launches', { launchpad: l.launchpad, token: l.token, creator: l.creator, pool: l.pool }),
    { onError: (err) => console.warn('[hood-api] launches watcher error:', err.message) },
  )
  stopFns.push(unwatchLaunches)

  const unwatchTrades = watchCurveTrades(
    client,
    (t: CurveTrade) =>
      emit('trades', {
        token: t.token,
        trader: t.trader,
        isBuy: t.isBuy,
        tokenAmount: t.tokenAmount.toString(),
        quoteAmountEth: Number(t.quoteAmount) / 1e18,
      }),
    { onError: (err) => console.warn('[hood-api] trades watcher error:', err.message) },
  )
  stopFns.push(unwatchTrades)

  lastPrices = new Map()
  tickTimer = setInterval(async () => {
    const symbols = listPricedStockTokens().map((t) => t.symbol)
    for (const symbol of symbols) {
      try {
        const q = await getQuote(client, symbol)
        const prev = lastPrices.get(symbol)
        if (prev === undefined || prev !== q.priceUsd) {
          lastPrices.set(symbol, q.priceUsd)
          emit('ticks', { symbol, priceUsd: q.priceUsd, updatedAt: new Date(q.updatedAt * 1000).toISOString() })
        }
      } catch {
        // stale/missing feed for this symbol this tick — skip, not fatal
      }
    }
  }, 15_000)
  stopFns.push(() => {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  })
}

function stopUpstreams() {
  for (const stop of stopFns) stop()
  stopFns = []
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  refCount += 1
  if (refCount === 1) void startUpstreams()
  return () => {
    listeners.delete(listener)
    refCount -= 1
    if (refCount === 0) stopUpstreams()
  }
}

export function activeConnections(): number {
  return refCount
}
