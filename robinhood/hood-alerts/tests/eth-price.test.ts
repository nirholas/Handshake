import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EthPrice } from '../src/engine/eth-price.js'
import { logger } from '../src/logger.js'
import type { HoodClient } from 'hoodchain'

function fakeClient(): HoodClient {
  return { public: {} } as unknown as HoodClient
}

const originalFetch = global.fetch

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => logger)
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('EthPrice', () => {
  it('returns the Blockscout coin_price on a successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ coin_price: '3123.45' }) }) as unknown as typeof fetch
    const price = new EthPrice(fakeClient())
    expect(await price.get()).toBe(3123.45)
  })

  it('caches the value within the TTL, avoiding a second fetch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ coin_price: '3000' }) })
    global.fetch = fetchSpy as unknown as typeof fetch
    const price = new EthPrice(fakeClient(), 60)
    await price.get()
    await price.get()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the cached value if the pool read also fails after a network error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ coin_price: '3000' }) }) as unknown as typeof fetch
    const price = new EthPrice(fakeClient(), 0) // TTL 0: always refetch
    expect(await price.get()).toBe(3000)

    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    // pool fallback will also throw (fakeClient has no working public.readContract), so the
    // last known cached value should be returned instead of null.
    expect(await price.get()).toBe(3000)
  })

  it('returns null when there is no cached value and both sources fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
    const price = new EthPrice(fakeClient())
    expect(await price.get()).toBeNull()
  })

  it('treats a non-numeric or non-positive coin_price as unavailable', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ coin_price: 'not-a-number' }) }) as unknown as typeof fetch
    const price = new EthPrice(fakeClient())
    expect(await price.get()).toBeNull()
  })
})
