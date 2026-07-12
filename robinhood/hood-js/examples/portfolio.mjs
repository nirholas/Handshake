import hood from 'hood-js'

const address = process.argv[2]
if (!address) {
  console.error('Usage: node examples/portfolio.mjs 0xADDRESS')
  process.exit(1)
}

const { totalUsd, positions, unpriced } = await hood.portfolio(address)
console.log(`Portfolio for ${address}: $${totalUsd.toFixed(2)}\n`)
for (const p of positions) {
  console.log(`${p.symbol}: ${p.tokens} tokens (${p.shares} shares) = $${p.usd?.toFixed(2) ?? '—'}`)
}
if (unpriced.length) console.log(`\nUnpriced (no feed): ${unpriced.join(', ')}`)
