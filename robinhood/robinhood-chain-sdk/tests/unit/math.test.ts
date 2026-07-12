import { describe, expect, it, vi } from 'vitest'
import { parseEther, parseUnits, type Address } from 'viem'
import { formatUsdg, parseUsdg } from '../../src/usdg.js'
import { getPosition, getQuote } from '../../src/stocks.js'
import { StaleFeedError, InvalidFeedAnswerError, FeedNotFoundError } from '../../src/errors.js'
import { getStockToken, listStockTokens } from '../../src/registry/index.js'
import type { HoodClient } from '../../src/client.js'

const OWNER = '0x1111111111111111111111111111111111111111' as Address

/**
 * Build a HoodClient whose public client is stubbed at the readContract /
 * multicall level — quote and multiplier math can then be asserted exactly,
 * with no network and no mocked HTTP.
 */
function stubClient(overrides: {
  latestRoundData?: readonly [bigint, bigint, bigint, bigint, bigint]
  balanceOf?: bigint
  uiMultiplier?: bigint
}): HoodClient {
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const round = overrides.latestRoundData ?? ([1n, 40782500000n, nowSec, nowSec, 1n] as const)
  const publicClient = {
    readContract: vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'latestRoundData') return round
      if (args.functionName === 'uiMultiplier') return overrides.uiMultiplier ?? 10n ** 18n
      if (args.functionName === 'balanceOf') return overrides.balanceOf ?? 0n
      throw new Error(`unexpected read ${args.functionName}`)
    }),
    multicall: vi.fn(async ({ contracts, allowFailure }: { contracts: { functionName: string }[]; allowFailure?: boolean }) =>
      contracts.map((c) => {
        const result =
          c.functionName === 'balanceOf'
            ? overrides.balanceOf ?? 0n
            : c.functionName === 'uiMultiplier'
              ? overrides.uiMultiplier ?? 10n ** 18n
              : round
        return allowFailure === false ? result : { status: 'success', result }
      }),
    ),
  }
  return {
    network: 'mainnet',
    chain: { id: 4663 },
    public: publicClient,
    wallet: null,
    account: null,
    acknowledgeStockTokenEligibility: false,
  } as unknown as HoodClient
}

describe('quote math', () => {
  it('converts the 8-decimal feed answer to a USD float', async () => {
    const client = stubClient({}) // answer 40782500000 @ 8 decimals
    const quote = await getQuote(client, 'TSLA')
    expect(quote.priceUsd).toBe(407.825)
    expect(quote.answerDecimals).toBe(8)
  })

  it('throws StaleFeedError past maxAgeSeconds and carries the ages', async () => {
    const old = BigInt(Math.floor(Date.now() / 1000) - 100_000)
    const client = stubClient({ latestRoundData: [1n, 40782500000n, old, old, 1n] })
    const err = await getQuote(client, 'TSLA', { maxAgeSeconds: 86_400 }).catch((e) => e)
    expect(err).toBeInstanceOf(StaleFeedError)
    expect(err.maxAgeSeconds).toBe(86_400)
    expect(err.ageSeconds).toBeGreaterThanOrEqual(100_000)
  })

  it('accepts the same old answer when maxAgeSeconds allows it', async () => {
    const old = BigInt(Math.floor(Date.now() / 1000) - 100_000)
    const client = stubClient({ latestRoundData: [1n, 40782500000n, old, old, 1n] })
    const quote = await getQuote(client, 'TSLA', { maxAgeSeconds: 200_000 })
    expect(quote.priceUsd).toBe(407.825)
  })

  it('rejects non-positive answers with InvalidFeedAnswerError', async () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const client = stubClient({ latestRoundData: [1n, 0n, nowSec, nowSec, 1n] })
    await expect(getQuote(client, 'TSLA')).rejects.toBeInstanceOf(InvalidFeedAnswerError)
  })

  it('throws FeedNotFoundError for registry tokens without feeds', async () => {
    const feedless = listStockTokens().find((t) => t.feed === null)
    expect(feedless, 'registry should contain at least one feedless token').toBeDefined()
    const client = stubClient({})
    await expect(getQuote(client, feedless!.symbol)).rejects.toBeInstanceOf(FeedNotFoundError)
  })
})

describe('multiplier math (the flagship correctness claim)', () => {
  it('shareEquivalent = balance × uiMultiplier ÷ 1e18, value = balance × feed price', async () => {
    // 2 tokens held; multiplier 1.05 (post-dividend); feed answer $105 per TOKEN.
    const client = stubClient({
      balanceOf: parseEther('2'),
      uiMultiplier: parseUnits('1.05', 18),
      latestRoundData: [
        1n,
        10_500_000_000n, // $105.00 @ 8 decimals — already multiplier-adjusted
        BigInt(Math.floor(Date.now() / 1000)),
        BigInt(Math.floor(Date.now() / 1000)),
        1n,
      ],
    })
    const position = await getPosition(client, OWNER, 'AAPL')
    expect(position.balanceTokens).toBe(2)
    // 2 tokens × 1.05 = 2.1 share-equivalents
    expect(position.shareEquivalent).toBeCloseTo(2.1, 12)
    // USD value must be balance × feed price (feed already multiplier-adjusted):
    // 2 × $105 = $210. A tracker that multiplies by uiMultiplier again would
    // report $220.50 — that is the bug this SDK exists to prevent.
    expect(position.valueUsd).toBeCloseTo(210, 9)
    expect(position.valueUsd).not.toBeCloseTo(220.5, 1)
  })

  it('multiplier 1.0 keeps shares == tokens', async () => {
    const client = stubClient({ balanceOf: parseEther('3'), uiMultiplier: 10n ** 18n })
    const position = await getPosition(client, OWNER, 'TSLA')
    expect(position.shareEquivalent).toBe(3)
  })

  it('registry entries expose the raw 1e18 multiplier for callers', () => {
    const tsla = getStockToken('TSLA')
    expect(BigInt(tsla.uiMultiplierAtGeneration)).toBeGreaterThan(0n)
  })
})

describe('USDG amount conversions (6 decimals)', () => {
  it('parses and formats round-trip', () => {
    expect(parseUsdg('12.5')).toBe(12_500_000n)
    expect(formatUsdg(12_500_000n)).toBe('12.5')
    expect(parseUsdg('0.000001')).toBe(1n)
    expect(formatUsdg(1n)).toBe('0.000001')
  })

  it('does NOT treat USDG as 18-decimal', () => {
    expect(parseUsdg('1')).toBe(1_000_000n)
    expect(parseUsdg('1')).not.toBe(10n ** 18n)
  })
})
