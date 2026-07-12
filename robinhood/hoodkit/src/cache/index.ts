import type { Address } from 'viem'
import {
  getMultiplier,
  getPortfolio,
  getQuote,
  getUsdgBalance,
  type GetQuoteOptions,
  type HoodClient,
  type Portfolio,
  type StockPosition,
  type StockQuote,
} from 'hoodchain'

/**
 * Pluggable cache backend. The default is an in-memory LRU; implement this
 * interface to back the cache with Redis, Cloudflare KV, or anything else.
 * All methods may be async so remote stores work transparently.
 *
 * @example A Redis adapter (ioredis)
 * ```ts
 * const store: CacheStore = {
 *   async get(key) { const v = await redis.get(key); return v ? JSON.parse(v) : undefined },
 *   async set(key, value, ttlMs) { await redis.set(key, JSON.stringify(value), 'PX', ttlMs) },
 *   async delete(key) { await redis.del(key) },
 * }
 * const cache = createHoodCache(hood, { store })
 * ```
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined> | T | undefined
  set<T>(key: string, value: T, ttlMs: number): Promise<void> | void
  delete(key: string): Promise<void> | void
  clear?(): Promise<void> | void
}

interface Entry {
  value: unknown
  expiresAt: number
}

/**
 * In-memory LRU {@link CacheStore} with per-entry TTL. Bounded by `maxEntries`;
 * the least-recently-used entry is evicted on overflow. Expired entries are
 * dropped lazily on read.
 */
export class MemoryLruStore implements CacheStore {
  private readonly map = new Map<string, Entry>()
  private readonly maxEntries: number

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries
  }

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    // Mark as most-recently-used.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  /** Current entry count (including not-yet-evicted expired entries). */
  get size(): number {
    return this.map.size
  }
}

/** Per-datatype TTLs in milliseconds. */
export interface CacheTtls {
  /** Chainlink quotes — fast-moving. @defaultValue `2000` */
  quote: number
  /** ERC-8056 multipliers — change only on corporate actions. @defaultValue `600_000` */
  multiplier: number
  /** Full portfolio reads. @defaultValue `5000` */
  portfolio: number
  /** USDG balances. @defaultValue `5000` */
  balance: number
  /** Registry / static metadata. @defaultValue `3_600_000` */
  registry: number
}

const DEFAULT_TTLS: CacheTtls = {
  quote: 2_000,
  multiplier: 600_000,
  portfolio: 5_000,
  balance: 5_000,
  registry: 3_600_000,
}

/** Runtime cache counters. */
export interface CacheStats {
  hits: number
  misses: number
  /** Reads that joined an already-in-flight fetch instead of issuing their own. */
  coalesced: number
}

/** Options for {@link createHoodCache}. */
export interface HoodCacheOptions {
  /** Backing store. @defaultValue a {@link MemoryLruStore} */
  store?: CacheStore
  /** Override any subset of the default per-datatype TTLs. */
  ttls?: Partial<CacheTtls>
}

/**
 * A read-through cache over the hoodchain SDK reads, with **request
 * coalescing**: N concurrent identical reads collapse into ONE upstream call,
 * and results are cached per-datatype TTL. Wrap the hot read paths (quotes,
 * portfolios) to cut RPC load by orders of magnitude under load.
 */
export interface HoodCache {
  /** Cached, coalesced {@link getQuote}. */
  getQuote(symbol: string, options?: GetQuoteOptions): Promise<StockQuote>
  /** Cached, coalesced {@link getMultiplier}. */
  getMultiplier(symbol: string): Promise<bigint | null>
  /** Cached, coalesced {@link getPortfolio}. */
  getPortfolio(owner: Address, options?: GetQuoteOptions): Promise<Portfolio>
  /** Cached, coalesced single-position read. */
  getPosition(owner: Address, symbol: string, options?: GetQuoteOptions): Promise<StockPosition>
  /** Cached, coalesced USDG balance. */
  getUsdgBalance(owner: Address): Promise<bigint>
  /**
   * Generic read-through primitive: coalesce + cache any async fetch under `key`.
   * Reuse this to cache your own chain reads with the same guarantees.
   */
  read<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T>
  /** Drop a cached key (e.g. after a write you know invalidates it). */
  invalidate(key: string): Promise<void>
  /** Clear the whole cache. */
  clear(): Promise<void>
  /** Live hit/miss/coalesce counters. */
  readonly stats: CacheStats
  /** Effective TTLs after option merge. */
  readonly ttls: CacheTtls
}

/**
 * Create a read-through, request-coalescing cache bound to a hoodchain client.
 *
 * @example
 * ```ts
 * const cache = createHoodCache(hood)
 * // 100 concurrent calls → exactly 1 RPC round-trip:
 * await Promise.all(Array.from({ length: 100 }, () => cache.getQuote('AAPL')))
 * console.log(cache.stats) // { hits: 99, misses: 1, coalesced: 99 } (approx.)
 * ```
 */
export function createHoodCache(client: HoodClient, options: HoodCacheOptions = {}): HoodCache {
  const store = options.store ?? new MemoryLruStore()
  const ttls: CacheTtls = { ...DEFAULT_TTLS, ...options.ttls }
  const inflight = new Map<string, Promise<unknown>>()
  const stats: CacheStats = { hits: 0, misses: 0, coalesced: 0 }
  const net = client.network

  async function read<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> {
    const cached = await store.get<T>(key)
    if (cached !== undefined) {
      stats.hits += 1
      return cached
    }
    const pending = inflight.get(key)
    if (pending) {
      stats.coalesced += 1
      return pending as Promise<T>
    }
    stats.misses += 1
    const promise = (async () => {
      try {
        const value = await fetcher()
        await store.set(key, value, ttlMs)
        return value
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, promise)
    return promise as Promise<T>
  }

  return {
    read,
    stats,
    ttls,
    getQuote: (symbol, opts) =>
      read(`${net}:quote:${symbol.toUpperCase()}`, () => getQuote(client, symbol, opts), ttls.quote),
    getMultiplier: (symbol) =>
      read(`${net}:mult:${symbol.toUpperCase()}`, () => getMultiplier(client, symbol), ttls.multiplier),
    getPortfolio: (owner, opts) =>
      read(`${net}:portfolio:${owner.toLowerCase()}`, () => getPortfolio(client, owner, opts), ttls.portfolio),
    getPosition: async (owner, symbol, opts) => {
      const portfolio = await read(
        `${net}:portfolio:${owner.toLowerCase()}`,
        () => getPortfolio(client, owner, opts),
        ttls.portfolio,
      )
      const found = portfolio.positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase())
      if (found) return found
      // Not held / not in the swept portfolio — fall through to a direct read.
      const { getPosition } = await import('hoodchain')
      return read(
        `${net}:position:${owner.toLowerCase()}:${symbol.toUpperCase()}`,
        () => getPosition(client, owner, symbol, opts),
        ttls.portfolio,
      )
    },
    getUsdgBalance: (owner) =>
      read(`${net}:usdg:${owner.toLowerCase()}`, () => getUsdgBalance(client, owner), ttls.balance),
    invalidate: async (key) => {
      await store.delete(key)
      inflight.delete(key)
    },
    clear: async () => {
      inflight.clear()
      if (store.clear) await store.clear()
    },
  }
}
