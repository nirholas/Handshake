/**
 * Live integration tests — real reads against Robinhood Chain mainnet
 * (public RPC, no key needed). Run with `npm run test:live`.
 */
import { describe, expect, it } from 'vitest'
import { parseEther, type Address } from 'viem'
import { createHoodClient } from '../../src/client.js'
import { getQuote, getMultiplier, getPortfolio } from '../../src/stocks.js'
import { getUsdgTotalSupply, formatUsdg } from '../../src/usdg.js'
import { quoteSwap } from '../../src/swap.js'
import { getRecentLaunches } from '../../src/launchpads.js'
import { subscribeFeed, type FeedMessage } from '../../src/feed.js'
import { MAINNET_ADDRESSES } from '../../src/addresses.js'
import { listPricedStockTokens } from '../../src/registry/index.js'
import { stockTokenAbi } from '../../src/abis.js'

const hood = createHoodClient()

// Stock feeds pause outside market hours (24/5); a week tolerates long weekends.
const WEEKEND_SAFE_MAX_AGE = 7 * 24 * 60 * 60

describe('live: chain identity', () => {
  it('the public RPC is chain 4663', async () => {
    expect(hood.chain.id).toBe(4663)
    expect(await hood.public.getChainId()).toBe(4663)
  })
})

describe('live: stocks', () => {
  it('quotes AAPL from its Chainlink feed at a plausible price', async () => {
    const quote = await getQuote(hood, 'AAPL', { maxAgeSeconds: WEEKEND_SAFE_MAX_AGE })
    expect(quote.priceUsd).toBeGreaterThan(50)
    expect(quote.priceUsd).toBeLessThan(2000)
    expect(quote.updatedAt).toBeGreaterThan(1_750_000_000)
  })

  it('quotes every priced registry token in one sweep', async () => {
    const priced = listPricedStockTokens()
    const results = await Promise.allSettled(
      priced.map((t) => getQuote(hood, t.symbol, { maxAgeSeconds: WEEKEND_SAFE_MAX_AGE })),
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    // every feed the registry ships must answer (staleness within a week)
    expect(ok.length).toBe(priced.length)
  })

  it('reads TSLA uiMultiplier as a 1e18-scaled value', async () => {
    const m = await getMultiplier(hood, 'TSLA')
    expect(m).not.toBeNull()
    expect(m! >= 10n ** 17n && m! < 10n ** 21n).toBe(true)
  })

  it('multiplier-correct portfolio: shareEquivalent matches on-chain balanceOfUI', async () => {
    // Use a live holder: the TSLA/WETH Uniswap pool holds TSLA.
    const holder = '0xA953CA88ff430e9487c60cA34d757414f4efdA07' as Address
    const portfolio = await getPortfolio(hood, holder, { maxAgeSeconds: WEEKEND_SAFE_MAX_AGE })
    const tsla = portfolio.positions.find((p) => p.symbol === 'TSLA')
    expect(tsla, 'pool should hold TSLA').toBeDefined()
    const onChainUI = await hood.public.readContract({
      address: tsla!.address,
      abi: stockTokenAbi,
      functionName: 'balanceOfUI',
      args: [holder],
    })
    // our js math must agree with the token's own on-chain share math
    expect(tsla!.shareEquivalent).toBeCloseTo(Number(onChainUI) / 1e18, 9)
  })
})

describe('live: usdg', () => {
  it('reads a positive USDG totalSupply (6 decimals)', async () => {
    const supply = await getUsdgTotalSupply(hood)
    expect(supply).toBeGreaterThan(0n)
    // circulating supply should be in a sane USD band (>$100k, <$100B)
    const asNumber = Number(formatUsdg(supply))
    expect(asNumber).toBeGreaterThan(100_000)
    expect(asNumber).toBeLessThan(100_000_000_000)
  })
})

describe('live: swap quoting', () => {
  it('quotes 100 USDG → WETH through the canonical QuoterV2', async () => {
    const quote = await quoteSwap(hood, {
      tokenIn: MAINNET_ADDRESSES.usdg,
      tokenOut: MAINNET_ADDRESSES.weth,
      amountIn: 100_000_000n, // 100 USDG
    })
    // 100 USDG should buy a plausible amount of ETH (price $500–$50k)
    const ethOut = Number(quote.amountOut) / 1e18
    expect(ethOut).toBeGreaterThan(100 / 50_000)
    expect(ethOut).toBeLessThan(100 / 500)
    expect(quote.route.fees.length).toBeGreaterThanOrEqual(1)
  })

  it('quotes WETH → USDG (reverse direction, sanity round-trip)', async () => {
    const quote = await quoteSwap(hood, {
      tokenIn: MAINNET_ADDRESSES.weth,
      tokenOut: MAINNET_ADDRESSES.usdg,
      amountIn: parseEther('0.01'),
    })
    const usdOut = Number(quote.amountOut) / 1e6
    expect(usdOut).toBeGreaterThan(5)
    expect(usdOut).toBeLessThan(500)
  })
})

describe('live: launchpads', () => {
  it('finds recent launches on NOXA/Odyssey', async () => {
    // ~1.5h of blocks — both launchpads are active daily; widen if flaky.
    const launches = await getRecentLaunches(hood, { lookbackBlocks: 50_000n })
    expect(Array.isArray(launches)).toBe(true)
    for (const launch of launches) {
      expect(launch.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(['noxa', 'odyssey']).toContain(launch.launchpad)
    }
  })
})

describe('live: sequencer firehose', () => {
  it('receives and decodes at least one message from the feed', async () => {
    const messages: FeedMessage[] = []
    const sub = await subscribeFeed((m) => messages.push(m))
    try {
      const deadline = Date.now() + 30_000
      while (messages.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
      }
    } finally {
      sub.close()
    }
    expect(messages.length).toBeGreaterThan(0)
    const withTxs = messages.flatMap((m) => m.transactions)
    // ~10 blocks/s on this chain: 30s of firehose virtually always carries txs
    expect(withTxs.length).toBeGreaterThan(0)
    expect(withTxs[0]!.hash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
