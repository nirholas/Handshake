import type { Address, Hex } from 'viem'
import type { InvalidReason } from './errors.js'

/** The only x402 protocol version hood402 speaks on the wire (v1, X-PAYMENT). */
export const X402_VERSION = 1 as const

/** The only scheme hood402 implements. */
export const SCHEME = 'exact' as const

/**
 * A single payment requirement, as embedded in a 402 challenge (`accepts[]`).
 * Wire-compatible with the x402 v1 `PaymentRequirements` type — the same object
 * `x402-fetch`, `x402-axios`, and Coinbase's facilitator clients consume.
 */
export interface PaymentRequirements {
  /** Scheme identifier — always `"exact"`. */
  scheme: typeof SCHEME
  /** Network identifier, e.g. `"robinhood"` or `"robinhood-testnet"`. */
  network: string
  /** Price in atomic token units (USDG has 6 decimals), as a decimal string. */
  maxAmountRequired: string
  /** Absolute URL of the protected resource. */
  resource: string
  /** Human description of what is being paid for. */
  description: string
  /** MIME type of the successful response body. */
  mimeType: string
  /** Optional JSON schema describing the response shape. */
  outputSchema?: Record<string, unknown> | null
  /** The address the payment is sent to. */
  payTo: Address
  /** Max seconds the server is willing to wait for settlement. */
  maxTimeoutSeconds: number
  /** The token contract address (USDG). */
  asset: Address
  /** EIP-712 domain of the asset for the `exact`/EIP-3009 signature. */
  extra?: { name: string; version: string } | null
}

/** The 402 response body. */
export interface PaymentRequiredResponse {
  x402Version: typeof X402_VERSION
  accepts: PaymentRequirements[]
  error?: string
}

/** The EIP-3009 authorization the payer signs. */
export interface ExactEvmAuthorization {
  from: Address
  to: Address
  /** Value in atomic units, decimal string. */
  value: string
  /** Unix seconds; the authorization is invalid before this time. */
  validAfter: string
  /** Unix seconds; the authorization is invalid at/after this time. */
  validBefore: string
  /** Random 32-byte nonce (0x-hex). */
  nonce: Hex
}

/** The `payload` field for the `exact` scheme. */
export interface ExactEvmPayload {
  /** 65-byte EIP-712 signature over the authorization. */
  signature: Hex
  authorization: ExactEvmAuthorization
}

/** The full payment payload carried (base64) in the `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION
  scheme: typeof SCHEME
  network: string
  payload: ExactEvmPayload
}

/** Result of verifying a payment against a requirement. */
export interface VerifyResult {
  isValid: boolean
  invalidReason?: InvalidReason
  /** The recovered payer address, present when the signature was valid. */
  payer?: Address
}

/** Result of settling a payment on-chain. */
export interface SettleResult {
  success: boolean
  errorReason?: InvalidReason
  /** The settlement transaction hash, present on success. */
  transaction?: Hex
  /** Canonical network id the settlement landed on. */
  network: string
  /** The payer address. */
  payer?: Address
}

/** The `X-PAYMENT-RESPONSE` header body (base64-encoded settle result). */
export type SettlementResponseHeader = SettleResult

/** `GET /supported` response from a facilitator. */
export interface SupportedResponse {
  kinds: Array<{ x402Version: number; scheme: string; network: string }>
}
