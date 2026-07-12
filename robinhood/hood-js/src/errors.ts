import {
  FeedConnectionError,
  FeedNotFoundError,
  HoodchainError,
  InvalidFeedAnswerError,
  NoAccountError,
  NoRouteError,
  StaleFeedError,
  StockTokenEligibilityError,
  UnknownSymbolError,
} from 'hoodchain'

/**
 * The single error type hood-js throws. Every failure — a bad symbol, a dry
 * pool, an ineligible Stock Token buy, a network blip — surfaces as a
 * `HoodError` with a plain-language `message`, a machine-readable `code`, and
 * the original error preserved on `cause` for debugging. You never see a raw
 * viem stack trace.
 *
 * @example
 * ```js
 * try {
 *   await hood.price('NOTREAL')
 * } catch (err) {
 *   if (err instanceof HoodError) console.log(err.code, err.message)
 * }
 * ```
 */
export class HoodError extends Error {
  override name = 'HoodError'
  /** Stable, machine-readable error code (see {@link HoodErrorCode}). */
  readonly code: HoodErrorCode

  constructor(message: string, code: HoodErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** The set of stable error codes {@link HoodError} can carry. */
export type HoodErrorCode =
  | 'UNKNOWN_SYMBOL'
  | 'NO_FEED'
  | 'STALE_PRICE'
  | 'BAD_PRICE'
  | 'NO_ROUTE'
  | 'NEEDS_WALLET'
  | 'NEEDS_ELIGIBILITY'
  | 'FEED_CONNECTION'
  | 'BAD_INPUT'
  | 'NETWORK'
  | 'UNKNOWN'

/** Throw a `HoodError` for an invalid argument before any network call. */
export function badInput(message: string): never {
  throw new HoodError(message, 'BAD_INPUT')
}

/**
 * Translate any thrown value into a friendly {@link HoodError}. hoodchain's
 * typed errors map to specific codes and clearer copy; everything else is
 * wrapped as `UNKNOWN` (or `NETWORK` when it smells like a transport failure)
 * with the original kept on `cause`.
 */
export function toHoodError(err: unknown): HoodError {
  if (err instanceof HoodError) return err

  if (err instanceof UnknownSymbolError) {
    return new HoodError(
      `"${err.symbol}" is not a Robinhood Chain Stock Token. Symbols are tickers like "AAPL" or "TSLA" (case-insensitive).`,
      'UNKNOWN_SYMBOL',
      { cause: err },
    )
  }
  if (err instanceof FeedNotFoundError) {
    return new HoodError(
      `"${err.symbol}" has no Chainlink price feed on Robinhood Chain, so it can't be priced. You can still read balances for it.`,
      'NO_FEED',
      { cause: err },
    )
  }
  if (err instanceof StaleFeedError) {
    return new HoodError(
      `The price for "${err.symbol}" is stale (${err.ageSeconds}s old). Stock feeds pause outside market hours; retry during a trading session or pass a looser staleness window.`,
      'STALE_PRICE',
      { cause: err },
    )
  }
  if (err instanceof InvalidFeedAnswerError) {
    return new HoodError(`The price feed returned an invalid answer. ${err.message}`, 'BAD_PRICE', {
      cause: err,
    })
  }
  if (err instanceof NoRouteError) {
    return new HoodError(
      `No swappable route with liquidity between those tokens. Many Robinhood Chain pools exist but hold no liquidity — try a different pair or amount.`,
      'NO_ROUTE',
      { cause: err },
    )
  }
  if (err instanceof StockTokenEligibilityError) {
    return new HoodError(
      'Refusing to buy a Stock Token: eligibility not acknowledged. Stock Tokens are tokenized debt securities (issuer: Robinhood Assets (Jersey) Ltd) and may not be offered, sold, or delivered to US persons (extra limits: Canada, UK, Switzerland). If you are eligible, call hood.config({ acknowledgeEligibility: true }) first.',
      'NEEDS_ELIGIBILITY',
      { cause: err },
    )
  }
  if (err instanceof NoAccountError) {
    return new HoodError(
      'This action needs a wallet. Pass one to hood.swap({ ...quote, wallet }) — a 0x private key (Node) or an injected EIP-1193 provider (browser).',
      'NEEDS_WALLET',
      { cause: err },
    )
  }
  if (err instanceof FeedConnectionError) {
    return new HoodError(`Lost the sequencer feed connection. ${err.message}`, 'FEED_CONNECTION', {
      cause: err,
    })
  }
  if (err instanceof HoodchainError) {
    return new HoodError(err.message, 'UNKNOWN', { cause: err })
  }

  const message = err instanceof Error ? err.message : String(err)
  const isNetwork = /fetch|network|timeout|ECONN|ENOTFOUND|socket|HTTP request failed/i.test(message)
  return new HoodError(
    isNetwork
      ? `Couldn't reach Robinhood Chain. Check your connection or set a custom RPC with hood.config({ rpcUrl }). (${message})`
      : message || 'An unknown error occurred.',
    isNetwork ? 'NETWORK' : 'UNKNOWN',
    { cause: err },
  )
}

/** Run `fn`, re-throwing any failure as a friendly {@link HoodError}. */
export async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toHoodError(err)
  }
}
