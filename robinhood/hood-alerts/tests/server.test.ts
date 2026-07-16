import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { AlertEngine } from '../src/engine/engine.js'
import { buildApp } from '../src/server.js'
import type { Config } from '../src/config.js'
import type { DetectorConfig } from '../src/config.js'
import type { LiveDetectors } from '../src/engine/detectors/live.js'
import type { PremiumPaywall } from '../src/premium/paywall.js'
import type { ActivationResult } from '../src/premium/paywall.js'

const DETECTORS: DetectorConfig = {
  whaleFloorUsd: 1000,
  whaleDefaultUsd: 5000,
  priceWindowS: 900,
  priceDefaultPct: 2,
  premiumPollS: 60,
  premiumDefaultPct: 2,
  rugDefaultPct: 30,
}

function makeConfig(): Config {
  return {
    rpcUrl: undefined,
    dbPath: ':memory:',
    port: 8080,
    publicUrl: 'http://localhost:8080',
    telegramToken: null,
    discordToken: null,
    discordAppId: null,
    premiumRail: 'hood402',
    payTo: null,
    facilitatorUrl: null,
    settlerKey: null,
    premiumPriceUsdg: '5',
    premiumDays: 30,
    detectors: DETECTORS,
  }
}

function fakeDetectors(overrides: Partial<{ lastEventAt: number | null; eventCounts: Record<string, number> }> = {}): LiveDetectors {
  return {
    lastEventAt: overrides.lastEventAt ?? null,
    eventCounts: overrides.eventCounts ?? {},
  } as unknown as LiveDetectors
}

function fakePaywall(enabled: boolean, activate?: (...args: unknown[]) => Promise<ActivationResult>): PremiumPaywall {
  return {
    enabled,
    activate: activate ?? (async () => ({ status: 503, body: { error: 'not configured' } })),
  } as unknown as PremiumPaywall
}

let db: Db
let engine: AlertEngine

beforeEach(() => {
  db = openDb(':memory:')
  engine = new AlertEngine(db, DETECTORS)
})

afterEach(() => {
  db.close()
})

describe('GET /', () => {
  it('describes the service', async () => {
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ service: 'hood-alerts', chain: 4663 })
  })
})

describe('GET /healthz', () => {
  it('reports uptime, last event time, and event counts', async () => {
    const app = buildApp({
      config: makeConfig(),
      engine,
      detectors: fakeDetectors({ lastEventAt: 1_700_000_000, eventCounts: { whale: 3 } }),
      paywall: fakePaywall(true),
      startedAt: 1_699_999_000,
    })
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.lastEventAt).toBe(new Date(1_700_000_000 * 1000).toISOString())
    expect(body.eventCounts).toEqual({ whale: 3 })
    expect(body.premiumPurchases).toBe(true)
  })

  it('reports lastEventAt as null when nothing has been ingested yet', async () => {
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/healthz')
    const body = await res.json()
    expect(body.lastEventAt).toBeNull()
  })
})

describe('GET /premium/status', () => {
  it('rejects a missing or invalid platform/chat', async () => {
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/premium/status')
    expect(res.status).toBe(400)
    const res2 = await app.request('/premium/status?platform=bogus&chat=x')
    expect(res2.status).toBe(400)
  })

  it('reports free tier for an unentitled chat', async () => {
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/premium/status?platform=telegram&chat=chat-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ platform: 'telegram', chat: 'chat-1', tier: 'free', expiresAt: null })
  })

  it('reports premium tier with an expiry for an entitled chat', async () => {
    engine.entitlements.activate('telegram', 'chat-1', 86_400)
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/premium/status?platform=telegram&chat=chat-1')
    const body = await res.json()
    expect(body.tier).toBe('premium')
    expect(body.expiresAt).not.toBeNull()
  })
})

describe('POST /premium/activate', () => {
  it('rejects a missing or invalid platform/chat', async () => {
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall: fakePaywall(false), startedAt: 0 })
    const res = await app.request('/premium/activate', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('proxies a non-200 paywall result straight through with its status', async () => {
    const paywall = fakePaywall(false, async () => ({ status: 503, body: { error: 'not configured' } }))
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall, startedAt: 0 })
    const res = await app.request('/premium/activate?platform=telegram&chat=chat-1', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('not configured')
  })

  it('proxies a 402 challenge through with its body', async () => {
    const paywall = fakePaywall(true, async () => ({ status: 402, body: { x402Version: 1, accepts: [] } }))
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall, startedAt: 0 })
    const res = await app.request('/premium/activate?platform=telegram&chat=chat-1', { method: 'POST' })
    expect(res.status).toBe(402)
  })

  it('sets the settlement header and returns 200 on success', async () => {
    const paywall = fakePaywall(true, async () => ({ status: 200, body: { activated: true }, settlementHeader: 'settlement-abc' }))
    const app = buildApp({ config: makeConfig(), engine, detectors: fakeDetectors(), paywall, startedAt: 0 })
    const res = await app.request('/premium/activate?platform=telegram&chat=chat-1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-payment-response')).toBe('settlement-abc')
    const body = await res.json()
    expect(body.activated).toBe(true)
  })
})
