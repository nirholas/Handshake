import { describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Indexer } from '../../src/indexer/index.js'
import type { HoodClient } from 'hoodchain'

const TOKEN = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const QUOTE = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function fakeClient(): HoodClient {
  return { network: 'mainnet', chain: { id: 4663 } } as unknown as HoodClient
}

/** Build an Indexer against an in-memory db, pre-seeded with one pool, bypassing network discovery. */
function seededIndexer(): Indexer {
  const db = new BetterSqlite3(':memory:')
  const indexer = new Indexer(db, { client: fakeClient(), path: ':memory:', tokens: [TOKEN as `0x${string}`] })
  db.prepare(
    'INSERT INTO pools (pool, token, quote, token_is_0, fee, decimals0, decimals1) VALUES (?, ?, ?, 1, 500, 18, 18)',
  ).run(POOL, TOKEN, QUOTE)
  return indexer
}

describe('Indexer.holders', () => {
  it('computes net balances from mint + transfer flow, excluding the zero address', () => {
    const indexer = seededIndexer()
    const db = indexer.database
    const insert = db.prepare(
      'INSERT INTO transfers (token, block, log_index, from_addr, to_addr, value, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // Mint 1000 to alice, alice sends 300 to bob.
    insert.run(TOKEN, 1, 0, ZERO, ALICE, '1000000000000000000000', '0xa')
    insert.run(TOKEN, 2, 0, ALICE, BOB, '300000000000000000000', '0xb')

    const holders = indexer.holders(TOKEN as `0x${string}`)
    const bySymbol = new Map(holders.map((h) => [h.address.toLowerCase(), h]))
    expect(bySymbol.get(ALICE)?.balance).toBe(700_000_000_000_000_000_000n)
    expect(bySymbol.get(BOB)?.balance).toBe(300_000_000_000_000_000_000n)
    expect(bySymbol.get(ALICE)?.balanceFormatted).toBe(700)
    expect(bySymbol.get(BOB)?.balanceFormatted).toBe(300)
    // Zero address (the mint sender) must never appear as a holder.
    expect(bySymbol.has(ZERO)).toBe(false)
  })

  it('excludes holders below minBalance and sorts descending by balance', () => {
    const indexer = seededIndexer()
    const db = indexer.database
    const insert = db.prepare(
      'INSERT INTO transfers (token, block, log_index, from_addr, to_addr, value, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(TOKEN, 1, 0, ZERO, ALICE, '5', '0xa')
    insert.run(TOKEN, 2, 0, ZERO, BOB, '500', '0xb')

    const holders = indexer.holders(TOKEN as `0x${string}`, { minBalance: 100n })
    expect(holders).toHaveLength(1)
    expect(holders[0]?.address.toLowerCase()).toBe(BOB)
  })

  it('holderCount matches holders().length', () => {
    const indexer = seededIndexer()
    const db = indexer.database
    db.prepare('INSERT INTO transfers (token, block, log_index, from_addr, to_addr, value, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      TOKEN, 1, 0, ZERO, ALICE, '1', '0xa',
    )
    expect(indexer.holderCount(TOKEN as `0x${string}`)).toBe(indexer.holders(TOKEN as `0x${string}`).length)
  })
})

describe('Indexer.candles / volume24h', () => {
  function seedSwapsAndBlocks(indexer: Indexer): void {
    const db = indexer.database
    const insertBlock = db.prepare('INSERT INTO blocks (number, ts) VALUES (?, ?)')
    const insertSwap = db.prepare(
      'INSERT INTO swaps (pool, block, log_index, token_price, token_volume, buys_token, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    // Three swaps an hour apart: price 10 -> 12 -> 9, each 5 tokens of volume.
    insertBlock.run(1, 0)
    insertBlock.run(2, 3600)
    insertBlock.run(3, 7200)
    insertSwap.run(POOL, 1, 0, 10, 5, 1, '0xa')
    insertSwap.run(POOL, 2, 0, 12, 5, 0, '0xb')
    insertSwap.run(POOL, 3, 0, 9, 5, 1, '0xc')
  }

  it('builds hourly OHLCV candles from indexed swaps on the primary pool', () => {
    const indexer = seededIndexer()
    seedSwapsAndBlocks(indexer)
    const candles = indexer.candles(TOKEN as `0x${string}`, '1h')
    expect(candles).toHaveLength(3)
    expect(candles[0]).toMatchObject({ open: 10, close: 10, high: 10, low: 10 })
    expect(candles[1]).toMatchObject({ open: 12, close: 12 })
    expect(candles[2]).toMatchObject({ open: 9, close: 9 })
  })

  it('returns an empty candle series when the token has no indexed pool', () => {
    const indexer = seededIndexer()
    const other = '0x9999999999999999999999999999999999999999' as `0x${string}`
    expect(indexer.candles(other, '1h')).toEqual([])
  })

  it('sums token-denominated volume within the trailing 24h window', () => {
    const indexer = seededIndexer()
    seedSwapsAndBlocks(indexer)
    // "now" = 2 hours after the first swap: all three swaps are within 24h.
    const now = 7200 + 3600
    expect(indexer.volume24h(TOKEN as `0x${string}`, now)).toBe(15) // 5+5+5
  })

  it('excludes swaps older than 24h from the volume window', () => {
    const indexer = seededIndexer()
    const db = indexer.database
    db.prepare('INSERT INTO blocks (number, ts) VALUES (?, ?)').run(1, 0)
    db.prepare('INSERT INTO blocks (number, ts) VALUES (?, ?)').run(2, 90_000) // >24h after block 1
    db.prepare(
      'INSERT INTO swaps (pool, block, log_index, token_price, token_volume, buys_token, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(POOL, 1, 0, 10, 100, 1, '0xa')
    db.prepare(
      'INSERT INTO swaps (pool, block, log_index, token_price, token_volume, buys_token, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(POOL, 2, 0, 10, 7, 1, '0xb')

    // "now" = block 2's timestamp; block 1 (t=0) is 90_000s ago, outside 24h (86_400s).
    expect(indexer.volume24h(TOKEN as `0x${string}`, 90_000)).toBe(7)
  })

  it('primaryPool picks the pool with the most indexed swaps', () => {
    const indexer = seededIndexer()
    const pool2 = '0x4444444444444444444444444444444444444444'
    indexer.database
      .prepare('INSERT INTO pools (pool, token, quote, token_is_0, fee, decimals0, decimals1) VALUES (?, ?, ?, 1, 3000, 18, 18)')
      .run(pool2, TOKEN, QUOTE)
    seedSwapsAndBlocks(indexer) // 3 swaps on POOL, 0 on pool2
    expect(indexer.primaryPool(TOKEN as `0x${string}`)?.toLowerCase()).toBe(POOL)
  })
})

describe('Indexer.stats', () => {
  it('reports row counts across all tables', () => {
    const indexer = seededIndexer()
    const db = indexer.database
    db.prepare('INSERT INTO transfers (token, block, log_index, from_addr, to_addr, value, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      TOKEN, 1, 0, ZERO, ALICE, '1', '0xa',
    )
    const stats = indexer.stats()
    expect(stats.transfers).toBe(1)
    expect(stats.pools).toBe(1)
    expect(stats.swaps).toBe(0)
    expect(stats.blocks).toBe(0)
  })
})
