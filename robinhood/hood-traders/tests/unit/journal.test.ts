import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from '../../src/framework/journal.js'
import type { TradeRecord } from '../../src/framework/types.js'

const TOKEN = '0x1111111111111111111111111111111111111a' as const
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const

function trade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    agentId: 'agent-1',
    mode: 'paper',
    ts: 1_000,
    side: 'buy',
    token: TOKEN,
    tokenSymbol: 'MEME',
    quoteToken: USDG,
    quoteSymbol: 'USDG',
    // A value that overflows a 64-bit SIGNED integer (> 9.2e18) — the whole
    // reason bigints are stored as TEXT, not SQLite INTEGER.
    amountIn: 20_000_000_000_000_000_000n,
    amountOut: 5_000_000_000_000_000_000n,
    txHash: null,
    reason: 'test buy',
    slippageBps: 50,
    gasEstimate: 21_000n,
    meta: { note: 'unit test' },
    ...overrides,
  }
}

describe('Journal', () => {
  let journal: Journal

  afterEach(() => {
    journal?.close()
  })

  it('round-trips a trade losslessly, including bigints beyond 64-bit signed range', () => {
    journal = new Journal(':memory:')
    journal.recordTrade(trade())
    const [row] = journal.recentTrades('agent-1', 1)
    expect(row.amountIn).toBe(20_000_000_000_000_000_000n)
    expect(row.amountOut).toBe(5_000_000_000_000_000_000n)
    expect(row.meta).toEqual({ note: 'unit test' })
  })

  it('preserves a null txHash (paper mode) vs a real hash (live mode)', () => {
    journal = new Journal(':memory:')
    journal.recordTrade(trade({ txHash: null }))
    journal.recordTrade(trade({ mode: 'live', txHash: '0xabc123' as `0x${string}`, ts: 2_000 }))
    const rows = journal.recentTrades('agent-1', 2)
    const paperRow = rows.find((r) => r.mode === 'paper')
    const liveRow = rows.find((r) => r.mode === 'live')
    expect(paperRow?.txHash).toBeNull()
    expect(liveRow?.txHash).toBe('0xabc123')
  })

  it('orders recentTrades newest-first', () => {
    journal = new Journal(':memory:')
    journal.recordTrade(trade({ ts: 1_000 }))
    journal.recordTrade(trade({ ts: 3_000 }))
    journal.recordTrade(trade({ ts: 2_000 }))
    const rows = journal.recentTrades('agent-1', 10)
    expect(rows.map((r) => r.ts)).toEqual([3_000, 2_000, 1_000])
  })

  it('isolates trades by agentId', () => {
    journal = new Journal(':memory:')
    journal.recordTrade(trade({ agentId: 'agent-1' }))
    journal.recordTrade(trade({ agentId: 'agent-2' }))
    expect(journal.recentTrades('agent-1', 10)).toHaveLength(1)
    expect(journal.recentTrades('agent-2', 10)).toHaveLength(1)
  })

  it('spentSince sums only buy-side USDG trades at/after the boundary', () => {
    journal = new Journal(':memory:')
    // 10 USDG (6dp) before the boundary — must be excluded
    journal.recordTrade(trade({ ts: 500, amountIn: 10_000_000n }))
    // 25 USDG at/after the boundary — included
    journal.recordTrade(trade({ ts: 1_000, amountIn: 25_000_000n }))
    // a sell — must be excluded regardless of ts
    journal.recordTrade(trade({ ts: 1_500, side: 'sell', amountIn: 1_000_000_000n }))
    // a different quote symbol — must be excluded
    journal.recordTrade(trade({ ts: 1_500, quoteSymbol: 'WETH', amountIn: 999_000_000n }))
    expect(journal.spentSince('agent-1', 1_000)).toBeCloseTo(25, 6)
  })

  it('recordDecision + recentDecisions round-trips kind/detail/meta', () => {
    journal = new Journal(':memory:')
    journal.recordDecision({ agentId: 'agent-1', ts: 1, kind: 'refused', detail: 'cap breach', meta: { reason: 'daily_cap' } })
    const [row] = journal.recentDecisions('agent-1', 1)
    expect(row.kind).toBe('refused')
    expect(row.detail).toBe('cap breach')
    expect(row.meta).toEqual({ reason: 'daily_cap' })
  })

  it('equityCurve returns points in ascending time order', () => {
    journal = new Journal(':memory:')
    journal.recordEquity({ agentId: 'agent-1', ts: 300, realizedUsd: 3, openValueUsd: 0, equityUsd: 3 })
    journal.recordEquity({ agentId: 'agent-1', ts: 100, realizedUsd: 1, openValueUsd: 0, equityUsd: 1 })
    journal.recordEquity({ agentId: 'agent-1', ts: 200, realizedUsd: 2, openValueUsd: 0, equityUsd: 2 })
    const curve = journal.equityCurve('agent-1', 10)
    expect(curve.map((p) => p.ts)).toEqual([100, 200, 300])
  })

  it('allRecentTrades spans every agent', () => {
    journal = new Journal(':memory:')
    journal.recordTrade(trade({ agentId: 'agent-1', ts: 1 }))
    journal.recordTrade(trade({ agentId: 'agent-2', ts: 2 }))
    expect(journal.allRecentTrades(10)).toHaveLength(2)
  })
})
