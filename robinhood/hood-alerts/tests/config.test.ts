import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const ENV_KEYS = [
  'HOOD_ALERTS_RPC_URL',
  'HOOD_ALERTS_DB',
  'PORT',
  'HOOD_ALERTS_PUBLIC_URL',
  'HOOD_ALERTS_TELEGRAM_TOKEN',
  'HOOD_ALERTS_DISCORD_TOKEN',
  'HOOD_ALERTS_DISCORD_APP_ID',
  'HOOD_ALERTS_PREMIUM_RAIL',
  'HOOD402_PAY_TO',
  'HOOD402_FACILITATOR_URL',
  'HOOD402_SETTLER_KEY',
  'HOOD_ALERTS_PREMIUM_PRICE_USDG',
  'HOOD_ALERTS_PREMIUM_DAYS',
  'HOOD_ALERTS_WHALE_FLOOR_USD',
  'HOOD_ALERTS_WHALE_DEFAULT_USD',
  'HOOD_ALERTS_PRICE_WINDOW_S',
  'HOOD_ALERTS_PRICE_DEFAULT_PCT',
  'HOOD_ALERTS_PREMIUM_POLL_S',
  'HOOD_ALERTS_PREMIUM_DEFAULT_PCT',
  'HOOD_ALERTS_RUG_DEFAULT_PCT',
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('loadConfig', () => {
  it('resolves sane defaults with zero env vars set', () => {
    const config = loadConfig()
    expect(config.rpcUrl).toBeUndefined()
    expect(config.dbPath).toBe('./data/hood-alerts.db')
    expect(config.port).toBe(8080)
    expect(config.publicUrl).toBe('http://localhost:8080')
    expect(config.telegramToken).toBeNull()
    expect(config.discordToken).toBeNull()
    expect(config.premiumRail).toBe('hood402')
    expect(config.payTo).toBeNull()
    expect(config.premiumPriceUsdg).toBe('5')
    expect(config.premiumDays).toBe(30)
    expect(config.detectors).toEqual({
      whaleFloorUsd: 1000,
      whaleDefaultUsd: 5000,
      priceWindowS: 900,
      priceDefaultPct: 2,
      premiumPollS: 60,
      premiumDefaultPct: 2,
      rugDefaultPct: 30,
    })
  })

  it('derives publicUrl from a custom port when not explicitly set', () => {
    process.env.PORT = '9090'
    expect(loadConfig().publicUrl).toBe('http://localhost:9090')
  })

  it('an explicit publicUrl overrides the derived default', () => {
    process.env.HOOD_ALERTS_PUBLIC_URL = 'https://alerts.example.com'
    expect(loadConfig().publicUrl).toBe('https://alerts.example.com')
  })

  it('rejects a premium rail other than hood402', () => {
    process.env.HOOD_ALERTS_PREMIUM_RAIL = 'x402-usdc'
    expect(() => loadConfig()).toThrow(/not implemented/)
  })

  it('rejects a malformed HOOD402_PAY_TO', () => {
    process.env.HOOD402_PAY_TO = 'not-an-address'
    expect(() => loadConfig()).toThrow(/HOOD402_PAY_TO must be a 0x address/)
  })

  it('accepts a well-formed HOOD402_PAY_TO', () => {
    process.env.HOOD402_PAY_TO = '0x4022de2D36C334E73C7a108805Cea11C0564f402'
    expect(loadConfig().payTo).toBe('0x4022de2D36C334E73C7a108805Cea11C0564f402')
  })

  it('rejects a malformed HOOD402_SETTLER_KEY', () => {
    process.env.HOOD402_SETTLER_KEY = '0xdead'
    expect(() => loadConfig()).toThrow(/HOOD402_SETTLER_KEY must be a 0x-prefixed 32-byte hex private key/)
  })

  it('rejects a non-positive numeric env var', () => {
    process.env.HOOD_ALERTS_WHALE_FLOOR_USD = '-5'
    expect(() => loadConfig()).toThrow(/must be a positive number/)
    process.env.HOOD_ALERTS_WHALE_FLOOR_USD = 'not-a-number'
    expect(() => loadConfig()).toThrow(/must be a positive number/)
  })

  it('treats an empty string env var as unset (falls back to default)', () => {
    process.env.HOOD_ALERTS_DB = ''
    expect(loadConfig().dbPath).toBe('./data/hood-alerts.db')
  })

  it('reads through custom detector tuning', () => {
    process.env.HOOD_ALERTS_WHALE_FLOOR_USD = '2500'
    process.env.HOOD_ALERTS_RUG_DEFAULT_PCT = '15'
    const config = loadConfig()
    expect(config.detectors.whaleFloorUsd).toBe(2500)
    expect(config.detectors.rugDefaultPct).toBe(15)
  })
})
