import { describe, expect, it } from 'vitest'
import { createHoodClient, listPricedStockTokens, MAINNET_EXPLORER_URL } from 'hoodchain'
import { streamPrices } from 'hoodkit'

/**
 * Live, read-only checks against Robinhood Chain mainnet (chain ID 4663).
 * Excluded from `npm test`; run explicitly with `npm run test:live`. These make
 * real network calls, so they are gated behind the live runner (longer timeout).
 */
describe('Robinhood Chain mainnet 4663 (live, read-only)', () => {
  const client = createHoodClient({})

  it('reports chain id 4663', async () => {
    const id = await client.public.getChainId()
    expect(id).toBe(4663)
  })

  it('advances a real block height', async () => {
    const a = await client.public.getBlockNumber()
    expect(a).toBeGreaterThan(0n)
  })

  it('reads a real, positive Chainlink Stock Token price', async () => {
    const symbols = listPricedStockTokens()
      .slice(0, 6)
      .map((s) => s.symbol)
    const stream = streamPrices(client, symbols)
    const price = await new Promise<number>((resolve) => {
      stream.on('data', (tick) => resolve(tick.priceUsd))
    })
    stream.close()
    expect(price).toBeGreaterThan(0)
  })

  it('reaches the Blockscout stats endpoint', async () => {
    const res = await fetch(`${MAINNET_EXPLORER_URL}/api/v2/stats`, { headers: { accept: 'application/json' } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { total_blocks?: string }
    expect(Number(body.total_blocks ?? 0)).toBeGreaterThan(0)
  })
})
