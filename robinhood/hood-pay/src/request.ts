import { getAddress, isAddress, parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { networkInfo, type HoodPayNetwork, type PayToken } from './networks.js'
import { isReference } from './reference.js'

/**
 * A payment request is the unit hood-pay moves around: the widget renders
 * one, a payment link encodes one in its URL fragment, and the verifier
 * awaits one. It is plain data - no keys, no secrets - safe to embed in a
 * public page or QR code.
 */
export interface PaymentRequest {
  /** Schema version. Always 1. */
  v: 1
  network: HoodPayNetwork
  /** Merchant receiving address (checksummed). */
  payTo: Address
  /**
   * Decimal amount string (e.g. `"12.50"`), or `"dynamic"` to let the buyer
   * enter the amount (tips, donations, pay-what-you-want).
   */
  amount: string
  /**
   * Payment token. Omitted = USDG on the request's network. Any ERC-20
   * works (the testnet, for example, has faucet Stock Tokens but the router
   * and verifier are token-agnostic).
   */
  token?: PayToken
  /** Free-text memo shown to the buyer. Off-chain only - never posted on-chain. */
  memo?: string
  /**
   * Router-mode reference (32-byte hex). Present = pay through the
   * HoodPayRouter at `router`; absent = direct ERC-20 transfer matched by
   * amount fingerprint.
   */
  reference?: Hex
  /** HoodPayRouter address. Required when `reference` is set. */
  router?: Address
}

/** Longest memo a request may carry (keeps links QR-friendly). */
export const MAX_MEMO_LENGTH = 280

const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/

/**
 * Validate an untrusted value into a {@link PaymentRequest}. Addresses are
 * checksum-normalized via viem's `getAddress` (mixed-case inputs with a bad
 * EIP-55 checksum are rejected). Throws `TypeError`/`RangeError` with a
 * human-readable message on the first problem found.
 */
export function validatePaymentRequest(input: unknown): PaymentRequest {
  if (typeof input !== 'object' || input === null) throw new TypeError('payment request must be an object')
  const r = input as Record<string, unknown>

  if (r.v !== 1 && r.v !== undefined) throw new RangeError(`unsupported payment request version ${String(r.v)}`)

  const network = (r.network ?? 'mainnet') as HoodPayNetwork
  networkInfo(network) // throws on unknown network

  if (typeof r.payTo !== 'string' || !isAddress(r.payTo, { strict: true })) {
    throw new TypeError('payTo must be a 0x-prefixed 20-byte address with a valid EIP-55 checksum')
  }
  const payTo = getAddress(r.payTo)

  if (typeof r.amount !== 'string') throw new TypeError('amount must be a string (decimal or "dynamic")')
  const amount = r.amount.trim()
  if (amount !== 'dynamic' && !AMOUNT_RE.test(amount)) {
    throw new RangeError(`amount "${amount}" is not a plain decimal string (or "dynamic")`)
  }

  let token: PayToken | undefined
  if (r.token !== undefined) {
    const t = r.token as Record<string, unknown>
    if (typeof t !== 'object' || t === null) throw new TypeError('token must be an object')
    if (typeof t.address !== 'string' || !isAddress(t.address, { strict: true })) {
      throw new TypeError('token.address must be a 0x-prefixed 20-byte address with a valid EIP-55 checksum')
    }
    if (typeof t.symbol !== 'string' || t.symbol.length === 0 || t.symbol.length > 20) {
      throw new TypeError('token.symbol must be a 1-20 character string')
    }
    if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
      throw new RangeError('token.decimals must be an integer in [0, 36]')
    }
    token = { address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals }
  }

  const decimals = token?.decimals ?? networkInfo(network).usdg.decimals
  if (amount !== 'dynamic') {
    const raw = parseUnits(amount, decimals)
    if (raw <= 0n) throw new RangeError('amount must be greater than zero')
    const frac = amount.split('.')[1] ?? ''
    if (frac.length > decimals) {
      throw new RangeError(`amount "${amount}" has more decimal places than the token's ${decimals}`)
    }
  }

  let memo: string | undefined
  if (r.memo !== undefined) {
    if (typeof r.memo !== 'string') throw new TypeError('memo must be a string')
    memo = r.memo.slice(0, MAX_MEMO_LENGTH)
  }

  let reference: Hex | undefined
  let router: Address | undefined
  if (r.reference !== undefined) {
    if (!isReference(r.reference)) throw new TypeError('reference must be a 0x-prefixed 32-byte hex string')
    reference = r.reference.toLowerCase() as Hex
    if (typeof r.router !== 'string' || !isAddress(r.router, { strict: true })) {
      throw new TypeError('router-mode requests (reference set) must carry a checksummed HoodPayRouter address in "router"')
    }
    router = getAddress(r.router)
  } else if (r.router !== undefined) {
    throw new TypeError('"router" is only valid together with "reference"')
  }

  const out: PaymentRequest = { v: 1, network, payTo, amount }
  if (token) out.token = token
  if (memo !== undefined) out.memo = memo
  if (reference) out.reference = reference
  if (router) out.router = router
  return out
}

/** The token a request settles in (USDG unless overridden). */
export function requestToken(request: PaymentRequest): PayToken {
  return request.token ?? networkInfo(request.network).usdg
}

/** Raw on-chain amount for a fixed-amount request. Throws for `"dynamic"`. */
export function requestRawAmount(request: PaymentRequest): bigint {
  if (request.amount === 'dynamic') {
    throw new RangeError('dynamic-amount requests have no fixed raw amount')
  }
  return parseUnits(request.amount, requestToken(request).decimals)
}

/** Format a raw amount in the request's token for display. */
export function formatRequestAmount(request: PaymentRequest, raw: bigint): string {
  return formatUnits(raw, requestToken(request).decimals)
}

// --- URL fragment codec -----------------------------------------------------

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(encoded: string): string {
  const b64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Encode a request as a URL fragment payload: `1.<base64url(JSON)>`.
 * The fragment never leaves the browser (fragments are not sent in HTTP
 * requests), so hosted payment links leak nothing to the host.
 */
export function encodePaymentRequest(request: PaymentRequest): string {
  const validated = validatePaymentRequest(request)
  return `1.${base64UrlEncode(JSON.stringify(validated))}`
}

/** Decode and validate a fragment payload produced by {@link encodePaymentRequest}. */
export function decodePaymentRequest(fragment: string): PaymentRequest {
  const clean = fragment.startsWith('#') ? fragment.slice(1) : fragment
  const dot = clean.indexOf('.')
  if (dot === -1) throw new TypeError('malformed payment link (missing version prefix)')
  const version = clean.slice(0, dot)
  if (version !== '1') throw new RangeError(`unsupported payment link version "${version}"`)
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlDecode(clean.slice(dot + 1)))
  } catch {
    throw new TypeError('malformed payment link (payload is not base64url JSON)')
  }
  return validatePaymentRequest(parsed)
}

/** Build a full hosted payment link for a request. */
export function paymentLinkUrl(request: PaymentRequest, baseUrl = 'https://nirholas.github.io/hood-pay/pay.html'): string {
  return `${baseUrl}#${encodePaymentRequest(request)}`
}
