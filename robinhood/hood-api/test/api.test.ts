import 'dotenv/config'
import { describe, it, expect } from 'vitest'
import { createApp } from '../src/app.js'

/**
 * Real upstream integration tests. No fixtures, no mocks: every request in
 * this file exercises `createApp()`'s in-process Hono handler against the
 * live Robinhood Chain RPC, Blockscout, DefiLlama, and CoinGecko. Assertions
 * check shapes and invariants (types, provenance, known-good addresses) since
 * live values (prices, block heights) change on every run.
 */

const app = createApp()

async function get(path: string) {
  const res = await app.request(path)
  const body = await res.json()
  return { status: res.status, body: body as Record<string, unknown> }
}

describe('free endpoints (live)', () => {
  it('GET /v1/health reports live RPC connectivity', async () => {
    const { status, body } = await get('/v1/health')
    expect(status).toBe(200)
    expect(body.chainId).toBe(4663)
    expect(body.rpcOk).toBe(true)
    expect(typeof body.blockHeight).toBe('string')
    expect(BigInt(body.blockHeight as string)).toBeGreaterThan(0n)
  })

  it('GET /v1/chain returns real chain stats with provenance', async () => {
    const { status, body } = await get('/v1/chain')
    expect(status).toBe(200)
    expect(body.chainId).toBe(4663)
    expect(BigInt(body.blockHeight as string)).toBeGreaterThan(0n)
    expect(typeof body.tvlUsd).toBe('number')
    expect(body.source).toContain('robinhood-chain-rpc')
    expect(body.source).toContain('defillama')
    expect(typeof body.asOf).toBe('string')
  })

  it('GET /v1/stocks lists the full canonical registry with live pricing', async () => {
    const { status, body } = await get('/v1/stocks')
    expect(status).toBe(200)
    expect(body.count).toBe(95)
    expect((body.pricedCount as number)).toBeGreaterThan(0)
    const stocks = body.stocks as Array<Record<string, unknown>>
    const aapl = stocks.find((s) => s.symbol === 'AAPL')
    expect(aapl).toBeDefined()
    expect(aapl!.address).toBe('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')
    expect(typeof aapl!.chainlinkPriceUsd).toBe('number')
  }, 30_000)

  it('GET /v1/stocks/TSLA returns detail with real DEX + Chainlink data', async () => {
    const { status, body } = await get('/v1/stocks/TSLA')
    expect(status).toBe(200)
    expect(body.symbol).toBe('TSLA')
    expect(body.chainlink).toBeTruthy()
    expect(body.dex).toBeTruthy()
    expect((body.dex as Record<string, unknown>).pool).toMatch(/^0x[a-fA-F0-9]{40}$/)
  }, 30_000)

  it('GET /v1/stocks/NOPE returns a structured 404', async () => {
    const { status, body } = await get('/v1/stocks/NOPE')
    expect(status).toBe(404)
    expect(body.error).toBe('unknown_symbol')
    expect(typeof body.hint).toBe('string')
    expect(typeof body.docs).toBe('string')
  })

  it('GET /v1/coins lists live launchpad activity', async () => {
    const { status, body } = await get('/v1/coins?limit=5')
    expect(status).toBe(200)
    expect(typeof body.count).toBe('number')
    expect(Array.isArray(body.coins)).toBe(true)
  }, 30_000)

  it('GET /v1/coins/{address} returns real on-chain detail for a known launch', async () => {
    // doginhood — a real NOXA launch discovered during development (see report).
    const { status, body } = await get('/v1/coins/0x955b339944CbD4834156366D766C260C80956B44')
    expect(status).toBe(200)
    expect(body.symbol).toBe('doginhood')
    expect(body.status).toBe('graduated')
    expect((body.dex as Record<string, unknown>).pool).toBeTruthy()
  }, 30_000)

  it('GET /v1/coins/not-an-address returns a structured 400', async () => {
    const { status, body } = await get('/v1/coins/not-an-address')
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_request')
    expect(typeof body.hint).toBe('string')
    expect(typeof body.docs).toBe('string')
  })

  it('GET /v1/launches returns a well-formed (possibly empty) live list', async () => {
    const { status, body } = await get('/v1/launches?lookback=24h&limit=10')
    expect(status).toBe(200)
    expect(Array.isArray(body.launches)).toBe(true)
    expect(body.source).toContain('noxa-launchpad')
  }, 30_000)
})

describe('paid endpoints (x402 gate)', () => {
  it('GET /v1/portfolio/{address} without payment returns a real 402 challenge', async () => {
    const res = await app.request('/v1/portfolio/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9')
    if (res.status === 503) {
      // payments not configured in this environment — acceptable, documented path
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('payments_not_configured')
      return
    }
    expect(res.status).toBe(402)
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>> }
    expect(Array.isArray(body.accepts)).toBe(true)
    expect(body.accepts[0]?.scheme).toBe('exact')
    expect(body.accepts[0]?.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/)
  })
})
