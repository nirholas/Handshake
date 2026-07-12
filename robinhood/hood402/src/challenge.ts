import { getAddress, parseUnits, type Address } from 'viem'
import { requireNetwork } from './networks.js'
import type { PaymentRequiredResponse, PaymentRequirements } from './types.js'
import { SCHEME, X402_VERSION } from './types.js'

/** HTTP header names used by the x402 v1 wire protocol. */
export const PAYMENT_HEADER = 'X-PAYMENT'
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE'

/** A price expressed either as a human decimal string ("0.01") or atomic units. */
export type Price = string | { atomic: string } | { usdg: string }

/** Convert a {@link Price} to atomic USDG units (6 decimals) as a string. */
export function toAtomic(price: Price, decimals: number): string {
  if (typeof price === 'string') return parseUnits(price, decimals).toString()
  if ('atomic' in price) return BigInt(price.atomic).toString()
  return parseUnits(price.usdg, decimals).toString()
}

export interface BuildRequirementsInput {
  /** Price of the resource (e.g. "0.01" USDG). */
  price: Price
  /** Address that receives the payment. */
  payTo: Address
  /** Network id/alias (default `"robinhood"`). */
  network?: string
  /** Absolute URL of the protected resource. */
  resource: string
  /** Human description of what is being bought. */
  description?: string
  /** MIME type of the success response (default `application/json`). */
  mimeType?: string
  /** JSON schema of the success response. */
  outputSchema?: Record<string, unknown> | null
  /** Max seconds to wait for settlement (default 60). */
  maxTimeoutSeconds?: number
}

/** Build a single spec-compliant {@link PaymentRequirements} for USDG. */
export function buildRequirements(input: BuildRequirementsInput): PaymentRequirements {
  const net = requireNetwork(input.network ?? 'robinhood')
  return {
    scheme: SCHEME,
    network: net.id,
    maxAmountRequired: toAtomic(input.price, net.usdgDecimals),
    resource: input.resource,
    description: input.description ?? '',
    mimeType: input.mimeType ?? 'application/json',
    outputSchema: input.outputSchema ?? null,
    payTo: getAddress(input.payTo),
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
    asset: net.usdg,
    extra: { name: net.usdgDomain.name, version: net.usdgDomain.version },
  }
}

/** Wrap one or more requirements into a 402 response body. */
export function buildPaymentRequired(
  accepts: PaymentRequirements | PaymentRequirements[],
  error?: string,
): PaymentRequiredResponse {
  return {
    x402Version: X402_VERSION,
    accepts: Array.isArray(accepts) ? accepts : [accepts],
    ...(error ? { error } : {}),
  }
}
