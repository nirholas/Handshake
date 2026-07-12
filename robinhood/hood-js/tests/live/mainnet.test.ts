/**
 * Live integration tests — real reads against Robinhood Chain mainnet
 * (public RPC, no key needed) and GeckoTerminal's public API.
 * Run with `npm run test:live`.
 */
import { describe, expect, it } from 'vitest'
import hood, { HoodError } from '../../src/index.js'

// Stock feeds pause outside market hours (24/5); tolerate a long weekend.
const WEEKEND_SAFE_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'MSFT']

describe('live: hood.price', () => {
  it('returns a plausible live USD price for AAPL', async () => {
    const p = await hood.price('AAPL')
    expect(p.symbol).toBe('AAPL')
    expect(p.usd).toBeGreaterThan(20)
    expect(p.usd).toBeLessThan(5000)
    expect(p.updatedAt).toBeInstanceOf(Date)
  })

  it('rejects a symbol that is not a canonical Stock Token with a friendly error', async () => {
    const err: HoodError = await hood.price('NOTREALTICKER').catch((e) => e)
    expect(err).toBeInstanceOf(HoodError)
    expect(err.code).toBe('UNKNOWN_SYMBOL')
  })
})

describe('live: hood.prices (batched multicall)', () => {
  it('prices several Stock Tokens in one call, preserving order', async () => {
    const result = await hood.prices(WEEKEND_SAFE_SYMBOLS)
    expect(result.map((r) => r.symbol)).toEqual(WEEKEND_SAFE_SYMBOLS)
    for (const r of result) {
      expect(r.usd).not.toBeNull()
      expect(r.usd as number).toBeGreaterThan(0)
    }
  })
})

describe('live: hood.portfolio', () => {
  it('multiplier-corrects a real TSLA holder (the TSLA/WETH pool)', async () => {
    const p = await hood.portfolio('0xA953CA88ff430e9487c60cA34d757414f4efdA07')
    const tsla = p.positions.find((x) => x.symbol === 'TSLA')
    expect(tsla).toBeDefined()
    expect(tsla!.tokens).toBeGreaterThan(0)
    expect(tsla!.usd).toBeGreaterThan(0)
  })

  it('returns a clean zero-position result for an unused address', async () => {
    const p = await hood.portfolio('0x0000000000000000000000000000000000000001')
    expect(p.positions).toEqual([])
    expect(p.totalUsd).toBe(0)
  })
})

describe('live: hood.coins (GeckoTerminal onchain index)', () => {
  it('returns trending Robinhood Chain memecoins with real USD prices', async () => {
    const list = await hood.coins({ limit: 5 })
    expect(list.length).toBeGreaterThan(0)
    expect(list.length).toBeLessThanOrEqual(5)
    for (const c of list) {
      expect(c.symbol.length).toBeGreaterThan(0)
      expect(c.priceUsd).toBeGreaterThanOrEqual(0)
      expect(c.url).toContain('geckoterminal.com')
    }
  })
})

describe('live: hood.quote', () => {
  it('quotes 100 USDG → WETH through the live Uniswap v3 pools', async () => {
    const q = await hood.quote({ sell: 'USDG', buy: 'WETH', amount: 100 })
    expect(q.sell).toBe('USDG')
    expect(q.buy).toBe('WETH')
    expect(Number(q.buyAmount)).toBeGreaterThan(100 / 50_000) // ETH > $500
    expect(Number(q.buyAmount)).toBeLessThan(100 / 500) // ETH < $50,000
  })

  it('quotes a memecoin by raw address (multi-hop route)', async () => {
    // Not every trending coin has enough Uniswap v3 liquidity to fill a real
    // quote (some pair via v2/v4 pools this router can't reach, others are
    // thin) — that's real, live market state, not a bug. Try candidates until
    // one succeeds, the same thing a well-behaved caller would do.
    const candidates = await hood.coins({ limit: 10 })
    expect(candidates.length).toBeGreaterThan(0)

    let quoted: Awaited<ReturnType<typeof hood.quote>> | null = null
    for (const c of candidates) {
      try {
        quoted = await hood.quote({ sell: 'USDG', buy: c.address, amount: 10 })
        break
      } catch {
        continue
      }
    }
    expect(quoted, 'expected at least one of the top 10 trending coins to have a live route').not.toBeNull()
    expect(Number(quoted!.buyAmount)).toBeGreaterThan(0)
    expect(quoted!.route.length).toBeGreaterThanOrEqual(2)
  })
})

describe('live: hood.launches', () => {
  it('resolves an array of decoded launches (may legitimately be empty during a quiet window)', async () => {
    const list = await hood.launches({ lookbackBlocks: 30_000n })
    expect(Array.isArray(list)).toBe(true)
    for (const l of list) {
      expect(['noxa', 'odyssey']).toContain(l.launchpad)
      expect(l.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(l.url).toContain('robinhoodchain.blockscout.com')
    }
  })

  it('live stream subscribes and returns a working unwatch function', async () => {
    const seen: unknown[] = []
    const stop = hood.launches({ live: true, pollingInterval: 500 }, (l) => seen.push(l))
    expect(typeof stop).toBe('function')
    await new Promise((r) => setTimeout(r, 1500))
    stop()
  })
})
