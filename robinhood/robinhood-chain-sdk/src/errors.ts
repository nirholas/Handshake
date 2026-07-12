/**
 * Typed error hierarchy for hoodchain.
 *
 * Every error thrown by this SDK is an instance of {@link HoodchainError}, so
 * consumers can catch SDK failures with a single `instanceof` check and then
 * narrow on the specific subclass.
 */

/** Base class for every error thrown by hoodchain. */
export class HoodchainError extends Error {
  override name = 'HoodchainError'
}

/** Thrown when a symbol is not present in the Stock Token registry. */
export class UnknownSymbolError extends HoodchainError {
  override name = 'UnknownSymbolError'
  /** The symbol that failed to resolve. */
  readonly symbol: string

  constructor(symbol: string) {
    super(
      `Unknown Stock Token symbol "${symbol}". ` +
        `Symbols are case-insensitive tickers as listed on-chain (e.g. "AAPL", "TSLA"). ` +
        `Call listStockTokens() to enumerate the registry.`,
    )
    this.symbol = symbol
  }
}

/**
 * Thrown when a Stock Token exists in the registry but has no live Chainlink
 * price feed. 95 canonical Stock Tokens exist on-chain, but Chainlink's
 * public directory currently lists feeds for a subset of them.
 */
export class FeedNotFoundError extends HoodchainError {
  override name = 'FeedNotFoundError'
  readonly symbol: string

  constructor(symbol: string) {
    super(
      `Stock Token "${symbol}" has no Chainlink price feed in the registry. ` +
        `Its balance can still be read, but it cannot be priced on-chain.`,
    )
    this.symbol = symbol
  }
}

/**
 * Thrown when a Chainlink feed's `updatedAt` is older than the configured
 * `maxAgeSeconds`. Stock feeds update 24/5 (market hours), so weekend reads
 * are expected to be up to ~65h old — the default staleness window accounts
 * for this.
 */
export class StaleFeedError extends HoodchainError {
  override name = 'StaleFeedError'
  readonly symbol: string
  /** Feed timestamp, seconds since epoch. */
  readonly updatedAt: number
  /** Age of the answer in seconds at read time. */
  readonly ageSeconds: number
  /** The staleness window that was exceeded. */
  readonly maxAgeSeconds: number

  constructor(symbol: string, updatedAt: number, ageSeconds: number, maxAgeSeconds: number) {
    super(
      `Chainlink feed for "${symbol}" is stale: answer is ${ageSeconds}s old ` +
        `(updatedAt ${new Date(updatedAt * 1000).toISOString()}), ` +
        `allowed max is ${maxAgeSeconds}s. Stock feeds pause outside market hours (24/5); ` +
        `pass a larger maxAgeSeconds if weekend/holiday reads are acceptable.`,
    )
    this.symbol = symbol
    this.updatedAt = updatedAt
    this.ageSeconds = ageSeconds
    this.maxAgeSeconds = maxAgeSeconds
  }
}

/** Thrown when a Chainlink feed returns a non-positive or incomplete answer. */
export class InvalidFeedAnswerError extends HoodchainError {
  override name = 'InvalidFeedAnswerError'
  readonly symbol: string

  constructor(symbol: string, detail: string) {
    super(`Chainlink feed for "${symbol}" returned an invalid answer: ${detail}`)
    this.symbol = symbol
  }
}

/**
 * Thrown when no Uniswap v3 route with usable liquidity exists between two
 * tokens. Many Stock Token pools exist but hold zero liquidity — a quote
 * against them reverts inside the pool, which surfaces as this error.
 */
export class NoRouteError extends HoodchainError {
  override name = 'NoRouteError'
  readonly tokenIn: string
  readonly tokenOut: string

  constructor(tokenIn: string, tokenOut: string, detail?: string) {
    super(
      `No swappable Uniswap v3 route from ${tokenIn} to ${tokenOut}` +
        (detail ? `: ${detail}` : '.') +
        ` Pools may exist without liquidity; try a different intermediate or amount.`,
    )
    this.tokenIn = tokenIn
    this.tokenOut = tokenOut
  }
}

/** Thrown when a swap's quoted output falls below the slippage-adjusted minimum. */
export class SlippageExceededError extends HoodchainError {
  override name = 'SlippageExceededError'

  constructor(detail: string) {
    super(`Slippage bound exceeded: ${detail}`)
  }
}

/**
 * Thrown when an operation requires a wallet but the client was created
 * without an account.
 */
export class NoAccountError extends HoodchainError {
  override name = 'NoAccountError'

  constructor(operation: string) {
    super(
      `${operation} requires a wallet. Pass an \`account\` to createHoodClient ` +
        `(e.g. privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY)).`,
    )
  }
}

/**
 * Thrown when Stock Token acquisition is attempted without the operator
 * affirming eligibility. Stock Tokens are tokenized debt securities issued by
 * Robinhood Assets (Jersey) Ltd and may not be offered, sold, or delivered to
 * US persons (additional limits apply in Canada, the UK, and Switzerland).
 * The restriction is legal, not contract-level; this SDK ships with Stock
 * Token acquisition disabled until `acknowledgeStockTokenEligibility: true`
 * is set on the client config.
 */
export class StockTokenEligibilityError extends HoodchainError {
  override name = 'StockTokenEligibilityError'

  constructor() {
    super(
      'Refusing to build a swap that acquires a Stock Token: eligibility not acknowledged. ' +
        'Stock Tokens may not be offered, sold, or delivered to US persons ' +
        '(issuer: Robinhood Assets (Jersey) Ltd; extra limits: Canada, UK, Switzerland). ' +
        'If the operator of this software is eligible, set ' +
        '`acknowledgeStockTokenEligibility: true` in createHoodClient config.',
    )
  }
}

/** Thrown when the sequencer feed client exhausts its reconnect budget. */
export class FeedConnectionError extends HoodchainError {
  override name = 'FeedConnectionError'

  constructor(url: string, attempts: number, lastError?: string) {
    super(
      `Sequencer feed connection to ${url} failed after ${attempts} attempts` +
        (lastError ? `: ${lastError}` : '.'),
    )
  }
}
