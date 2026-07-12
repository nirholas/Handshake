// REAL testnet swap: wrap ETH → swap WETH → NFLX on chain 46630.
// Needs a funded ROBINHOOD_CHAIN_PRIVATE_KEY (see examples/README.md).
import hood from 'hood-js'

const pk = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY
if (!pk) {
  console.error('Set ROBINHOOD_CHAIN_PRIVATE_KEY to a funded testnet key first.')
  process.exit(1)
}

hood.testnet()

const q = await hood.quote({ sell: 'WETH', buy: 'NFLX', amount: '0.0001' })
console.log(`Quote: 0.0001 WETH → ${q.buyAmount} NFLX`)

const result = await hood.swap({ ...q, wallet: pk })
console.log(`Swapped! ${result.amountOut} NFLX received (min ${result.minReceived})`)
console.log(`Tx: ${result.url}`)
