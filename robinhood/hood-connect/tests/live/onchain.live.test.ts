import { describe, expect, it } from 'vitest'
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'
import { checkBootstrap, getFundingQuote, getLifiQuote, getRelayQuote, listFundingChains } from '../../src/index.js'

/**
 * LIVE verification (network required, read-only, mainnet 4663):
 * - the public RPC really serves chain 4663;
 * - the bootstrap check reads real ETH/USDG balances;
 * - LI.FI and Relay both quote real executable routes into 4663.
 * Run with `npm run test:live`. Nothing here signs or sends anything.
 */

const PROBE_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const

describe('Robinhood Chain mainnet RPC', () => {
  it('serves chain 4663 at a live block height', async () => {
    const client = createPublicClient({ chain: robinhood, transport: http() })
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()])
    expect(chainId).toBe(4663)
    expect(block).toBeGreaterThan(10_000_000n)
  })
})

describe('checkBootstrap (real reads)', () => {
  it('reads ETH and USDG balances and classifies funding', async () => {
    const status = await checkBootstrap(PROBE_ADDRESS)
    expect(status.chainId).toBe(4663)
    expect(status.eth).toBeGreaterThanOrEqual(0n)
    expect(status.usdg).toBeGreaterThanOrEqual(0n)
    expect(typeof status.funded).toBe('boolean')
    if (!status.funded) {
      expect(status.fundingOptions.map((o) => o.id)).toContain('bridge')
    } else {
      expect(status.fundingOptions).toHaveLength(0)
    }
  })
})

describe('funding routes (live quotes, never executed)', () => {
  const request = {
    fromChainId: 42161,
    fromAddress: PROBE_ADDRESS,
    amount: 2_000_000_000_000_000n,
  }

  it('LI.FI quotes Arbitrum -> Robinhood Chain', async () => {
    const quote = await getLifiQuote(request)
    expect(quote.toChainId).toBe(4663)
    expect(quote.toAmount).toBeGreaterThan(0n)
    expect(quote.tx.data.length).toBeGreaterThan(2)
  })

  it('Relay quotes Arbitrum -> Robinhood Chain', async () => {
    const quote = await getRelayQuote(request)
    expect(quote.toChainId).toBe(4663)
    expect(quote.toAmount).toBeGreaterThan(0n)
    expect(quote.tx.data.length).toBeGreaterThan(2)
  })

  it('getFundingQuote returns a route (LI.FI first)', async () => {
    const quote = await getFundingQuote(request)
    expect(['lifi', 'relay']).toContain(quote.provider)
    expect(quote.toChainId).toBe(4663)
  })

  it('lists source chains without Robinhood Chain itself', async () => {
    const chains = await listFundingChains()
    expect(chains.length).toBeGreaterThan(10)
    expect(chains.find((c) => c.id === 4663)).toBeUndefined()
    expect(chains.find((c) => c.id === 42161)).toBeDefined()
  })
})
