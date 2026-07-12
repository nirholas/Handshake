/** Minimal integer Uniswap v3 math — no external dependency, exact BigInt arithmetic. */

const MIN_TICK = -887272n
const MAX_TICK = 887272n
const Q96 = 1n << 96n

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  const r = a % b
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b)
}

/** Integer square root (floor) via Newton's method, for non-negative BigInt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of negative number')
  if (n < 2n) return n
  let x0 = n
  let x1 = (x0 + 1n) >> 1n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + n / x0) >> 1n
  }
  return x0
}

/**
 * `sqrtPriceX96` for a pool seeded with `amount0` of token0 and `amount1` of
 * token1 (both raw, decimals-scaled units). Price is token1-per-token0.
 */
export function sqrtPriceX96FromAmounts(amount0: bigint, amount1: bigint): bigint {
  if (amount0 <= 0n) throw new RangeError('amount0 must be positive')
  // sqrt(amount1/amount0) * 2^96 == sqrt(amount1 * 2^192 / amount0)
  return isqrt((amount1 * (1n << 192n)) / amount0)
}

/** The widest usable tick range for a given tick spacing (a "full-range" position). */
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  const spacing = BigInt(tickSpacing)
  const tickLower = ceilDiv(MIN_TICK, spacing) * spacing
  const tickUpper = floorDiv(MAX_TICK, spacing) * spacing
  return { tickLower: Number(tickLower), tickUpper: Number(tickUpper) }
}

/** Sort two tokens the way Uniswap v3 requires (`token0 < token1` by address). */
export function sortTokens(
  a: { address: `0x${string}`; amount: bigint },
  b: { address: `0x${string}`; amount: bigint },
): { token0: `0x${string}`; token1: `0x${string}`; amount0: bigint; amount1: bigint } {
  const aFirst = a.address.toLowerCase() < b.address.toLowerCase()
  return aFirst
    ? { token0: a.address, token1: b.address, amount0: a.amount, amount1: b.amount }
    : { token0: b.address, token1: a.address, amount0: b.amount, amount1: a.amount }
}
