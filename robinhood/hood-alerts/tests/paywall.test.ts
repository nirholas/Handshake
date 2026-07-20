import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { EntitlementRepo } from '../src/db/entitlements.js'
import { PremiumPaywall } from '../src/premium/paywall.js'
import type { Config } from '../src/config.js'

const DETECTORS = {
  whaleFloorUsd: 1000,
  whaleDefaultUsd: 5000,
  priceWindowS: 900,
  priceDefaultPct: 2,
  premiumPollS: 60,
  premiumDefaultPct: 2,
  rugDefaultPct: 30,
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: undefined,
    dbPath: ':memory:',
    port: 8080,
    publicUrl: 'http://localhost:8080',
    telegramToken: null,
    discordToken: null,
    discordAppId: null,
    xMode: undefined,
    xApiKey: null,
    xApiSecret: null,
    xAccessToken: null,
    xAccessSecret: null,
    xactionsUrl: null,
    xactionsToken: null,
    xTopics: [],
    premiumRail: 'hood402',
    payTo: null,
    facilitatorUrl: null,
    settlerKey: null,
    premiumPriceUsdg: '5',
    premiumDays: 30,
    detectors: DETECTORS,
    ...overrides,
  }
}

let db: Db
let entitlements: EntitlementRepo

beforeEach(() => {
  db = openDb(':memory:')
  entitlements = new EntitlementRepo(db)
})

afterEach(() => {
  db.close()
})

describe('PremiumPaywall.enabled', () => {
  it('is disabled with no payTo configured', () => {
    const paywall = new PremiumPaywall(makeConfig(), entitlements)
    expect(paywall.enabled).toBe(false)
  })

  it('is disabled with a payTo but neither a facilitator nor a settler key', () => {
    const paywall = new PremiumPaywall(makeConfig({ payTo: '0x4022de2D36C334E73C7a108805Cea11C0564f402' }), entitlements)
    expect(paywall.enabled).toBe(false)
  })

  it('is enabled with a payTo and a facilitator URL', () => {
    const paywall = new PremiumPaywall(
      makeConfig({ payTo: '0x4022de2D36C334E73C7a108805Cea11C0564f402', facilitatorUrl: 'https://facilitator.example' }),
      entitlements,
    )
    expect(paywall.enabled).toBe(true)
  })
})

describe('PremiumPaywall.activate: unconfigured instance', () => {
  it('returns 503 with setup guidance and never touches entitlements', async () => {
    const paywall = new PremiumPaywall(makeConfig(), entitlements)
    const result = await paywall.activate('telegram', 'chat-1', undefined, 'http://localhost:8080/premium/activate')
    expect(result.status).toBe(503)
    if (result.status !== 503) throw new Error('unreachable')
    expect(result.body).toMatchObject({ error: expect.stringContaining('not configured') })
    expect(entitlements.isPremium('telegram', 'chat-1')).toBe(false)
  })
})

describe('PremiumPaywall.activate: configured instance, unpaid request', () => {
  it('returns a 402 challenge on the first (unpaid) request', async () => {
    const paywall = new PremiumPaywall(
      makeConfig({ payTo: '0x4022de2D36C334E73C7a108805Cea11C0564f402', facilitatorUrl: 'https://facilitator.example' }),
      entitlements,
    )
    const result = await paywall.activate('telegram', 'chat-1', undefined, 'http://localhost:8080/premium/activate?platform=telegram&chat=chat-1')
    expect(result.status).toBe(402)
    expect(entitlements.isPremium('telegram', 'chat-1')).toBe(false)
  })
})
