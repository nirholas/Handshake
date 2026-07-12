import { describe, expect, it, vi } from 'vitest'
import { Position } from '../../src/strategy/position.js'
import { SpendCap, SpendCapExceededError, createTwapExecutor } from '../../src/strategy/index.js'
import type { HoodClient } from 'hoodchain'

describe('Position — weighted-average-cost PnL', () => {
  it('tracks average cost across multiple buys', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    p.record({ side: 'buy', quantity: 10, price: 200 })
    expect(p.quantity).toBe(20)
    expect(p.averageCost).toBe(150) // (10*100 + 10*200) / 20
  })

  it('banks realized PnL on sell at average cost basis', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    p.record({ side: 'sell', quantity: 5, price: 150 })
    expect(p.realized).toBe(250) // (150-100)*5
    expect(p.quantity).toBe(5)
    expect(p.averageCost).toBe(100) // unchanged by sells
  })

  it('computes unrealized PnL at a mark price', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    expect(p.unrealized(120)).toBe(200) // (120-100)*10
    expect(p.unrealized(80)).toBe(-200)
  })

  it('subtracts fees from realized PnL', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    p.record({ side: 'sell', quantity: 10, price: 110, fee: 5 })
    expect(p.realized).toBe(95) // (110-100)*10 - 5
  })

  it('adds buy fees into average cost', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100, fee: 50 })
    expect(p.averageCost).toBe(105) // (1000 + 50) / 10
  })

  it('resets quantity and average cost to zero once fully sold', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    p.record({ side: 'sell', quantity: 10, price: 120 })
    expect(p.quantity).toBe(0)
    expect(p.averageCost).toBe(0)
  })

  it('reports multiplier-aware share equivalents', () => {
    const p = new Position({ multiplier: 2n * 10n ** 18n }) // 2 shares per token (post-split-adjusted)
    p.record({ side: 'buy', quantity: 10, price: 100 })
    expect(p.shareEquivalent).toBe(20)
  })

  it('snapshot() bundles realized + unrealized into total', () => {
    const p = new Position()
    p.record({ side: 'buy', quantity: 10, price: 100 })
    p.record({ side: 'sell', quantity: 4, price: 150 })
    const snap = p.snapshot(120)
    expect(snap.realized).toBe(200) // (150-100)*4
    expect(snap.unrealized).toBe(120) // (120-100)*6 remaining
    expect(snap.total).toBe(320)
    expect(snap.quantity).toBe(6)
  })

  it('throws on non-positive fill quantity', () => {
    const p = new Position()
    expect(() => p.record({ side: 'buy', quantity: 0, price: 100 })).toThrow()
    expect(() => p.record({ side: 'buy', quantity: -1, price: 100 })).toThrow()
  })
})

describe('SpendCap', () => {
  it('allows spends within the cap and tracks remaining headroom', () => {
    const cap = new SpendCap(100n)
    expect(cap.canSpend(60n)).toBe(true)
    cap.spend(60n)
    expect(cap.spent).toBe(60n)
    expect(cap.remaining).toBe(40n)
  })

  it('throws SpendCapExceededError once the cap would be breached', () => {
    const cap = new SpendCap(100n)
    cap.spend(90n)
    expect(() => cap.spend(20n)).toThrow(SpendCapExceededError)
    expect(cap.spent).toBe(90n) // failed spend does not partially apply
  })

  it('canSpend() never mutates state', () => {
    const cap = new SpendCap(50n)
    expect(cap.canSpend(1000n)).toBe(false)
    expect(cap.spent).toBe(0n)
  })
})

describe('createTwapExecutor', () => {
  const tokenIn = '0x1111111111111111111111111111111111111111' as `0x${string}`
  const tokenOut = '0x2222222222222222222222222222222222222222' as `0x${string}`

  function fakeReadOnlyClient(): HoodClient {
    return {
      network: 'testnet',
      wallet: null,
      account: null,
      chain: { id: 46630 },
      public: {
        call: vi.fn(async () => ({ data: '0x' })),
      },
    } as unknown as HoodClient
  }

  it('splits totalAmountIn into equal slices with the remainder on the last one', () => {
    const client = fakeReadOnlyClient()
    const twap = createTwapExecutor(client, { tokenIn, tokenOut, totalAmountIn: 1003n, slices: 4, intervalMs: 0 })
    const plan = twap.plan()
    expect(plan).toHaveLength(4)
    expect(plan.map((s) => s.amountIn)).toEqual([250n, 250n, 250n, 253n])
    expect(plan.reduce((sum, s) => sum + s.amountIn, 0n)).toBe(1003n)
  })

  it('defaults to dry-run (simulated, never sent) when the client has no wallet', async () => {
    vi.doMock('hoodchain', async () => {
      const actual = await vi.importActual<typeof import('hoodchain')>('hoodchain')
      return {
        ...actual,
        quoteSwap: vi.fn(async (_client: unknown, args: { amountIn: bigint }) => ({
          route: { fees: [500], path: [tokenIn, tokenOut], encodedPath: '0x' },
          amountIn: args.amountIn,
          amountOut: args.amountIn * 2n,
          gasEstimate: 100_000n,
        })),
        buildSwapTx: vi.fn(() => ({
          to: tokenOut,
          data: '0xdead',
          value: 0n,
          quote: {},
          amountOutMinimum: 1n,
          deadline: 0n,
        })),
      }
    })
    const { createTwapExecutor: freshTwap } = await import('../../src/strategy/index.js')
    const client = fakeReadOnlyClient()
    const twap = freshTwap(client, { tokenIn, tokenOut, totalAmountIn: 400n, slices: 2, intervalMs: 0 })
    const results = await twap.run()
    expect(results).toHaveLength(2)
    for (const r of results) expect(r.status).toBe('simulated')
    expect((client.public.call as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    vi.doUnmock('hoodchain')
  })

  it('skips a slice when onBeforeSlice returns false', async () => {
    const client = fakeReadOnlyClient()
    const twap = createTwapExecutor(client, {
      tokenIn,
      tokenOut,
      totalAmountIn: 400n,
      slices: 2,
      intervalMs: 0,
      onBeforeSlice: (s) => s.index !== 0,
    })
    const results = await twap.run()
    expect(results[0]?.status).toBe('skipped')
  })

  it('respects an AbortSignal kill switch between slices', async () => {
    const client = fakeReadOnlyClient()
    const controller = new AbortController()
    const twap = createTwapExecutor(client, {
      tokenIn,
      tokenOut,
      totalAmountIn: 900n,
      slices: 3,
      intervalMs: 10,
      signal: controller.signal,
      onSlice: () => controller.abort(),
    })
    const results = await twap.run()
    expect(results.length).toBeLessThan(3)
  })

  it('enforces the spend cap by skipping slices once exhausted', async () => {
    const client = fakeReadOnlyClient()
    const spendCap = new SpendCap(100n) // less than a single slice
    const twap = createTwapExecutor(client, {
      tokenIn,
      tokenOut,
      totalAmountIn: 400n,
      slices: 2,
      intervalMs: 0,
      spendCap,
    })
    const results = await twap.run()
    expect(results.every((r) => r.status === 'skipped')).toBe(true)
  })
})
