/**
 * 03 — Multiplier-correct Stock Token portfolio (the correctness showpiece).
 *
 * Robinhood Stock Tokens carry an ERC-8056 `uiMultiplier()` corporate-action
 * factor. Two mistakes generic trackers make:
 *
 *   1. Valuing at `balance × feedPrice × uiMultiplier` — double-counting the
 *      corporate action, because the Chainlink feed is ALREADY multiplier-
 *      adjusted. Correct value is `balance × feedPrice`.
 *   2. Reporting the raw ERC-20 balance as "shares" — after a split or
 *      reinvested dividend the true share-equivalent is
 *      `balance × uiMultiplier ÷ 1e18`, which diverges from the raw balance.
 *
 * `getPortfolio` returns BOTH numbers per position and sums only priced
 * holdings. One multicall sweeps all 95 tokens. Reads only.
 *
 * Run: node index.js [0xADDRESS]
 */
import { createHoodClient, getPortfolio } from 'hoodchain'

// A live on-chain holder by default (the TSLA/WETH Uniswap pool). Pass your own.
const DEFAULT_HOLDER = '0xA953CA88ff430e9487c60cA34d757414f4efdA07'
const owner = process.argv[2] || DEFAULT_HOLDER

if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  console.error(`Not an address: ${owner}\nusage: node index.js 0xADDRESS`)
  process.exit(1)
}

const hood = createHoodClient()
// 24/5 feeds pause on weekends; a week of tolerance avoids false "stale" over long weekends.
const portfolio = await getPortfolio(hood, owner, { maxAgeSeconds: 7 * 24 * 3600 })

console.log(`Stock Token portfolio — ${owner}\n`)

if (portfolio.positions.length === 0) {
  console.log('  No Stock Tokens held.')
  console.log('  (Try the default holder, or an address that has swapped for Stock Tokens.)')
  process.exit(0)
}

console.log('  SYMBOL        BALANCE       SHARE-EQUIV        VALUE')
console.log('  ' + '-'.repeat(58))
for (const p of portfolio.positions) {
  const value = p.valueUsd === null ? 'unpriced' : `$${p.valueUsd.toFixed(2)}`
  const drift = p.uiMultiplier === 10n ** 18n ? '' : '  ← corporate-action adjusted'
  console.log(
    `  ${p.symbol.padEnd(6)} ${p.balanceTokens.toFixed(6).padStart(14)} ${p.shareEquivalent.toFixed(6).padStart(16)} ${value.padStart(12)}${drift}`,
  )
}
console.log('  ' + '-'.repeat(58))
console.log(`  Total priced value: $${portfolio.totalUsd.toFixed(2)}`)
if (portfolio.unpricedSymbols.length) {
  console.log(`  Unpriced (no Chainlink feed yet): ${portfolio.unpricedSymbols.join(', ')}`)
}
