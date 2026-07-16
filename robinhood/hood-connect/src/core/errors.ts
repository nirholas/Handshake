/**
 * Typed errors for every failure path in the connect/add/switch flow, plus
 * helpers that normalize the wildly inconsistent error shapes injected
 * wallets produce (top-level codes, `data.originalError` nesting, `cause`
 * chains, string-only messages).
 */

/** Base class for every error hood-connect throws. */
export class HoodConnectError extends Error {
  /** EIP-1193 error code when the wallet supplied one. */
  readonly code: number | undefined

  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HoodConnectError'
    this.code = options.code
  }
}

/** No injected wallet was found (EIP-6963 silent and no `window.ethereum`). */
export class NoProviderError extends HoodConnectError {
  constructor() {
    super('No wallet provider found. Install a wallet extension (MetaMask, Rabby, Coinbase Wallet, ...) and reload.')
    this.name = 'NoProviderError'
  }
}

/** The user rejected the connection request (EIP-1193 code 4001). */
export class ConnectionRejectedError extends HoodConnectError {
  constructor(cause?: unknown) {
    super('Wallet connection was rejected in the wallet.', { code: 4001, cause })
    this.name = 'ConnectionRejectedError'
  }
}

/** `wallet_switchEthereumChain` failed (user rejection or wallet refusal). */
export class ChainSwitchRejectedError extends HoodConnectError {
  /** True when the user explicitly rejected (code 4001), false for other wallet failures. */
  readonly rejectedByUser: boolean

  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options)
    this.name = 'ChainSwitchRejectedError'
    this.rejectedByUser = options.code === 4001
  }
}

/** `wallet_addEthereumChain` failed (user rejection or wallet refusal). */
export class ChainAddRejectedError extends HoodConnectError {
  /** True when the user explicitly rejected (code 4001), false for other wallet failures. */
  readonly rejectedByUser: boolean

  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options)
    this.name = 'ChainAddRejectedError'
    this.rejectedByUser = options.code === 4001
  }
}

/** No bridge route could be quoted by LI.FI or Relay. */
export class FundingRouteError extends HoodConnectError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'FundingRouteError'
  }
}

/**
 * Extract the most specific EIP-1193 error code from a wallet error.
 * Wallets nest real codes in several places: MetaMask wraps switch errors in
 * `-32603` internal errors whose `data.originalError.code` carries the true
 * `4902`, and some wallets use `cause`.
 */
export function providerErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const err = error as { code?: unknown; data?: unknown; cause?: unknown }
  const data = err.data as { originalError?: { code?: unknown }; code?: unknown } | undefined
  const nested = data?.originalError?.code ?? data?.code
  if (typeof nested === 'number' && nested !== -32603) return nested
  if (typeof err.code === 'number' && err.code !== -32603) return err.code
  if (err.cause !== undefined && err.cause !== error) {
    const causeCode = providerErrorCode(err.cause)
    if (causeCode !== undefined) return causeCode
  }
  return typeof err.code === 'number' ? err.code : undefined
}

/** True when the error is the user pressing "cancel" in the wallet (4001). */
export function isUserRejection(error: unknown): boolean {
  return providerErrorCode(error) === 4001
}

/**
 * True when `wallet_switchEthereumChain` failed because the chain is not in
 * the wallet yet (EIP-3326 code 4902, sometimes nested, sometimes only in
 * the message text).
 */
export function isUnrecognizedChain(error: unknown): boolean {
  const code = providerErrorCode(error)
  if (code === 4902) return true
  const message = error instanceof Error ? error.message : String(error)
  return /unrecognized chain|4902|first add|wallet_addEthereumChain/i.test(message)
}

/** Human-readable message from any wallet error. */
export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}
