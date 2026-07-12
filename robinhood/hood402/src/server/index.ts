/**
 * hood402/server — paywall middleware.
 *
 * Two settlement modes:
 *  - **facilitator mode**: pass `facilitator` (a URL or a `FacilitatorClient`).
 *    The resource server holds no gas key; verify + settle are delegated.
 *  - **self-settle mode**: pass a viem `wallet` (gas key) + `reader` (public
 *    client). The server verifies and broadcasts settlement itself.
 *
 * Both emit spec-compliant x402 v1 402 challenges (`X-PAYMENT` in, base64
 * `X-PAYMENT-RESPONSE` out) and interoperate with any standard x402 client.
 */
import { getAddress, type Address } from 'viem'
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  buildPaymentRequired,
  buildRequirements,
  type Price,
} from '../challenge.js'
import { decodePaymentHeader, encodeSettlementHeader } from '../scheme/encoding.js'
import { FacilitatorClient } from '../facilitator-client.js'
import { Hood402ConfigError, REASON_TEXT } from '../errors.js'
import { verifyPayment, type HoodReader } from '../verify.js'
import { settlePayment, type HoodBroadcaster, type HoodConfirmer } from '../settle.js'
import type {
  PaymentPayload,
  PaymentRequiredResponse,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from '../types.js'

export interface PaywallOptions {
  /** Price of the resource, e.g. `"0.01"` USDG or `{ atomic: "10000" }`. */
  price: Price
  /** Address that receives the payment. */
  payTo: Address
  /** Network id/alias — `"robinhood"` (default) or `"robinhood-testnet"`. */
  network?: string
  /** Human description of what is being sold. */
  description?: string
  /** MIME type of the success response (default `application/json`). */
  mimeType?: string
  /** Max seconds to wait for settlement (default 60). */
  maxTimeoutSeconds?: number
  /** Fixed resource URL. Omit to derive it from the request. */
  resource?: string

  // --- facilitator mode ---
  /** A facilitator base URL or a constructed `FacilitatorClient`. */
  facilitator?: string | FacilitatorClient

  // --- self-settle mode ---
  /** viem WalletClient (gas key) for local settlement. */
  wallet?: HoodBroadcaster
  /** The gas wallet's own address (the account bound to `wallet`). */
  account?: Address
  /** viem PublicClient for verification + confirmation. */
  reader?: HoodConfirmer
}

interface AuthorizeOk {
  ok: true
  payload: PaymentPayload
  requirements: PaymentRequirements
}
interface AuthorizeFail {
  ok: false
  status: 402
  body: PaymentRequiredResponse
}
type Authorization = AuthorizeOk | AuthorizeFail

/**
 * The framework-agnostic payment engine. Adapters (Express, Hono, fetch) call
 * these three methods; all the protocol logic lives here.
 */
export class PaywallEngine {
  private readonly facilitator: FacilitatorClient | undefined
  private readonly wallet: HoodBroadcaster | undefined
  private readonly reader: (HoodReader & Partial<HoodConfirmer>) | undefined

  constructor(private readonly opts: PaywallOptions) {
    if (opts.facilitator) {
      this.facilitator =
        typeof opts.facilitator === 'string'
          ? new FacilitatorClient({ url: opts.facilitator })
          : opts.facilitator
    }
    this.wallet = opts.wallet
    this.reader = opts.reader
    if (!this.facilitator && !(this.wallet && this.reader && opts.account)) {
      throw new Hood402ConfigError(
        'hood402 paywall: provide either `facilitator` or all of `wallet`, `account`, and `reader`.',
      )
    }
  }

  /** Build the payment requirement for a given resource URL. */
  requirements(resource: string): PaymentRequirements {
    return buildRequirements({
      price: this.opts.price,
      payTo: this.opts.payTo,
      resource,
      ...(this.opts.network !== undefined ? { network: this.opts.network } : {}),
      ...(this.opts.description !== undefined ? { description: this.opts.description } : {}),
      ...(this.opts.mimeType !== undefined ? { mimeType: this.opts.mimeType } : {}),
      ...(this.opts.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: this.opts.maxTimeoutSeconds }
        : {}),
    })
  }

  private challenge(requirements: PaymentRequirements, error?: string): AuthorizeFail {
    return { ok: false, status: 402, body: buildPaymentRequired(requirements, error) }
  }

  /** Decode + verify the `X-PAYMENT` header. Returns a challenge if unpaid/invalid. */
  async authorize(headerValue: string | undefined, resource: string): Promise<Authorization> {
    const requirements = this.requirements(resource)
    const payload = decodePaymentHeader(headerValue)
    if (!payload) {
      return this.challenge(requirements, headerValue ? REASON_TEXT.malformed_payment : undefined)
    }

    let result: VerifyResult
    if (this.facilitator) {
      result = await this.facilitator.verify(payload, requirements)
    } else {
      result = await verifyPayment({ payload, requirements, reader: this.reader! })
    }

    if (!result.isValid) {
      return this.challenge(
        requirements,
        result.invalidReason ? REASON_TEXT[result.invalidReason] : 'Payment verification failed',
      )
    }
    return { ok: true, payload, requirements }
  }

  /** Settle a verified payment on-chain. */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    if (this.facilitator) return this.facilitator.settle(payload, requirements)
    return settlePayment({
      payload,
      requirements,
      wallet: this.wallet!,
      account: this.opts.account!,
      reader: this.reader as HoodConfirmer,
    })
  }

  /** Base64 `X-PAYMENT-RESPONSE` header value for a settlement result. */
  settlementHeader(result: SettleResult): string {
    return encodeSettlementHeader(result)
  }
}

