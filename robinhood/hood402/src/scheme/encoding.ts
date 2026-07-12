import type { PaymentPayload, SettlementResponseHeader } from '../types.js'

/**
 * UTF-8-safe base64 helpers that work in Node and the browser without a
 * `Buffer` dependency (the client bundle runs in browsers). Falls back to
 * `Buffer` when the `btoa`/`atob` globals are absent (older Node contexts).
 */
function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }
  // Node without the web globals.
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode a JSON-serializable value as UTF-8 base64. */
export function encodeBase64Json(value: unknown): string {
  return toBase64(encoder.encode(JSON.stringify(value)))
}

/** Decode UTF-8 base64 into a JSON value. Throws on malformed input. */
export function decodeBase64Json<T>(b64: string): T {
  return JSON.parse(decoder.decode(fromBase64(b64.trim()))) as T
}

/** Encode a payment payload into the value of the `X-PAYMENT` header. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return encodeBase64Json(payload)
}

/**
 * Decode an `X-PAYMENT` header value into a payment payload. Returns `null`
 * (never throws) when the header is missing or cannot be decoded — the caller
 * maps that to a `malformed_payment` challenge.
 */
export function decodePaymentHeader(header: string | undefined | null): PaymentPayload | null {
  if (!header) return null
  try {
    const decoded = decodeBase64Json<PaymentPayload>(header)
    if (!decoded || typeof decoded !== 'object') return null
    return decoded
  } catch {
    return null
  }
}

/** Encode a settlement result into the value of the `X-PAYMENT-RESPONSE` header. */
export function encodeSettlementHeader(result: SettlementResponseHeader): string {
  return encodeBase64Json(result)
}

/** Decode an `X-PAYMENT-RESPONSE` header value. Returns `null` on malformed input. */
export function decodeSettlementHeader(
  header: string | undefined | null,
): SettlementResponseHeader | null {
  if (!header) return null
  try {
    return decodeBase64Json<SettlementResponseHeader>(header)
  } catch {
    return null
  }
}
