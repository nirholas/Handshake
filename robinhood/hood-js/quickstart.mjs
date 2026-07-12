// Run verbatim in a fresh folder: npm i hood-js && node quickstart.mjs
import hood from 'hood-js'

const { symbol, usd, updatedAt } = await hood.price('AAPL')
console.log(`${symbol}: $${usd} (updated ${updatedAt.toISOString()})`)

const top = await hood.coins({ limit: 5 })
console.log('\nTop 5 trending on Robinhood Chain:')
for (const c of top) console.log(`  ${c.symbol.padEnd(10)} $${c.priceUsd}  ${c.change24h}%`)

const q = await hood.quote({ sell: 'USDG', buy: 'WETH', amount: 100 })
console.log(`\n100 USDG → ${q.buyAmount} WETH (${q.route.length}-hop route)`)