// ---------------------------------------------------------------------------
// Express adapter
// ---------------------------------------------------------------------------

interface ExpressReqLike {
  header(name: string): string | undefined
  protocol?: string
  originalUrl?: string
  url?: string
  get?(name: string): string | undefined
}
interface ExpressResLike {
  status(code: number): ExpressResLike
  json(body: unknown): unknown
  setHeader(name: string, value: string): void
}
type ExpressNext = (err?: unknown) => void

function absoluteUrl(req: ExpressReqLike, fixed?: string): string {
  if (fixed) return fixed
  const host = req.get?.('host') ?? req.header('host') ?? 'localhost'
  const proto = req.protocol ?? 'https'
  const path = req.originalUrl ?? req.url ?? '/'
  return `${proto}://${host}${path}`
}

/**
 * Express middleware. Verifies the `X-PAYMENT` header; on success it settles
 * the payment, attaches `X-PAYMENT-RESPONSE`, then hands off to your route.
 * Settlement completes before the handler runs, so the served resource always
 * corresponds to a settled payment.
 */
export function paywall(opts: PaywallOptions) {
  const engine = new PaywallEngine(opts)
  return async (req: ExpressReqLike, res: ExpressResLike, next: ExpressNext): Promise<void> => {
    try {
      const resource = absoluteUrl(req, opts.resource)
      const auth = await engine.authorize(req.header(PAYMENT_HEADER), resource)
      if (!auth.ok) {
        res.status(auth.status).json(auth.body)
        return
      }
      const settlement = await engine.settle(auth.payload, auth.requirements)
      if (!settlement.success) {
        res
          .status(402)
          .json(
            buildPaymentRequired(
              auth.requirements,
              settlement.errorReason
                ? REASON_TEXT[settlement.errorReason]
                : 'Settlement failed',
            ),
          )
        return
      }
      res.setHeader(PAYMENT_RESPONSE_HEADER, engine.settlementHeader(settlement))
      next()
    } catch (err) {
      next(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Hono adapter
// ---------------------------------------------------------------------------

interface HonoContextLike {
  req: { header(name: string): string | undefined; url: string }
  header(name: string, value: string): void
  json(body: unknown, status?: number): Response
}
type HonoNext = () => Promise<void>

/** Hono middleware — same semantics as the Express adapter. */
export function honoPaywall(opts: PaywallOptions) {
  const engine = new PaywallEngine(opts)
  return async (c: HonoContextLike, next: HonoNext): Promise<Response | void> => {
    const resource = opts.resource ?? c.req.url
    const auth = await engine.authorize(c.req.header(PAYMENT_HEADER), resource)
    if (!auth.ok) return c.json(auth.body, auth.status)
    const settlement = await engine.settle(auth.payload, auth.requirements)
    if (!settlement.success) {
      return c.json(
        buildPaymentRequired(
          auth.requirements,
          settlement.errorReason ? REASON_TEXT[settlement.errorReason] : 'Settlement failed',
        ),
        402,
      )
    }
    c.header(PAYMENT_RESPONSE_HEADER, engine.settlementHeader(settlement))
    await next()
  }
}

export { getAddress }
export type { PaymentRequirements, SettleResult, VerifyResult }
