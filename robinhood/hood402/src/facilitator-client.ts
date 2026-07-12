import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  SupportedResponse,
  VerifyResult,
} from './types.js'
import { X402_VERSION } from './types.js'

export interface FacilitatorClientOptions {
  /** Base URL of the facilitator, e.g. `https://facilitator.hood402.dev`. */
  url: string
  /** Optional bearer token if the facilitator is access-controlled. */
  apiKey?: string
  /** Custom fetch (defaults to the global). */
  fetch?: typeof fetch
}

/**
 * Thin HTTP client for a remote hood402 facilitator. A resource server in
 * "facilitator mode" uses this to delegate `/verify` and `/settle` instead of
 * holding a gas key itself.
 */
export class FacilitatorClient {
  private readonly base: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: FacilitatorClientOptions) {
    this.base = opts.url.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetch ?? fetch
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) h['authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  /** Which (scheme, network) pairs this facilitator settles. */
  async supported(): Promise<SupportedResponse> {
    const res = await this.fetchImpl(`${this.base}/supported`, { headers: this.headers() })
    if (!res.ok) throw new Error(`hood402 facilitator /supported failed: ${res.status}`)
    return (await res.json()) as SupportedResponse
  }

  /** Ask the facilitator to verify a payment. */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const res = await this.fetchImpl(`${this.base}/verify`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
    })
    if (!res.ok) throw new Error(`hood402 facilitator /verify failed: ${res.status}`)
    return (await res.json()) as VerifyResult
  }

  /** Ask the facilitator to settle a payment on-chain. */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResult> {
    const res = await this.fetchImpl(`${this.base}/settle`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
    })
    if (!res.ok) throw new Error(`hood402 facilitator /settle failed: ${res.status}`)
    return (await res.json()) as SettleResult
  }
}
