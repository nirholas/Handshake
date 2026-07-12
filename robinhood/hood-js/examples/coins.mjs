import hood from 'hood-js'

const top = await hood.coins({ limit: 10 })
console.log('Trending on Robinhood Chain (24h):\n')
for (const c of top) {
  const arrow = (c.change24h ?? 0) >= 0 ? '▲' : '▼'
  console.log(`${c.symbol.padEnd(10)} $${c.priceUsd.toPrecision(4).padStart(12)}  ${arrow} ${c.change24h}%  vol $${c.volume24hUsd?.toFixed(0)}`)
}
