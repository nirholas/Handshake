/**
 * A tiny in-process TTL cache with single-flight de-duplication.
 *
 * Every endpoint wraps its upstream reads in `cached(key, ttlMs, fn)`. Two
 * concurrent requests for the same key share one in-flight upstream call, so a
 * burst of traffic never fans out into a burst of RPC/HTTP calls.
 */

interface Entry<T> {
  value: T
  expiresAt: number
}

const store = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/** Milliseconds since epoch; wrapped so callers read intent, not `Date.now`. */
function now(): number {
  return Date.now()
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expiresAt > now()) return hit.value

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  const p = (async () => {
    try {
      const value = await fn()
      store.set(key, { value, expiresAt: now() + ttlMs })
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** Drop a key (or everything) — used by tests and admin refresh. */
export function invalidate(key?: string): void {
  if (key === undefined) store.clear()
  else store.delete(key)
}

/** Per-resource cache TTLs (ms). Tuned to each upstream's real update cadence. */
export const TTL = {
  health: 2_000,
  chain: 10_000, // block height moves fast but 10s is plenty for stats
  stocks: 15_000, // Chainlink feeds update on market ticks; DEX mid on swaps
  stockDetail: 15_000,
  candles: 30_000,
  coins: 20_000,
  coinDetail: 20_000,
  launches: 12_000,
  portfolio: 8_000,
  history: 60_000,
  equities: 30_000, // CoinGecko free tier friendliness
  tvl: 5 * 60_000, // DefiLlama daily series
  holders: 60_000, // Blockscout counters
} as const
