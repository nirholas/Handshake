import { formatUnits, type Address } from 'viem'
import { aggregatorV3Abi, stockTokenAbi } from './abis.js'
import type { HoodClient } from './client.js'
import { FeedNotFoundError, InvalidFeedAnswerError, StaleFeedError } from './errors.js'
import { getStockToken, listStockTokens, type StockToken } from './registry/index.js'

/**
 * Default staleness window for Chainlink stock feeds: 3 days.
 *
 * Stock feeds update 24/5, following market hours, so a Saturday read of a
 * Friday-close answer is normal and NOT stale. 72h tolerates the weekend gap;
 * pass a tighter `maxAgeSeconds` during market hours if you need fresher
 * guarantees (heartbeat is 86400s), or a looser one across long holiday
 * weekends.
 */
export const DEFAULT_MAX_FEED_AGE_SECONDS = 3 * 24 * 60 * 60

/** Options accepted by {@link getQuote}. */
export interface GetQuoteOptions {
  /**
   * Maximum acceptable feed answer age in seconds.
   * @defaultValue {@link DEFAULT_MAX_FEED_AGE_SECONDS} (72h — tolerates the 24/5 weekend gap)
   */
  maxAgeSeconds?: number
}

/** A Chainlink price quote for one Stock Token. */
export interface StockQuote {
  symbol: string
  /** Token contract address. */
  address: Address
  /** Feed proxy the answer came from. */
  feed: Address
  /**
   * Price of ONE TOKEN in USD, as a float. Chainlink's Robinhood feeds are
   * already multiplier-adjusted: this is the token's total-return price, not
   * the underlying share price. Divide by `uiMultiplier` (1e18-scaled) for
   * the underlying share price.
   */
  priceUsd: number
  /** Raw feed answer (8 decimals unless `answerDecimals` says otherwise). */
  answer: bigint
  /** Decimals of `answer`. */
  answerDecimals: number
  /** Chainlink round id. */
  roundId: bigint
  /** Feed update timestamp (seconds). */
  updatedAt: number
  /** Age of the answer in seconds at read time. */
  ageSeconds: number
}

/**
 * Read the Chainlink price for a Stock Token.
 *
 * The answer is the price of one token — Chainlink applies the ERC-8056
 * multiplier upstream, so do NOT multiply by `uiMultiplier` again.
 *
 * @throws {@link FeedNotFoundError} when the token has no feed in the registry.
 * @throws {@link StaleFeedError} when the answer is older than `maxAgeSeconds`.
 * @throws {@link InvalidFeedAnswerError} on a non-positive or incomplete answer.
 *
 * @example
 * ```ts
 * const quote = await getQuote(hood, 'AAPL')
 * console.log(`AAPL token: $${quote.priceUsd}`)
 * ```
 */
export async function getQuote(
  client: HoodClient,
  symbol: string,
  options: GetQuoteOptions = {},
): Promise<StockQuote> {
  const token = getStockToken(symbol)
  if (!token.feed) throw new FeedNotFoundError(token.symbol)

  const [roundId, answer, , updatedAtRaw] = await client.public.readContract({
    address: token.feed,
    abi: aggregatorV3Abi,
    functionName: 'latestRoundData',
  })
  return toQuote(token, { roundId, answer, updatedAt: Number(updatedAtRaw) }, options)
}

function toQuote(
  token: StockToken,
  round: { roundId: bigint; answer: bigint; updatedAt: number },
  options: GetQuoteOptions,
): StockQuote {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_FEED_AGE_SECONDS
  const answerDecimals = token.feedDecimals ?? 8
  if (round.answer <= 0n) {
    throw new InvalidFeedAnswerError(token.symbol, `answer=${round.answer}`)
  }
  if (round.updatedAt === 0) {
    throw new InvalidFeedAnswerError(token.symbol, 'round not complete (updatedAt=0)')
  }
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - round.updatedAt)
  if (ageSeconds > maxAgeSeconds) {
    throw new StaleFeedError(token.symbol, round.updatedAt, ageSeconds, maxAgeSeconds)
  }
  return {
    symbol: token.symbol,
    address: token.address,
    feed: token.feed as Address,
    priceUsd: Number(formatUnits(round.answer, answerDecimals)),
    answer: round.answer,
    answerDecimals,
    roundId: round.roundId,
    updatedAt: round.updatedAt,
    ageSeconds,
  }
}

/**
 * Read a Stock Token's ERC-8056 `uiMultiplier()`: the shares-per-token ratio,
 * scaled by 1e18. `1000000000000000000n` means 1 token = 1 share; after a
 * reinvested dividend it rises above 1e18.
 *
 * Every canonical Stock Token on chain 4663 implements the interface, so a
 * missing implementation means the address is not a canonical Stock Token —
 * in that case (`CALL` reverts / returns no data) this resolves to `null`
 * rather than throwing, as the prompt for tokens predating ERC-8056.
 */
export async function getMultiplier(client: HoodClient, symbol: string): Promise<bigint | null> {
  const token = getStockToken(symbol)
  try {
    return await client.public.readContract({
      address: token.address,
      abi: stockTokenAbi,
      functionName: 'uiMultiplier',
    })
  } catch {
    return null
  }
}

