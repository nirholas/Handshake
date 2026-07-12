/**
 * CLI error model. Every failure carries a meaningful exit code and a
 * human-first message; `--verbose` surfaces the raw cause underneath.
 */

/** Meaningful, documented process exit codes. */
export const EXIT = {
  OK: 0,
  /** Generic runtime failure. */
  ERROR: 1,
  /** Bad usage / invalid arguments. */
  USAGE: 2,
  /** Network / RPC unreachable or timed out. */
  NETWORK: 3,
  /** A guard rail refused the action (eligibility, spend cap, unconfirmed). */
  GUARD: 4,
  /** The requested resource was not found (unknown symbol, missing tx). */
  NOT_FOUND: 5,
  /** Wallet required but not configured / wrong password. */
  WALLET: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** An error the CLI knows how to present: message + exit code + optional hint. */
export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly hint?: string
  override readonly cause?: unknown

  constructor(message: string, options: { exitCode?: ExitCode; hint?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = options.exitCode ?? EXIT.ERROR
    this.hint = options.hint
    this.cause = options.cause
  }
}

/** Convenience constructors. */
export const usageError = (m: string, hint?: string) => new CliError(m, { exitCode: EXIT.USAGE, hint })
export const guardError = (m: string, hint?: string) => new CliError(m, { exitCode: EXIT.GUARD, hint })
export const notFoundError = (m: string, hint?: string) => new CliError(m, { exitCode: EXIT.NOT_FOUND, hint })
export const walletError = (m: string, hint?: string) => new CliError(m, { exitCode: EXIT.WALLET, hint })

/**
 * Map an unknown thrown value (SDK error, viem error, network error) to a
 * CliError with a human message. Preserves the original as `cause`.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err
  const message = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''

  // hoodchain SDK errors carry a stable `name`.
  switch (name) {
    case 'UnknownSymbolError':
      return new CliError(message, { exitCode: EXIT.NOT_FOUND, cause: err, hint: 'Run `hood stocks` to list every Stock Token symbol.' })
    case 'FeedNotFoundError':
      return new CliError(message, { exitCode: EXIT.NOT_FOUND, cause: err, hint: 'This token has no Chainlink feed — try `hood token <address>` for on-chain data.' })
    case 'StaleFeedError':
      return new CliError(message, { exitCode: EXIT.ERROR, cause: err, hint: 'Stock feeds pause outside market hours (24/5). Pass --max-age to widen the window.' })
    case 'NoRouteError':
      return new CliError(message, { exitCode: EXIT.NOT_FOUND, cause: err, hint: 'No Uniswap v3 pool with liquidity connects these tokens on this network.' })
    case 'StockTokenEligibilityError':
      return new CliError('Stock Token acquisition is gated.', {
        exitCode: EXIT.GUARD,
        cause: err,
        hint: 'Stock Tokens are tokenized securities and may not be sold to US persons. Re-run with --acknowledge-eligibility if you are eligible.',
      })
    case 'NoAccountError':
      return new CliError('This action needs a wallet.', {
        exitCode: EXIT.WALLET,
        cause: err,
        hint: 'Configure one with `hood config set wallet`, or set ROBINHOOD_CHAIN_PRIVATE_KEY.',
      })
    case 'FeedConnectionError':
      return new CliError(message, { exitCode: EXIT.NETWORK, cause: err })
  }

  // viem / transport network failures.
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network|timeout/i.test(message)) {
    return new CliError('Could not reach the Robinhood Chain RPC.', {
      exitCode: EXIT.NETWORK,
      cause: err,
      hint: 'Check your connection, or set a custom RPC with `hood config set rpc <url>`.',
    })
  }

  return new CliError(message, { exitCode: EXIT.ERROR, cause: err })
}
