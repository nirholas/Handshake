import { describe, expect, it, vi } from 'vitest'
import { createHoodCache, MemoryLruStore } from '../../src/cache/index.js'
import type { HoodClient } from 'hoodchain'

// A minimal fake client — the cache module only needs `client.network` for key
// namespacing; the actual reads are monkeypatched via vi.mock below.
function fakeClient(network: 'mainnet' | 'testnet' = 'mainnet'): HoodClient {
  return { network } as unknown as HoodClient
}

describe('MemoryLruStore', () => {
  it('evicts the least-recently-used entry once maxEntries is exceeded', () => {
    const store = new MemoryLruStore(2)
    store.set('a', 1, 10_000)
    store.set('b', 2, 10_000)
    store.get('a') // touch 'a' so 'b' becomes LRU
    store.set('c', 3, 10_000) // should evict 'b'
    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBe(3)
  })

  it('expires entries past their TTL', async () => {
    const store = new MemoryLruStore()
    store.set('k', 'v', 10)
    expect(store.get('k')).toBe('v')
    await new Promise((r) => setTimeout(r, 30))
    expect(store.get('k')).toBeUndefined()
  })
})

describe('createHoodCache — request coalescing', () => {
  it('collapses 100 concurrent identical reads into exactly 1 upstream fetch', async () => {
    const client = fakeClient()
    const cache = createHoodCache(client)
    let fetchCount = 0
    const fetcher = () =>
      new Promise<{ price: number }>((resolve) => {
        fetchCount++
        setTimeout(() => resolve({ price: 123 }), 20)
      })

    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.read('quote:AAPL', fetcher, 5000)),
    )

    expect(fetchCount).toBe(1)
    expect(results).toHaveLength(100)
    for (const r of results) expect(r).toEqual({ price: 123 })
    expect(cache.stats.misses).toBe(1)
    expect(cache.stats.coalesced).toBe(99)
  })

  it('serves subsequent reads from cache within the TTL window without refetching', async () => {
    const client = fakeClient()
    const cache = createHoodCache(client)
    let fetchCount = 0
    const fetcher = async () => {
      fetchCount++
      return fetchCount
    }

    const first = await cache.read('k', fetcher, 5000)
    const second = await cache.read('k', fetcher, 5000)
    expect(first).toBe(1)
    expect(second).toBe(1) // cache hit, not refetched
    expect(fetchCount).toBe(1)
    expect(cache.stats.hits).toBe(1)
  })

  it('refetches after the entry expires', async () => {
    const client = fakeClient()
    const cache = createHoodCache(client)
    let fetchCount = 0
    const fetcher = async () => ++fetchCount

    await cache.read('k', fetcher, 10)
    await new Promise((r) => setTimeout(r, 30))
    const second = await cache.read('k', fetcher, 10)
    expect(second).toBe(2)
    expect(fetchCount).toBe(2)
  })

  it('invalidate() forces the next read to refetch', async () => {
    const client = fakeClient()
    const cache = createHoodCache(client)
    let fetchCount = 0
    const fetcher = async () => ++fetchCount

    await cache.read('k', fetcher, 60_000)
    await cache.invalidate('k')
    const second = await cache.read('k', fetcher, 60_000)
    expect(second).toBe(2)
  })

  it('each cache instance has its own store, so two clients never share entries', async () => {
    const a = createHoodCache(fakeClient('mainnet'))
    const b = createHoodCache(fakeClient('testnet'))
    let aCalls = 0
    let bCalls = 0

    await a.read('quote:AAPL', async () => {
      aCalls++
      return 'a-price'
    }, 5000)
    await b.read('quote:AAPL', async () => {
      bCalls++
      return 'b-price'
    }, 5000)

    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)
  })
})
