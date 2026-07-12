import { getAddress, type Address } from 'viem'
import { getStockTokenByAddress, type HoodClient } from 'hoodchain'
import { discoverPools, loadPoolInfo, decodeSwapLog, uniswapV3SwapEvent, type PoolInfo } from '../stream/uniswap.js'
import { buildCandles, fillGaps, INTERVAL_SECONDS, type Candle, type Interval } from './candles.js'

export { buildCandles, fillGaps, INTERVAL_SECONDS } from './candles.js'
export type { Candle, Interval, TradePoint } from './candles.js'

// Type-only import — erased at compile time, so better-sqlite3 stays an
// OPTIONAL peer dependency and is loaded lazily via dynamic import below.
import type BetterSqlite3 from 'better-sqlite3'
type Database = BetterSqlite3.Database

const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pools (
  pool TEXT PRIMARY KEY, token TEXT NOT NULL, quote TEXT NOT NULL,
  token_is_0 INTEGER NOT NULL, fee INTEGER NOT NULL,
  decimals0 INTEGER NOT NULL, decimals1 INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transfers (
  token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, value TEXT NOT NULL, tx_hash TEXT NOT NULL,
  PRIMARY KEY (token, block, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_token ON transfers (token);
CREATE TABLE IF NOT EXISTS swaps (
  pool TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  token_price REAL NOT NULL, token_volume REAL NOT NULL, buys_token INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  PRIMARY KEY (pool, block, log_index)
);
CREATE INDEX IF NOT EXISTS swaps_pool ON swaps (pool);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, from_block INTEGER NOT NULL);
`

/** Options for {@link createIndexer}. */
export interface IndexerOptions {
  client: HoodClient
  /** SQLite file path. Use `':memory:'` for an ephemeral in-process db. */
  path: string
  /** Stock Token (or any ERC-20) addresses to index. */
  tokens: Address[]
  /** Max blocks per `eth_getLogs`. @defaultValue `5000n` */
  chunkSize?: bigint
  /** Concurrent `getBlock` timestamp fetches. @defaultValue `8` */
  timestampConcurrency?: number
}

/** Progress callback payload during {@link Indexer.sync}. */
export interface SyncProgress {
  kind: 'transfers' | 'swaps' | 'timestamps'
  target: Address
  fromBlock: bigint
  toBlock: bigint
  head: bigint
  inserted: number
}

/** Result of a {@link Indexer.sync} run. */
export interface SyncResult {
  head: bigint
  transfersIndexed: number
  swapsIndexed: number
  timestampsFetched: number
}

/** A token holder derived from indexed transfers. */
export interface Holder {
  address: Address
  /** Net balance in raw token units (18-decimal Stock Tokens: divide by 1e18). */
  balance: bigint
  /** Net balance in human units. */
  balanceFormatted: number
}

/**
 * A local, incremental SQLite indexer for Robinhood Chain. Syncs `Transfer` and
 * Uniswap v3 `Swap` events for a token set, resumes from the last synced block,
 * and answers holder / OHLCV / volume queries from local data with no RPC.
 *
 * Requires the optional `better-sqlite3` peer dependency; construct via
 * {@link createIndexer}.
 */
export class Indexer {
  private readonly client: HoodClient
  private readonly db: Database
  private readonly tokens: Address[]
  private readonly chunkSize: bigint
  private readonly timestampConcurrency: number
  private poolsByToken = new Map<string, PoolInfo[]>()

  /** @internal Use {@link createIndexer}. */
  constructor(db: Database, options: IndexerOptions) {
    this.client = options.client
    this.db = db
    this.tokens = options.tokens.map((t) => getAddress(t))
    this.chunkSize = options.chunkSize ?? 5000n
    this.timestampConcurrency = options.timestampConcurrency ?? 8
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('chainId', String(this.client.chain.id))
  }

  /** Discover and persist the Uniswap v3 pools for each indexed token. Called by {@link createIndexer}. */
  async init(): Promise<void> {
    const insertPool = this.db.prepare(
      'INSERT OR IGNORE INTO pools (pool, token, quote, token_is_0, fee, decimals0, decimals1) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const token of this.tokens) {
      const stored = this.db.prepare('SELECT pool, token, quote, token_is_0, fee, decimals0, decimals1 FROM pools WHERE token = ?').all(token) as Array<{
        pool: string; quote: string; token_is_0: number; fee: number; decimals0: number; decimals1: number
      }>
      let pools: PoolInfo[]
      if (stored.length > 0) {
        pools = await Promise.all(stored.map((r) => loadPoolInfo(this.client, r.pool as Address)))
      } else {
        pools = await discoverPools(this.client, token)
        for (const p of pools) {
          const tokenIs0 = p.token0.toLowerCase() === token.toLowerCase()
          insertPool.run(p.pool, token, tokenIs0 ? p.token1 : p.token0, tokenIs0 ? 1 : 0, p.fee, p.decimals0, p.decimals1)
        }
      }
      this.poolsByToken.set(token.toLowerCase(), pools)
    }
  }

  private getCursor(key: string, fallback: bigint): bigint {
    const row = this.db.prepare('SELECT from_block FROM sync_state WHERE key = ?').get(key) as { from_block: number } | undefined
    return row ? BigInt(row.from_block) : fallback
  }

  private setCursor(key: string, block: bigint): void {
    this.db.prepare('INSERT OR REPLACE INTO sync_state (key, from_block) VALUES (?, ?)').run(key, Number(block))
  }

  /**
   * Sync all tokens from their last synced block to the head (incremental).
   * Pass `fromBlock` on the first run to backfill history — required for
   * holder counts to match the full-history on-chain state.
   */
  async sync(options: { fromBlock?: bigint; toBlock?: bigint; onProgress?: (p: SyncProgress) => void } = {}): Promise<SyncResult> {
    const head = options.toBlock ?? (await this.client.public.getBlockNumber())
    let transfersIndexed = 0
    let swapsIndexed = 0
    const swapBlocks = new Set<bigint>()

    const insertTransfer = this.db.prepare(
      'INSERT OR IGNORE INTO transfers (token, block, log_index, from_addr, to_addr, value, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertSwap = this.db.prepare(
      'INSERT OR IGNORE INTO swaps (pool, block, log_index, token_price, token_volume, buys_token, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )

    for (const token of this.tokens) {
      // --- Transfers ---
      const tKey = `transfer:${token.toLowerCase()}`
      let from = options.fromBlock ?? this.getCursor(tKey, head)
      for (let start = from; start <= head; start += this.chunkSize) {
        const to = start + this.chunkSize - 1n > head ? head : start + this.chunkSize - 1n
        const logs = await this.client.public.getLogs({ address: token, event: TRANSFER_EVENT, fromBlock: start, toBlock: to })
        const tx = this.db.transaction((rows: typeof logs) => {
          for (const log of rows) {
            const a = log.args as { from?: Address; to?: Address; value?: bigint }
            if (!a.from || !a.to || a.value === undefined) continue
            insertTransfer.run(token, Number(log.blockNumber), log.logIndex, a.from.toLowerCase(), a.to.toLowerCase(), a.value.toString(), log.transactionHash)
            transfersIndexed += 1
          }
        })
        tx(logs)
        this.setCursor(tKey, to + 1n)
        options.onProgress?.({ kind: 'transfers', target: token, fromBlock: start, toBlock: to, head, inserted: logs.length })
      }

      // --- Swaps (per pool) ---
      for (const pool of this.poolsByToken.get(token.toLowerCase()) ?? []) {
        const tokenIs0 = pool.token0.toLowerCase() === token.toLowerCase()
        const sKey = `swap:${pool.pool.toLowerCase()}`
        from = options.fromBlock ?? this.getCursor(sKey, head)
        for (let start = from; start <= head; start += this.chunkSize) {
          const to = start + this.chunkSize - 1n > head ? head : start + this.chunkSize - 1n
          const logs = await this.client.public.getLogs({ address: pool.pool, event: uniswapV3SwapEvent, fromBlock: start, toBlock: to })
          const tx = this.db.transaction((rows: typeof logs) => {
            for (const log of rows) {
              const swap = decodeSwapLog(log, pool)
              if (!swap) continue
              const tokenPrice = tokenIs0 ? swap.price : swap.price > 0 ? 1 / swap.price : 0
              const tokenVolume = tokenIs0 ? swap.volume0 : swap.volume1
              const buysToken = tokenIs0 ? swap.buysToken0 : !swap.buysToken0
              insertSwap.run(pool.pool, Number(swap.blockNumber), swap.logIndex, tokenPrice, tokenVolume, buysToken ? 1 : 0, swap.transactionHash)
              swapBlocks.add(swap.blockNumber)
              swapsIndexed += 1
            }
          })
          tx(logs)
          this.setCursor(sKey, to + 1n)
          options.onProgress?.({ kind: 'swaps', target: pool.pool, fromBlock: start, toBlock: to, head, inserted: logs.length })
        }
      }
    }

    const timestampsFetched = await this.fetchTimestamps([...swapBlocks], options.onProgress)
    return { head, transfersIndexed, swapsIndexed, timestampsFetched }
  }

  /** Fetch and cache timestamps for blocks we don't already have. */
  private async fetchTimestamps(blocks: bigint[], onProgress?: (p: SyncProgress) => void): Promise<number> {
    const missing = blocks.filter((b) => !(this.db.prepare('SELECT 1 FROM blocks WHERE number = ?').get(Number(b))))
    if (missing.length === 0) return 0
    const insert = this.db.prepare('INSERT OR REPLACE INTO blocks (number, ts) VALUES (?, ?)')
    let fetched = 0
    for (let i = 0; i < missing.length; i += this.timestampConcurrency) {
      const slice = missing.slice(i, i + this.timestampConcurrency)
      const results = await Promise.all(slice.map((b) => this.client.public.getBlock({ blockNumber: b })))
      const tx = this.db.transaction(() => {
        results.forEach((block, j) => {
          insert.run(Number(slice[j]), Number(block.timestamp))
          fetched += 1
        })
      })
      tx()
    }
    if (onProgress && missing.length > 0) {
      onProgress({ kind: 'timestamps', target: getAddress('0x0000000000000000000000000000000000000000'), fromBlock: 0n, toBlock: 0n, head: 0n, inserted: fetched })
    }
    return fetched
  }

  /**
   * Current holders of `token`, computed as net (inbound − outbound) transfer
   * flow per address. Accurate against the on-chain holder set only when the
   * token was synced from its first transfer (`sync({ fromBlock: 0n })`).
   * The zero address is excluded.
   */
  holders(token: Address, options: { minBalance?: bigint } = {}): Holder[] {
    const t = getAddress(token)
    const minBalance = options.minBalance ?? 1n
    const decimals = getStockTokenByAddress(t)?.decimals ?? 18
    const rows = this.db
      .prepare(
        `SELECT DISTINCT addr FROM (
           SELECT to_addr AS addr FROM transfers WHERE token = ?
           UNION SELECT from_addr AS addr FROM transfers WHERE token = ?
         )`,
      )
      .all(t, t) as Array<{ addr: string }>

    const holders: Holder[] = []
    const divisor = 10 ** decimals
    for (const row of rows) {
      if (row.addr === '0x0000000000000000000000000000000000000000') continue
      // Net balance recomputed exactly in JS bigints (SQLite SUM would lose
      // precision on 18-decimal token values).
      const balance = this.exactBalance(t, row.addr)
      if (balance >= minBalance) {
        holders.push({ address: getAddress(row.addr as Address), balance, balanceFormatted: Number(balance) / divisor })
      }
    }
    return holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
  }

  private exactBalance(token: Address, address: string): bigint {
    const inbound = this.db.prepare('SELECT value FROM transfers WHERE token = ? AND to_addr = ?').all(token, address) as Array<{ value: string }>
    const outbound = this.db.prepare('SELECT value FROM transfers WHERE token = ? AND from_addr = ?').all(token, address) as Array<{ value: string }>
    let bal = 0n
    for (const r of inbound) bal += BigInt(r.value)
    for (const r of outbound) bal -= BigInt(r.value)
    return bal
  }

  /** Number of holders with a positive balance (see {@link Indexer.holders} accuracy note). */
  holderCount(token: Address): number {
    return this.holders(token).length
  }

  /** The most-traded indexed pool for `token`, or `null` if none indexed. */
  primaryPool(token: Address): Address | null {
    const t = getAddress(token)
    const row = this.db
      .prepare(
        `SELECT p.pool AS pool, COUNT(s.pool) AS n FROM pools p
         LEFT JOIN swaps s ON s.pool = p.pool WHERE p.token = ? GROUP BY p.pool ORDER BY n DESC LIMIT 1`,
      )
      .get(t) as { pool: string; n: number } | undefined
    return row ? getAddress(row.pool as Address) : null
  }

  /**
   * OHLCV candles for `token` at `interval`, built from indexed swaps on its
   * primary pool (or `options.pool`). Prices are token-denominated in the
   * pool's quote asset. Sparse by default; pass `fill: true` to forward-fill gaps.
   */
  candles(token: Address, interval: Interval, options: { pool?: Address; fill?: boolean } = {}): Candle[] {
    const pool = options.pool ? getAddress(options.pool) : this.primaryPool(token)
    if (!pool) return []
    const rows = this.db
      .prepare(
        `SELECT b.ts AS ts, s.token_price AS price, s.token_volume AS volume
         FROM swaps s JOIN blocks b ON b.number = s.block
         WHERE s.pool = ? ORDER BY s.block, s.log_index`,
      )
      .all(pool) as Array<{ ts: number; price: number; volume: number }>
    const candles = buildCandles(rows, INTERVAL_SECONDS[interval])
    return options.fill ? fillGaps(candles, INTERVAL_SECONDS[interval]) : candles
  }

  /**
   * Rolling 24-hour token-denominated swap volume across all indexed pools of
   * `token`. Uses cached block timestamps; `now` overridable for testing.
   */
  volume24h(token: Address, now = Math.floor(Date.now() / 1000)): number {
    const t = getAddress(token)
    const cutoff = now - 86_400
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.token_volume), 0) AS vol
         FROM swaps s
         JOIN pools p ON p.pool = s.pool
         JOIN blocks b ON b.number = s.block
         WHERE p.token = ? AND b.ts >= ?`,
      )
      .get(t, cutoff) as { vol: number }
    return row.vol
  }

  /** Row counts for a quick health check. */
  stats(): { transfers: number; swaps: number; blocks: number; pools: number } {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return { transfers: count('transfers'), swaps: count('swaps'), blocks: count('blocks'), pools: count('pools') }
  }

  /** Underlying better-sqlite3 handle for advanced queries. */
  get database(): Database {
    return this.db
  }

  /** Close the database. */
  close(): void {
    this.db.close()
  }
}

/**
 * Open (or create) a SQLite-backed {@link Indexer} and discover each token's
 * pools. Requires the optional `better-sqlite3` peer dependency.
 *
 * @example
 * ```ts
 * const indexer = await createIndexer({ client: hood, path: './hood.sqlite', tokens: ['0x…'] })
 * await indexer.sync({ fromBlock: 0n })            // full backfill on first run
 * console.log(indexer.holderCount('0x…'))
 * console.log(indexer.candles('0x…', '1h'))
 * ```
 */
export async function createIndexer(options: IndexerOptions): Promise<Indexer> {
  let Ctor: new (path: string) => Database
  try {
    const mod = (await import('better-sqlite3')) as unknown as { default: new (path: string) => Database }
    Ctor = mod.default
  } catch {
    throw new Error(
      'hoodkit indexer requires the optional peer dependency "better-sqlite3". Install it with: npm i better-sqlite3',
    )
  }
  const db = new Ctor(options.path)
  const indexer = new Indexer(db, options)
  await indexer.init()
  return indexer
}
