import type { Hex } from 'viem'

/**
 * The hood-pay reference scheme.
 *
 * USDG is a plain ERC-20 with no memo field and no EIP-2612 permit (verified
 * on the Blockscout-verified implementation during the `hoodchain` SDK
 * build), so a bare `transfer` carries no way to say WHICH invoice a payment
 * settles. hood-pay solves attribution two ways:
 *
 * 1. **Router mode** (exact attribution): the buyer pays through the
 *    stateless, non-custodial `HoodPayRouter` contract, which moves the
 *    tokens straight to the merchant and emits
 *    `PaymentReceived(reference, payer, payTo, token, amount)`. The
 *    `reference` is 32 random bytes generated per checkout. Collision math:
 *    references are drawn uniformly from 2^256; by the birthday bound the
 *    probability that any two of `k` references collide is
 *    ~ k^2 / 2^257 - at a trillion payments (k = 10^12) that is ~ 8.6e-54.
 *    Attribution is exact regardless of amount, so partial payments and
 *    overpayments are first-class (summed per reference).
 *
 * 2. **Direct mode** (amount fingerprinting, zero contracts): the buyer
 *    sends a plain USDG `transfer` and the invoice amount itself is made
 *    unique. USDG has 6 decimals; retail prices use at most 2, which leaves
 *    the low 4 decimal digits (10,000 slots, each worth 0.0001 USDG) as a
 *    fingerprint. The verifier then matches `Transfer(to = payTo,
 *    value = base + dust)` exactly. With a ledger the dust slot is RESERVED
 *    per (payTo, base amount) while the invoice is pending, making
 *    collisions impossible by construction. Without a ledger (static
 *    payment links) dust is random and the birthday bound applies:
 *    `directCollisionProbability(k)` ~ k(k-1)/(2 * 9999) for k concurrent
 *    open invoices at the SAME price to the SAME merchant - ~0.45% at
 *    k = 10, so static links suit low-concurrency sellers and the router
 *    or a ledger suits everyone else.
 */

/** Number of usable dust slots in direct mode (values 1..9999 micro-USDG). */
export const DUST_SLOTS = 9999

/** How many low decimal digits of a 6-decimal amount carry the fingerprint. */
export const DUST_DIGITS = 4

/** Modulus isolating the dust digits of a raw 6-decimal amount. */
export const DUST_MODULUS = 10n ** BigInt(DUST_DIGITS)

const HEX_CHARS = '0123456789abcdef'

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  // Web Crypto exists in browsers, workers, and Node >= 19 as a global.
  globalThis.crypto.getRandomValues(out)
  return out
}

/** Generate a fresh 32-byte payment reference (router mode), 0x-prefixed. */
export function newReference(): Hex {
  const bytes = randomBytes(32)
  let hex = '0x'
  for (const b of bytes) hex += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0xf]!
  return hex as Hex
}

/** True when `value` is a well-formed 32-byte hex reference. */
export function isReference(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

/**
 * Draw a random dust value in [1, {@link DUST_SLOTS}] (raw token units).
 * Rejection-sampled so the distribution is uniform.
 */
export function randomDust(): bigint {
  // 9999 < 2^14; sample 16 bits and reject out-of-range values.
  for (;;) {
    const b = randomBytes(2)
    const v = ((b[0]! << 8) | b[1]!) & 0x3fff // 0..16383
    if (v >= 1 && v <= DUST_SLOTS) return BigInt(v)
  }
}

/**
 * Apply a dust fingerprint to a raw base amount (direct mode). The base
 * amount's low {@link DUST_DIGITS} digits must be zero - hood-pay treats a
 * non-zero low nibble as a merchant error rather than silently clobbering it.
 */
export function applyDust(baseRaw: bigint, dust: bigint): bigint {
  if (baseRaw < 0n) throw new RangeError('base amount must be non-negative')
  if (baseRaw % DUST_MODULUS !== 0n) {
    throw new RangeError(
      `base amount ${baseRaw} already uses its low ${DUST_DIGITS} decimal digits; ` +
        'price direct-mode invoices with at most 2 decimals or use router mode',
    )
  }
  if (dust < 1n || dust > BigInt(DUST_SLOTS)) {
    throw new RangeError(`dust must be in [1, ${DUST_SLOTS}], got ${dust}`)
  }
  return baseRaw + dust
}

/** Split a fingerprinted raw amount back into `{ base, dust }`. */
export function splitDust(raw: bigint): { base: bigint; dust: bigint } {
  if (raw < 0n) throw new RangeError('amount must be non-negative')
  const dust = raw % DUST_MODULUS
  return { base: raw - dust, dust }
}

/**
 * Birthday-bound collision probability for `k` concurrent direct-mode
 * invoices at the same base amount to the same merchant with RANDOM dust
 * (no ledger reservation). Exact complement-product form.
 */
export function directCollisionProbability(k: number): number {
  if (!Number.isInteger(k) || k < 0) throw new RangeError('k must be a non-negative integer')
  if (k <= 1) return 0
  if (k > DUST_SLOTS) return 1
  let pNoCollision = 1
  for (let i = 0; i < k; i++) pNoCollision *= (DUST_SLOTS - i) / DUST_SLOTS
  return 1 - pNoCollision
}

/**
 * Birthday-bound collision probability for `k` router-mode references
 * (32 random bytes). Uses the k^2 / 2^257 approximation, which is exact to
 * double precision for every physically plausible k.
 */
export function referenceCollisionProbability(k: number): number {
  if (!Number.isFinite(k) || k < 0) throw new RangeError('k must be a non-negative number')
  return (k * k) / 2 ** 257
}
