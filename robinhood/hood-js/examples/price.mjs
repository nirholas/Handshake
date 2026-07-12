import hood from 'hood-js'

const symbols = process.argv.slice(2)
if (symbols.length === 0) symbols.push('AAPL', 'TSLA', 'NVDA')

const results = symbols.length === 1 ? [await hood.price(symbols[0])] : await hood.prices(symbols)

for (const r of results) {
  console.log(r.usd === null ? `${r.symbol}: unpriced (no feed)` : `${r.symbol}: $${r.usd}`)
}
