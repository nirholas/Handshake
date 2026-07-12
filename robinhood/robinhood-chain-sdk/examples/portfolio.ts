/**
 * Multiplier-correct Stock Token portfolio for any address.
 * No wallet or key needed — public RPC reads only.
 *
 * Run: npx tsx examples/portfolio.ts 0xYourAddress
 */
import type { Address } from 'viem'
import { createHoodClient, getPortfolio } from 'hoodchain'

const owner = process.argv[2] as Address | undefined
if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  console.error('usage: npx tsx examples/portfolio.ts 0xADDRESS')
  process.exit(1)
}

const hood = createHoodClient()
const portfolio = await getPortfolio(hood, owner, { maxAgeSeconds: 7 * 24 * 60 * 60 })

if (portfolio.positions.length === 0) {
  console.log(`${owner} holds no Stock Tokens.`)
  process.exit(0)
}

console.log(`Stock Token portfolio for ${owner}\n`)
for (const p of portfolio.positions) {
  const value = p.valueUsd === null ? 'unpriced (no feed)' : `$${p.valueUsd.toFixed(2)}`
  console.log(
    `${p.symbol.padEnd(6)} ${p.balanceTokens.toFixed(6).padStart(16)} tokens  ` +
      `= ${p.shareEquivalent.toFixed(6).padStart(16)} share-equivalents  ${value}`,
  )
}
console.log(`\nTotal priced value: $${portfolio.totalUsd.toFixed(2)}`)
if (portfolio.unpricedSymbols.length) {
  console.log(`Unpriced holdings (no Chainlink feed yet): ${portfolio.unpricedSymbols.join(', ')}`)
}
