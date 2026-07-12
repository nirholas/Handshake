/**
 * hood402/client — a fetch wrapper that pays x402 challenges automatically.
 *
 * On a 402 it selects a USDG requirement, signs an EIP-3009
 * `TransferWithAuthorization` (gasless — the facilitator pays gas), and retries
 * with the `X-PAYMENT` header. Enforces a hard per-origin spend cap and caches
 * discovered prices so repeat calls skip the extra round-trip.
 *
 * Works in Node and the browser: pass a viem `LocalAccount` (private key) or a
 * `WalletClient` wired to an injected wallet.
 */
import {
  formatUnits,
  getAddress,
  parseUnits,
  type Account,
  type Address,
  type Hex,
  type TypedDataDomain,
  type WalletClient,
} from 'viem'
import { requireNetwork, type HoodNetwork } from '../networks.js'
import { SpendCapExceededError } from '../errors.js'
import { PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from '../challenge.js'
import { decodeSettlementHeader, encodePaymentHeader } from '../scheme/encoding.js'
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  randomNonce,
  usdgDomain,
} from '../scheme/exact.js'
import type {
  ExactEvmAuthorization,
  PaymentPayload,
  PaymentRequiredResponse,
  PaymentRequirements,
  SettleResult,
} from '../types.js'
import { SCHEME, X402_VERSION } from '../types.js'

/** The EIP-712 message a payer signs — {@link ExactEvmAuthorization} with numeric fields as bigints. */
export type AuthorizationMessage = Omit<
  ExactEvmAuthorization,
  'value' | 'validAfter' | 'validBefore'
> & { value: bigint; validAfter: bigint; validBefore: bigint }

/** A minimal typed-data signer. A viem `LocalAccount` satisfies this directly. */
export interface Signer {
  address: Address
  signTypedData(params: {
    domain: TypedDataDomain
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES
    primaryType: 'TransferWithAuthorization'
    message: AuthorizationMessage
  }): Promise<Hex>
}

/** Build a {@link Signer} from a viem `LocalAccount`. */
export function fromAccount(account: Account & { signTypedData: Signer['signTypedData'] }): Signer {
  return { address: getAddress(account.address), signTypedData: (p) => account.signTypedData(p) }
}

/** Build a {@link Signer} from a viem `WalletClient` (e.g. an injected wallet). */
export function fromWalletClient(client: WalletClient, address: Address): Signer {
  return {
    address: getAddress(address),
    signTypedData: (p) =>
      client.signTypedData({
        account: address,
        domain: p.domain,
        types: p.types,
        primaryType: p.primaryType,
        message: p.message,
      }) as Promise<Hex>,
  }
}

export interface Hood402ClientOptions {
  /** The wallet that signs payments. */
  signer: Signer
  /** Hard cap on total spend per origin, in USDG (default `"1.00"`). */
  maxSpendPerOrigin?: string
  /** Only pay on these networks (default: all Robinhood networks). */
  allowedNetworks?: string[]
  /** Underlying fetch (defaults to the global). */
  fetch?: typeof fetch
  /** Validity window of a signed authorization, in seconds (default 300). */
  validitySeconds?: number
  /** Injectable clock (unix seconds) for tests. */
  now?: () => number
}

/** The result of a paid request: the response plus the settlement receipt. */
export interface PaidResponse {
  response: Response
  /** Decoded `X-PAYMENT-RESPONSE`, present when a payment was made. */
  settlement?: SettleResult
  /** Whether a payment was actually required and made. */
  paid: boolean
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

export class Hood402Client {
  private readonly signer: Signer
  private readonly capAtomicPerOrigin: Map<string, bigint> = new Map()
  private readonly spentPerOrigin: Map<string, bigint> = new Map()
  private readonly priceCache: Map<string, PaymentRequirements> = new Map()
  private readonly allowed: Set<string> | undefined
  private readonly fetchImpl: typeof fetch
  private readonly validitySeconds: number
  private readonly now: () => number
  private readonly capHuman: string

