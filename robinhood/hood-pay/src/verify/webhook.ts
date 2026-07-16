import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PaymentResult } from './types.js'

/**
 * Signed webhooks, Stripe-style. Every delivery carries a
 * `hood-pay-signature: t=<unix seconds>,v1=<hex hmac-sha256>` header where
 * the MAC covers `"<t>.<raw body>"` with the merchant's shared secret.
 * Receivers MUST verify the signature and SHOULD reject stale timestamps
 * (default tolerance 5 minutes) - and must still treat the payload as a
 * hint only: the ledger/watcher remain the source of truth for amounts.
 */

export const SIGNATURE_HEADER = 'hood-pay-signature'

/** Compute the signature header value for a body at a timestamp. */
export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
  return `t=${timestampSeconds},v1=${mac}`
}

export interface VerifyWebhookOptions {
  /** Max accepted age/skew of the timestamp, seconds. @defaultValue 300 */
  toleranceSeconds?: number
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: number
}

/** Verify a `hood-pay-signature` header against a raw body. Constant-time. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const tolerance = options.toleranceSeconds ?? 300
  const parts = new Map(
    header.split(',').map((part) => {
      const eq = part.indexOf('=')
      return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as const
    }),
  )
  const t = Number(parts.get('t'))
  const v1 = parts.get('v1')
  if (!Number.isFinite(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > tolerance) return false
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest()
  const given = Buffer.from(v1, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** The JSON body a hood-pay webhook posts. */
export interface WebhookEvent {
  /** e.g. `payment.paid`, `payment.underpaid`, `payment.overpaid`, `payment.expired` */
  type: string
  /** Invoice id (ledger id / router reference). */
  invoiceId: string
  /** Full verifier result, bigints as decimal strings. */
  payment: {
    status: PaymentResult['status']
    expectedRaw: string
    receivedRaw: string
    overageRaw: string
    payer?: string
    reference?: string
    transfers: Array<{
      txHash: string
      logIndex: number
      blockNumber: string
      payer: string
      amountRaw: string
    }>
  }
  /** Unix seconds when the event was created. */
  created: number
}

/** Serialize a {@link PaymentResult} into the webhook wire shape. */
export function toWebhookEvent(type: string, invoiceId: string, result: PaymentResult): WebhookEvent {
  const payment: WebhookEvent['payment'] = {
    status: result.status,
    expectedRaw: result.expectedRaw.toString(),
    receivedRaw: result.receivedRaw.toString(),
    overageRaw: result.overageRaw.toString(),
    transfers: result.transfers.map((t) => ({
      txHash: t.txHash,
      logIndex: t.logIndex,
      blockNumber: t.blockNumber.toString(),
      payer: t.payer,
      amountRaw: t.amountRaw.toString(),
    })),
  }
  if (result.payer) payment.payer = result.payer
  if (result.reference) payment.reference = result.reference
  return { type, invoiceId, payment, created: Math.floor(Date.now() / 1000) }
}

export interface WebhookEmitterOptions {
  url: string
  secret: string
  /** Backoff delays between attempts, ms. @defaultValue [0, 2000, 10000, 60000] */
  retryDelaysMs?: number[]
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
}

export interface WebhookDeliveryResult {
  ok: boolean
  attempts: number
  /** HTTP status of the final attempt, when a response was received. */
  status?: number
  error?: string
}

/**
 * Create a webhook emitter. `emit` posts the signed event and retries on
 * network errors and 5xx/429 responses; 2xx settles as delivered, other
 * 4xx settle as failed immediately (the receiver rejected it - retrying
 * the same payload cannot help).
 */
export function createWebhookEmitter(options: WebhookEmitterOptions) {
  const delays = options.retryDelaysMs ?? [0, 2000, 10000, 60000]
  const doFetch = options.fetchImpl ?? fetch

  return {
    async emit(event: WebhookEvent): Promise<WebhookDeliveryResult> {
      const body = JSON.stringify(event)
      let lastError: string | undefined
      let lastStatus: number | undefined
      for (let attempt = 0; attempt < delays.length; attempt++) {
        const delay = delays[attempt]!
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        try {
          const response = await doFetch(options.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [SIGNATURE_HEADER]: signWebhook(options.secret, body, Math.floor(Date.now() / 1000)),
            },
            body,
          })
          lastStatus = response.status
          if (response.ok) {
            const result: WebhookDeliveryResult = { ok: true, attempts: attempt + 1, status: response.status }
            return result
          }
          if (response.status !== 429 && response.status < 500) {
            return {
              ok: false,
              attempts: attempt + 1,
              status: response.status,
              error: `receiver rejected with HTTP ${response.status}`,
            }
          }
          lastError = `HTTP ${response.status}`
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      const result: WebhookDeliveryResult = {
        ok: false,
        attempts: delays.length,
        error: lastError ?? 'delivery failed',
      }
      if (lastStatus !== undefined) result.status = lastStatus
      return result
    },
  }
}
