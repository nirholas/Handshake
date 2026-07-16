/**
 * Inclusion criteria for hood-tokenlist.
 *
 * Every rule here is objective and machine-checkable. There is no editorial
 * override: a token that fails any applicable rule is excluded, a token
 * that passes them all is included. The same constants are published on the
 * docs site (docs/criteria.html) and unit-tested in tests/criteria.test.mjs.
 */

/** Thresholds for memecoin inclusion. Change = criteria change = docs change. */
export const MEMECOIN_CRITERIA = {
  /** Minimum age in days since launch (NOXA) or graduation (Odyssey). */
  minAgeDays: 7,
  /** Minimum holder count (Blockscout `holders_count`). */
  minHolders: 50,
  /**
   * Minimum total pool value in USD, computed as 2x the quote-side
   * (WETH or USDG) reserves, valued via the on-chain Chainlink
   * ETH/USD and USDG/USD feeds at refresh time.
   */
  minLiquidityUsd: 2500,
}

/** Tokenlist schema limits every entry must satisfy (from @uniswap/token-lists). */
export const SCHEMA_LIMITS = {
  symbolMaxLength: 20,
  symbolPattern: /^\S+$/,
  nameMaxLength: 60,
  namePattern: /^[ \S+]+$/,
  decimalsMax: 255,
}

const SECONDS_PER_DAY = 86_400

/**
 * ERC-20 identity sanity: the on-chain symbol/name/decimals must be usable
 * in a schema-valid tokenlist entry.
 * Returns a list of failure reasons (empty = pass).
 */
export function checkErc20Identity({ symbol, name, decimals }) {
  const reasons = []
  if (typeof symbol !== 'string' || symbol.length === 0) reasons.push('symbol unreadable or empty')
  else {
    if (symbol.length > SCHEMA_LIMITS.symbolMaxLength) reasons.push(`symbol longer than ${SCHEMA_LIMITS.symbolMaxLength} chars`)
    if (!SCHEMA_LIMITS.symbolPattern.test(symbol)) reasons.push('symbol contains whitespace')
  }
  if (typeof name !== 'string' || name.trim().length === 0) reasons.push('name unreadable or empty')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > SCHEMA_LIMITS.decimalsMax) {
    reasons.push('decimals unreadable or out of range')
  }
  return reasons
}

/**
 * Display name for a tokenlist entry. On-chain names longer than the
 * schema's 60-char cap have the Stock Token suffix removed; anything still
 * longer is excluded upstream by checkErc20Identity on the derived name.
 */
export function displayName(onchainName) {
  const name = String(onchainName).replace(/\s+/g, ' ').trim()
  if (name.length <= SCHEMA_LIMITS.nameMaxLength) return name
  const stripped = name.replace(/\s*•\s*Robinhood Token$/u, '').trim()
  return stripped
}

/**
 * Age rule: launched/graduated at least `minAgeDays` before `nowSeconds`.
 */
export function passesAge(eventTimestampSeconds, nowSeconds, criteria = MEMECOIN_CRITERIA) {
  return nowSeconds - eventTimestampSeconds >= criteria.minAgeDays * SECONDS_PER_DAY
}

/** Holder-count rule. */
export function passesHolders(holdersCount, criteria = MEMECOIN_CRITERIA) {
  return Number.isFinite(holdersCount) && holdersCount >= criteria.minHolders
}

/**
 * Liquidity rule. `quoteSideUsd` is the USD value of the quote-token
 * reserves sitting in the token's Uniswap v3 pool; total pool value is
 * approximated as twice that.
 */
export function passesLiquidity(quoteSideUsd, criteria = MEMECOIN_CRITERIA) {
  return Number.isFinite(quoteSideUsd) && quoteSideUsd * 2 >= criteria.minLiquidityUsd
}

/**
 * Anti-spoof rule: a memecoin may not reuse the symbol of a canonical
 * asset (any Stock Token ticker, USDG, or WETH). Case-insensitive.
 * @param {string} symbol
 * @param {Set<string>} reservedUpper upper-cased canonical symbols
 */
export function isSymbolSpoof(symbol, reservedUpper) {
  return reservedUpper.has(String(symbol).toUpperCase())
}

/**
 * Symbol-collision rule among memecoins that passed everything else:
 * keep the pool with the deepest quote-side liquidity; deterministic
 * tie-break on lowest address. Returns the surviving entries.
 * @param {{symbol: string, address: string, quoteSideUsd: number}[]} candidates
 */
export function resolveSymbolCollisions(candidates) {
  const bySymbol = new Map()
  for (const candidate of candidates) {
    const key = candidate.symbol.toUpperCase()
    const current = bySymbol.get(key)
    if (
      !current ||
      candidate.quoteSideUsd > current.quoteSideUsd ||
      (candidate.quoteSideUsd === current.quoteSideUsd &&
        candidate.address.toLowerCase() < current.address.toLowerCase())
    ) {
      bySymbol.set(key, candidate)
    }
  }
  const winners = new Set([...bySymbol.values()].map((c) => c.address.toLowerCase()))
  return {
    included: candidates.filter((c) => winners.has(c.address.toLowerCase())),
    excluded: candidates.filter((c) => !winners.has(c.address.toLowerCase())),
  }
}