  constructor(opts: Hood402ClientOptions) {
    this.signer = opts.signer
    this.capHuman = opts.maxSpendPerOrigin ?? '1.00'
    this.allowed = opts.allowedNetworks ? new Set(opts.allowedNetworks) : undefined
    this.fetchImpl = opts.fetch ?? fetch
    this.validitySeconds = opts.validitySeconds ?? 300
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Total USDG spent so far against an origin (human string). */
  spent(origin: string): string {
    return formatUnits(this.spentPerOrigin.get(originOf(origin)) ?? 0n, 6)
  }

  private capAtomic(origin: string, net: HoodNetwork): bigint {
    const existing = this.capAtomicPerOrigin.get(origin)
    if (existing !== undefined) return existing
    const cap = parseUnits(this.capHuman, net.usdgDecimals)
    this.capAtomicPerOrigin.set(origin, cap)
    return cap
  }

  private selectRequirement(accepts: PaymentRequirements[]): {
    req: PaymentRequirements
    net: HoodNetwork
  } | null {
    for (const req of accepts) {
      if (req.scheme !== SCHEME) continue
      const net = requireNetworkSafe(req.network)
      if (!net) continue
      if (this.allowed && !this.allowed.has(net.id)) continue
      return { req, net }
    }
    return null
  }

  /** Sign a payment payload for a requirement (does not send it). */
  async sign(req: PaymentRequirements): Promise<PaymentPayload> {
    const net = requireNetwork(req.network)
    const now = this.now()
    const authorization: ExactEvmAuthorization = {
      from: this.signer.address,
      to: getAddress(req.payTo),
      value: req.maxAmountRequired,
      validAfter: String(now - 5),
      validBefore: String(now + this.validitySeconds),
      nonce: randomNonce(),
    }
    const domain = usdgDomain(net)
    const signature = await this.signer.signTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
      },
    })
    return {
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: net.id,
      payload: { signature, authorization },
    }
  }

  private enforceCap(origin: string, net: HoodNetwork, value: bigint): void {
    const cap = this.capAtomic(origin, net)
    const spent = this.spentPerOrigin.get(origin) ?? 0n
    if (spent + value > cap) {
      throw new SpendCapExceededError(
        origin,
        formatUnits(value, net.usdgDecimals),
        formatUnits(cap, net.usdgDecimals),
      )
    }
  }

  /**
   * fetch()-compatible call that transparently pays a 402. Returns the final
   * `Response`. Use {@link fetchWithReceipt} to also get the settlement receipt.
   */
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return (await this.fetchWithReceipt(input, init)).response
  }

  /** Like {@link fetch} but returns the settlement receipt alongside the response. */
  async fetchWithReceipt(input: string | URL, init?: RequestInit): Promise<PaidResponse> {
    const url = typeof input === 'string' ? input : input.toString()
    const origin = originOf(url)

    // Pre-flight: if we've priced this resource before, pay up front.
    const cached = this.priceCache.get(url)
    if (cached) {
      const paid = await this.payAndSend(url, init, [cached], origin)
      if (paid) return paid
    }

    const res = await this.fetchImpl(url, init)
    if (res.status !== 402) return { response: res, paid: false }

    const body = (await res.clone().json().catch(() => null)) as PaymentRequiredResponse | null
    if (!body || !Array.isArray(body.accepts)) return { response: res, paid: false }

    const paid = await this.payAndSend(url, init, body.accepts, origin)
    return paid ?? { response: res, paid: false }
  }

  private async payAndSend(
    url: string,
    init: RequestInit | undefined,
    accepts: PaymentRequirements[],
    origin: string,
  ): Promise<PaidResponse | null> {
    const selected = this.selectRequirement(accepts)
    if (!selected) return null
    const { req, net } = selected

    const value = BigInt(req.maxAmountRequired)
    this.enforceCap(origin, net, value)

    const payload = await this.sign(req)
    const headers = new Headers(init?.headers)
    headers.set(PAYMENT_HEADER, encodePaymentHeader(payload))

    const response = await this.fetchImpl(url, { ...init, headers })

    // Only count spend + cache the price when the paid request actually succeeded.
    if (response.ok) {
      this.spentPerOrigin.set(origin, (this.spentPerOrigin.get(origin) ?? 0n) + value)
      this.priceCache.set(url, req)
    }

    const settlement =
      decodeSettlementHeader(response.headers.get(PAYMENT_RESPONSE_HEADER)) ?? undefined
    return {
      response,
      paid: response.ok,
      ...(settlement ? { settlement } : {}),
    }
  }
}

function requireNetworkSafe(id: string): HoodNetwork | undefined {
  try {
    return requireNetwork(id)
  } catch {
    return undefined
  }
}

/**
 * Convenience: wrap a fetch implementation so all calls transparently pay.
 * Returns a `fetch`-compatible function.
 */
export function wrapFetch(opts: Hood402ClientOptions): typeof fetch {
  const client = new Hood402Client(opts)
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input
    return client.fetch(url, init)
  }) as typeof fetch
}
