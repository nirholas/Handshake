import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { AlertEngine } from '../src/engine/engine.js'
import type { DetectorConfig } from '../src/config.js'
import type { AlertEvent } from '../src/engine/events.js'
import type { Transport } from '../src/transports/types.js'

const DETECTORS: DetectorConfig = {
  whaleFloorUsd: 1000,
  whaleDefaultUsd: 5000,
  priceWindowS: 900,
  priceDefaultPct: 2,
  premiumPollS: 60,
  premiumDefaultPct: 2,
  rugDefaultPct: 30,
}

const TOKEN = '0x1234567890123456789012345678901234567890' as `0x${string}`

function whaleEvent(usd: number, token: `0x${string}` = TOKEN, at = 0): AlertEvent {
  return { type: 'whale', source: 'uniswap-v3', token, symbol: 'X', side: 'buy', usd, trader: TOKEN, blockNumber: 1n, transactionHash: `0x${usd}`, at }
}

class FakeTransport implements Transport {
  readonly platform = 'telegram' as const
  alerts: Array<{ chatId: string; event: AlertEvent }> = []
  digests: Array<{ chatId: string; events: AlertEvent[] }> = []
  async sendAlert(chatId: string, event: AlertEvent): Promise<void> {
    this.alerts.push({ chatId, event })
  }
  async sendDigest(chatId: string, events: AlertEvent[]): Promise<void> {
    this.digests.push({ chatId, events })
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

let db: Db
let engine: AlertEngine
let transport: FakeTransport

beforeEach(() => {
  db = openDb(':memory:')
  engine = new AlertEngine(db, DETECTORS)
  transport = new FakeTransport()
  engine.registerTransport(transport)
})

afterEach(() => {
  db.close()
})

describe('AlertEngine.ingest: routing + delivery', () => {
  it('delivers to a matching subscriber immediately', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    engine.ingest(whaleEvent(6000))
    await vi.waitFor(() => expect(transport.alerts).toHaveLength(1))
    expect(transport.alerts[0]?.chatId).toBe('chat-1')
  })

  it('does not deliver when the event does not clear the threshold', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    engine.ingest(whaleEvent(1000))
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(0)
  })

  it('does not deliver to subscribers on other topics', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'launches', null)
    engine.ingest(whaleEvent(6000))
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(0)
  })

  it('logs a delivery failure when no transport is registered for the platform', async () => {
    const discordSub = engine.subscribers.ensure('discord', 'chat-2')
    engine.subscribers.subscribe(discordSub.id, 'whales', 5000)
    engine.ingest(whaleEvent(6000))
    await new Promise((r) => setTimeout(r, 10))
    expect(engine.deliveries.recentCount(discordSub.id, 3600)).toBe(0)
  })

  it('deduplicates identical events by fingerprint', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    const event = whaleEvent(6000)
    engine.ingest(event)
    engine.ingest(event) // same fingerprint: dropped before routing
    await vi.waitFor(() => expect(transport.alerts.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(1)
  })

  it('premium-only topics stop matching once the entitlement lapses', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'rugs', 30)
    // never activated premium
    const pull: AlertEvent = { type: 'liquidity_pull', token: TOKEN, symbol: 'X', pool: TOKEN, quoteAsset: 'USDG', droppedPct: 50, beforeUsd: 100, afterUsd: 50, at: 0 }
    engine.ingest(pull)
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(0)
  })

  it('delivers premium-only topics once the subscriber is entitled', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.entitlements.activate('telegram', 'chat-1', 86_400)
    engine.subscribers.subscribe(s.id, 'rugs', 30)
    const pull: AlertEvent = { type: 'liquidity_pull', token: TOKEN, symbol: 'X', pool: TOKEN, quoteAsset: 'USDG', droppedPct: 50, beforeUsd: 100, afterUsd: 50, at: 0 }
    engine.ingest(pull)
    await vi.waitFor(() => expect(transport.alerts).toHaveLength(1))
  })

  it('fans a single event out to every matching subscriber', async () => {
    const a = engine.subscribers.ensure('telegram', 'chat-a')
    engine.subscribers.subscribe(a.id, 'whales', 5000)
    const b = engine.subscribers.ensure('telegram', 'chat-b')
    engine.subscribers.subscribe(b.id, 'whales', 1000)
    engine.ingest(whaleEvent(6000))
    await vi.waitFor(() => expect(transport.alerts).toHaveLength(2))
    expect(transport.alerts.map((a) => a.chatId).sort()).toEqual(['chat-a', 'chat-b'])
  })
})

describe('AlertEngine.ingest: gating into digest', () => {
  it('buffers into a digest for a subscriber with digest mode on, instead of delivering immediately', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    engine.subscribers.setDigest(s.id, true, 3600)
    engine.ingest(whaleEvent(6000))
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(0)
    expect(transport.digests).toHaveLength(0) // not flushed yet (flush runs on a 15s timer)
  })

  it('enforces free-tier granularity: a second immediate alert within 60s digests instead', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 1000)
    engine.ingest(whaleEvent(2000))
    await vi.waitFor(() => expect(transport.alerts).toHaveLength(1))
    engine.ingest(whaleEvent(3000))
    await new Promise((r) => setTimeout(r, 10))
    // second alert should not have delivered immediately (still within FREE_MIN_INTERVAL_S)
    expect(transport.alerts).toHaveLength(1)
  })
})

describe('AlertEngine.watchedTokens / notifyWatchChange', () => {
  it('returns the distinct set of token: watches', () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, `token:${TOKEN}`, 5000)
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    expect(engine.watchedTokens()).toEqual([TOKEN])
  })

  it('onTokenWatches fires immediately with the current set, and again on notifyWatchChange', () => {
    const seen: Array<readonly string[]> = []
    engine.onTokenWatches((tokens) => seen.push(tokens))
    expect(seen).toEqual([[]])
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, `token:${TOKEN}`, 5000)
    engine.notifyWatchChange()
    expect(seen).toEqual([[], [TOKEN]])
  })
})

describe('AlertEngine.stop', () => {
  it('flushes any pending digest buffers on shutdown', async () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 5000)
    engine.subscribers.setDigest(s.id, true, 3600)
    engine.ingest(whaleEvent(6000))
    await new Promise((r) => setTimeout(r, 10))
    expect(transport.alerts).toHaveLength(0)
    await engine.stop()
    expect(transport.alerts).toHaveLength(1) // sole buffered alert flushes as a single sendAlert
  })
})

describe('AlertEngine.recent', () => {
  it('keeps a ring buffer of the most recent 100 events', () => {
    const s = engine.subscribers.ensure('telegram', 'chat-1')
    engine.subscribers.subscribe(s.id, 'whales', 0)
    for (let i = 0; i < 105; i++) engine.ingest(whaleEvent(1000 + i, TOKEN, i))
    expect(engine.recent).toHaveLength(100)
  })
})
