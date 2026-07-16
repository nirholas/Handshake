import { formatUnits } from 'viem'
import { MULTIPLIER_ONE } from './abi.js'

/**
 * Nominal (branded) price types.
 *
 * The single most common ERC-8056 integration bug is applying the multiplier
 * to a price that is already multiplier-adjusted. On Robinhood Chain the
 * Chainlink Stock Token feeds are ALREADY adjusted: the answer is the price
 * of one TOKEN, not one underlying share ("The Chainlink price already
 * includes the corporate-action multiplier (dividends, splits), so the value
 * you read is the token's full price - don't apply the multiplier yourself."
 * - docs.robinhood.com/chain/building-with-stock-tokens). This package makes
 * that decision explicit in the type system: a bare `number` is not a price,
 * and the two price kinds cannot be interchanged or forged structurally.
 */
declare const priceBrand: unique symbol

/**
 * A price that is already multiplier-adjusted: USD per TOKEN.
 * This is what Chainlink Stock Token feeds on Robinhood Chain answer.
 * Construct with {@link adjustedPrice}.
 */
export interface AdjustedPrice {
  /** USD per token (multiplier already applied upstream). */
  readonly usd: number
  /** Runtime discriminant. */
  readonly adjusted: true
  readonly [priceBrand]: 'AdjustedPrice'
}

/**
 * A raw underlying-share price: USD per SHARE, with NO multiplier applied.
 * Use for off-chain equity quotes (e.g. an exchange or broker feed for the
 * underlying listed security). Construct with {@link rawPrice}.
 */
export interface RawPrice {
  /** USD per underlying share (no multiplier applied). */
  readonly usd: number
  /** Runtime discriminant. */
  readonly adjusted: false
  readonly [priceBrand]: 'RawPrice'
}

/** Either price kind. {@link trueValue} handles both correctly. */
export type StockPrice = AdjustedPrice | RawPrice

/**
 * Declare a price as already multiplier-adjusted (USD per token).
 * Chainlink Stock Token feed answers on Robinhood Chain belong here.
 *
 * @throws RangeError when `usd` is not a finite, non-negative number.
 */
export function adjustedPrice(usd: number): AdjustedPrice {
  assertUsd(usd)
  return Object.freeze({ usd, adjusted: true }) as AdjustedPrice
}

/**
 * Declare a price as a raw underlying-share price (USD per share, no
 * multiplier applied). Off-chain equity quotes belong here.
 *
 * @throws RangeError when `usd` is not a finite, non-negative number.
 */
export function rawPrice(usd: number): RawPrice {
  assertUsd(usd)
  return Object.freeze({ usd, adjusted: false }) as RawPrice
}

function assertUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`price must be a finite, non-negative number, got ${usd}`)
  }
}

function assertMultiplier(multiplier: bigint): void {
  if (multiplier <= 0n) {
    throw new RangeError(`multiplier must be positive, got ${multiplier}`)
  }
}

/** Arguments for {@link trueBalance} and {@link toUiAmount}. */
export interface TrueBalanceArgs {
  /** Raw ERC-20 balance (`balanceOf`), in the token's own base units. */
  raw: bigint
  /** The token's current `uiMultiplier()` (18-decimal fixed point). */
  multiplier: bigint
}

/**
 * The true position in underlying-share units:
 * `raw * multiplier / 1e18`, floored - bit-for-bit the math the deployed
 * `Stock` implementation uses for `balanceOfUI()` (verified on chain 4663:
 * `totalSupplyUI() == totalSupply() * uiMultiplier() / 1e18` on SGOV and
 * WEEK). The result keeps the token's own decimals (18 for every canonical
 * Stock Token).
 *
 * A raw `balanceOf` UNDERSTATES the position whenever the multiplier is
 * above 1e18. Real example (2026-07-15, chain 4663): WEEK's multiplier was
 * `2006182524271844660`, so 1.0 raw WEEK token was 2.0062 underlying shares.
 */
export function trueBalance({ raw, multiplier }: TrueBalanceArgs): bigint {
  assertMultiplier(multiplier)
  if (raw < 0n) throw new RangeError(`raw balance must be non-negative, got ${raw}`)
  return (raw * multiplier) / MULTIPLIER_ONE
}

/**
 * Spec-equivalent `toUIAmount`: raw base units to UI (underlying-share)
 * units. Identical math to {@link trueBalance}; provided under the spec's
 * name because Robinhood's deployed implementation omits the on-chain
 * conversion extension (`supportsInterface(0x57854fc3)` is `false`), so the
 * conversion must happen client-side.
 */
export function toUiAmount(raw: bigint, multiplier: bigint): bigint {
  return trueBalance({ raw, multiplier })
}

/**
 * Spec-equivalent `fromUIAmount`: UI (underlying-share) units back to raw
 * base units: `ui * 1e18 / multiplier`, floored.
 */
export function fromUiAmount(ui: bigint, multiplier: bigint): bigint {
  assertMultiplier(multiplier)
  if (ui < 0n) throw new RangeError(`ui amount must be non-negative, got ${ui}`)
  return (ui * MULTIPLIER_ONE) / multiplier
}

/** Arguments for {@link trueValue}. */
export interface TrueValueArgs {
  /** Raw ERC-20 balance (`balanceOf`), in the token's own base units. */
  raw: bigint
  /** The token's current `uiMultiplier()` (18-decimal fixed point). */
  multiplier: bigint
  /**
   * The price, constructed with {@link adjustedPrice} (USD per token,
   * multiplier already applied - Chainlink feeds on Robinhood Chain) or
   * {@link rawPrice} (USD per underlying share - off-chain equity quotes).
   * A bare number does not compile: you must decide which kind you hold.
   */
  price: StockPrice
  /** Token decimals. @defaultValue 18 (every canonical Stock Token) */
  decimals?: number
}

/**
 * The USD value of a position, with the multiplier applied exactly once:
 *
 * - {@link AdjustedPrice} (USD per token): `value = tokens * price`.
 *   Multiplying by the multiplier here DOUBLE-COUNTS the corporate action.
 * - {@link RawPrice} (USD per share): `value = tokens * multiplier * price`.
 *   Skipping the multiplier here UNDERSTATES the position.
 *
 * Real numbers (2026-07-15, chain 4663, block 10745112): SGOV's multiplier
 * was `1000957519890990718` and its Chainlink feed answered `100.62147097`
 * USD - the TOKEN price. Naively re-applying the multiplier would price a
 * 1-token position at $100.72 instead of $100.62; treating the feed as a
 * share price and dividing would give $100.53. Both are wrong; the feed
 * answer is already the token's full price.
 */
export function trueValue({ raw, multiplier, price, decimals = 18 }: TrueValueArgs): number {
  assertMultiplier(multiplier)
  if (raw < 0n) throw new RangeError(`raw balance must be non-negative, got ${raw}`)
  const tokens = Number(formatUnits(raw, decimals))
  if (price.adjusted) return tokens * price.usd
  const multiplierFloat = Number(formatUnits(multiplier, 18))
  return tokens * multiplierFloat * price.usd
}
