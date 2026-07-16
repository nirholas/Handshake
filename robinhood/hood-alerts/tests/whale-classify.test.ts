import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Address, Hash } from 'viem'
import { classifyCurveTrade, classifySwap } from '../src/engine/detectors/whale-classify.js'

/**
 * These run against REAL Robinhood Chain (4663) data captured by
 * `npm run capture-fixtures` (tests/fixtures/*.json). They prove the whale
 * classifiers decode genuine on-chain swaps and Odyssey curve trades, not
 * hand-written samples. Re-capture to refresh.
 */
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

interface RawSwap {
  pool: string
  amount0: string
  amount1: string
  volume0: number
  volume1: number
  recipient: string
  blockNumber: string
  transactionHash: string
}
interface PoolFixture {
  symbol: string
  token: string
  poolInfo: { pool: string; token0: string; token1: string; decimals0: number; decimals1: number }
  swaps: RawSwap[]
}

describe('classifySwap on real captured Uniswap v3 swaps', () => {
  const fx = load('swaps.json') as unknown as { weth: string; usdg: string; ethUsd: number | null; pools: PoolFixture[] }
  const quote = { weth: fx.weth as Address, usdg: fx.usdg as Address }
  const ethUsd = fx.ethUsd ?? 2000
  const allSwaps = fx.pools.flatMap((p) => p.swaps.map((s) => ({ pool: p, swap: s })))

  it('captured at least one real swap to classify', () => {
    expect(allSwaps.length).toBeGreaterThan(0)
  })

  it('classifies every real swap into a valued whale event on a quote pool', () => {
    for (const { pool, swap } of allSwaps) {
      const info = { token0: pool.poolInfo.token0 as Address, token1: pool.poolInfo.token1 as Address }
      const rehydrated = {
        amount0: BigInt(swap.amount0),
        amount1: BigInt(swap.amount1),
        volume0: swap.volume0,
        volume1: swap.volume1,
        recipient: swap.recipient as Address,
        blockNumber: BigInt(swap.blockNumber),
        transactionHash: swap.transactionHash as Hash,
      }
      // floorUsd 0 to include the (small, real) test-network swaps.
      const event = classifySwap(rehydrated, info, quote, ethUsd, 0, 1_700_000_000)
      expect(event).not.toBeNull()
      if (!event) continue
      expect(event.type).toBe('whale')
      expect(event.source).toBe('uniswap-v3')
      expect(event.usd).toBeGreaterThan(0)
      expect(['buy', 'sell']).toContain(event.side)
      // The whale event names the non-quote (base) token, not WETH/USDG.
      expect(event.token.toLowerCase()).not.toBe(fx.weth.toLowerCase())
      expect(event.token.toLowerCase()).not.toBe(fx.usdg.toLowerCase())
      expect(event.trader).toBe(swap.recipient)
    }
  })

  it('applies the whale USD floor: a high floor filters real dust swaps out', () => {
    const { pool, swap } = allSwaps[0] as { pool: PoolFixture; swap: RawSwap }
    const info = { token0: pool.poolInfo.token0 as Address, token1: pool.poolInfo.token1 as Address }
    const rehydrated = {
      amount0: BigInt(swap.amount0),
      amount1: BigInt(swap.amount1),
      volume0: swap.volume0,
      volume1: swap.volume1,
      recipient: swap.recipient as Address,
      blockNumber: BigInt(swap.blockNumber),
      transactionHash: swap.transactionHash as Hash,
    }
    expect(classifySwap(rehydrated, info, quote, ethUsd, 1_000_000_000, 1)).toBeNull()
  })

  it('returns null for a pool with no WETH/USDG quote side', () => {
    const { pool, swap } = allSwaps[0] as { pool: PoolFixture; swap: RawSwap }
    const nonQuoteInfo = { token0: '0x1111111111111111111111111111111111111111' as Address, token1: '0x2222222222222222222222222222222222222222' as Address }
    const rehydrated = {
      amount0: BigInt(swap.amount0),
      amount1: BigInt(swap.amount1),
      volume0: swap.volume0,
      volume1: swap.volume1,
      recipient: swap.recipient as Address,
      blockNumber: BigInt(swap.blockNumber),
      transactionHash: swap.transactionHash as Hash,
    }
    expect(classifySwap(rehydrated, nonQuoteInfo, quote, ethUsd, 0, 1)).toBeNull()
  })
})

describe('classifyCurveTrade on real captured Odyssey bonding-curve trades', () => {
  const fx = load('curve-trades.json') as unknown as {
    ethUsd: number | null
    trades: Array<{ token: string; trader: string; isBuy: boolean; quoteAmount: string; blockNumber: string; transactionHash: string }>
  }
  const ethUsd = fx.ethUsd ?? 2000
  const withQuote = fx.trades.filter((t) => BigInt(t.quoteAmount) > 0n)

  it('captured real Odyssey curve trades with a non-zero ETH quote', () => {
    expect(withQuote.length).toBeGreaterThan(0)
  })

  it('classifies each real curve trade into a valued whale event', () => {
    for (const t of withQuote) {
      const trade = {
        token: t.token as Address,
        trader: t.trader as Address,
        isBuy: t.isBuy,
        quoteAmount: BigInt(t.quoteAmount),
        blockNumber: BigInt(t.blockNumber),
        transactionHash: t.transactionHash as Hash,
      }
      const event = classifyCurveTrade(trade, ethUsd, 0, 1_700_000_000)
      expect(event).not.toBeNull()
      if (!event) continue
      expect(event.source).toBe('odyssey-curve')
      expect(event.token).toBe(t.token)
      expect(event.side).toBe(t.isBuy ? 'buy' : 'sell')
      // usd = ETH quote * ethUsd, so it must equal the hand computation.
      const expected = Number(trade.quoteAmount) / 1e18 * ethUsd
      expect(event.usd).toBeCloseTo(expected, 6)
    }
  })

  it('rejects trades with a non-positive ETH price and applies the floor', () => {
    const t = withQuote[0] as { token: string; trader: string; isBuy: boolean; quoteAmount: string; blockNumber: string; transactionHash: string }
    const trade = {
      token: t.token as Address,
      trader: t.trader as Address,
      isBuy: t.isBuy,
      quoteAmount: BigInt(t.quoteAmount),
      blockNumber: BigInt(t.blockNumber),
      transactionHash: t.transactionHash as Hash,
    }
    expect(classifyCurveTrade(trade, 0, 0, 1)).toBeNull()
    expect(classifyCurveTrade(trade, ethUsd, 1_000_000_000, 1)).toBeNull()
  })
})
