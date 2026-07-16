import { describe, expect, it, vi } from 'vitest'
import { TokenMetaCache } from '../src/engine/token-meta.js'
import type { HoodClient } from 'hoodchain'
import type { Address } from 'viem'

const TOKEN = '0x1234567890123456789012345678901234567890' as Address

function fakeClient(multicall: (args: unknown) => Promise<unknown>): HoodClient {
  return { public: { multicall } } as unknown as HoodClient
}

describe('TokenMetaCache', () => {
  it('returns symbol and name on a successful multicall', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: 'FOO' },
      { status: 'success', result: 'Foo Coin' },
    ])
    const cache = new TokenMetaCache(fakeClient(multicall))
    expect(await cache.get(TOKEN)).toEqual({ symbol: 'FOO', name: 'Foo Coin' })
  })

  it('caches by lowercased address and only calls multicall once', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: 'FOO' },
      { status: 'success', result: 'Foo Coin' },
    ])
    const cache = new TokenMetaCache(fakeClient(multicall))
    await cache.get(TOKEN)
    await cache.get(TOKEN.toUpperCase() as Address)
    expect(multicall).toHaveBeenCalledTimes(1)
  })

  it('returns nulls for a failed call leg without throwing', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'failure' },
      { status: 'success', result: 'Foo Coin' },
    ])
    const cache = new TokenMetaCache(fakeClient(multicall))
    expect(await cache.get(TOKEN)).toEqual({ symbol: null, name: 'Foo Coin' })
  })

  it('caches nulls when the whole multicall throws, so a broken token is not retried', async () => {
    const multicall = vi.fn().mockRejectedValue(new Error('rpc down'))
    const cache = new TokenMetaCache(fakeClient(multicall))
    expect(await cache.get(TOKEN)).toEqual({ symbol: null, name: null })
    await cache.get(TOKEN)
    expect(multicall).toHaveBeenCalledTimes(1)
  })

  it('truncates an oversized symbol/name to their max lengths', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: 'X'.repeat(50) },
      { status: 'success', result: 'Y'.repeat(100) },
    ])
    const cache = new TokenMetaCache(fakeClient(multicall))
    const meta = await cache.get(TOKEN)
    expect(meta.symbol).toHaveLength(32)
    expect(meta.name).toHaveLength(64)
  })
})