/** One holding inside a {@link Portfolio}. */
export interface StockPosition {
  symbol: string
  address: Address
  /** Raw ERC-20 token balance (18 decimals). */
  balance: bigint
  /** Token balance as a float. */
  balanceTokens: number
  /** ERC-8056 multiplier at read time (1e18-scaled). */
  uiMultiplier: bigint
  /**
   * Share-equivalent units: `balance * uiMultiplier / 1e18`. After splits or
   * reinvested dividends this diverges from `balanceTokens` — trackers that
   * show raw balances as "shares" misstate positions.
   */
  shareEquivalent: number
  /**
   * USD value: `balanceTokens * feedPrice`. The feed price is already
   * multiplier-adjusted (price per TOKEN), so the multiplier must NOT be
   * applied again here — doing so double-counts corporate actions.
   * `null` when the token has no Chainlink feed or the feed was stale.
   */
  valueUsd: number | null
  /** The quote used for valuation, or `null` if unavailable. */
  quote: StockQuote | null
}

/** Result of {@link getPortfolio}. */
export interface Portfolio {
  owner: Address
  positions: StockPosition[]
  /** Sum of `valueUsd` over positions that could be priced. */
  totalUsd: number
  /** Symbols held but not priceable (no feed / stale feed). */
  unpricedSymbols: string[]
}

/**
 * Read one Stock Token position with multiplier-correct share equivalents and
 * USD valuation. Returns `null`-valued fields rather than throwing when the
 * token cannot be priced.
 */
export async function getPosition(
  client: HoodClient,
  owner: Address,
  symbol: string,
  options: GetQuoteOptions = {},
): Promise<StockPosition> {
  const token = getStockToken(symbol)
  const [position] = await readPositions(client, owner, [token], options)
  return position as StockPosition
}

/**
 * Read every registry Stock Token balance for `owner` in one multicall sweep
 * and value the non-zero holdings.
 *
 * Correctness notes (the two mistakes generic trackers make):
 * 1. USD value is `balance × feed price` — the Robinhood Chainlink feeds are
 *    already multiplier-adjusted, so applying `uiMultiplier` to the value
 *    double-counts corporate actions.
 * 2. Share-equivalent units are `balance × uiMultiplier ÷ 1e18` — raw token
 *    balances understate positions after splits/dividends. Both numbers are
 *    exposed per position, and `shareEquivalent` is cross-checkable on-chain
 *    against the token's own `balanceOfUI()`.
 */
export async function getPortfolio(
  client: HoodClient,
  owner: Address,
  options: GetQuoteOptions = {},
): Promise<Portfolio> {
  const tokens = listStockTokens()
  const balances = await client.public.multicall({
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: stockTokenAbi,
      functionName: 'balanceOf' as const,
      args: [owner] as const,
    })),
    allowFailure: false,
  })

  const held = tokens.filter((_, i) => (balances[i] as bigint) > 0n)
  const positions = await readPositions(client, owner, held, options)

  const priced = positions.filter((p) => p.valueUsd !== null)
  return {
    owner,
    positions,
    totalUsd: priced.reduce((sum, p) => sum + (p.valueUsd as number), 0),
    unpricedSymbols: positions.filter((p) => p.valueUsd === null).map((p) => p.symbol),
  }
}

async function readPositions(
  client: HoodClient,
  owner: Address,
  tokens: StockToken[],
  options: GetQuoteOptions,
): Promise<StockPosition[]> {
  if (tokens.length === 0) return []

  const reads = await client.public.multicall({
    contracts: tokens.flatMap((t) => [
      { address: t.address, abi: stockTokenAbi, functionName: 'balanceOf' as const, args: [owner] as const },
      { address: t.address, abi: stockTokenAbi, functionName: 'uiMultiplier' as const },
    ]),
    allowFailure: false,
  })

  const feedTokens = tokens.filter((t) => t.feed !== null)
  const feedReads = await client.public.multicall({
    contracts: feedTokens.map((t) => ({
      address: t.feed as Address,
      abi: aggregatorV3Abi,
      functionName: 'latestRoundData' as const,
    })),
    allowFailure: true,
  })
  const quoteBySymbol = new Map<string, StockQuote | null>()
  feedTokens.forEach((t, i) => {
    const read = feedReads[i]
    if (!read || read.status !== 'success') {
      quoteBySymbol.set(t.symbol, null)
      return
    }
    const [roundId, answer, , updatedAt] = read.result as readonly [bigint, bigint, bigint, bigint, bigint]
    try {
      quoteBySymbol.set(t.symbol, toQuote(t, { roundId, answer, updatedAt: Number(updatedAt) }, options))
    } catch {
      quoteBySymbol.set(t.symbol, null)
    }
  })

  return tokens.map((t, i) => {
    const balance = reads[i * 2] as bigint
    const uiMultiplier = reads[i * 2 + 1] as bigint
    const balanceTokens = Number(formatUnits(balance, t.decimals))
    const quote = quoteBySymbol.get(t.symbol) ?? null
    return {
      symbol: t.symbol,
      address: t.address,
      balance,
      balanceTokens,
      uiMultiplier,
      shareEquivalent: Number(formatUnits((balance * uiMultiplier) / 10n ** 18n, t.decimals)),
      valueUsd: quote ? balanceTokens * quote.priceUsd : null,
      quote,
    }
  })
}
