import { createHoodClient } from 'hoodchain'
import { discoverPools } from './dist/index.js'
import { listPricedStockTokens } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const tokens = listPricedStockTokens()
let anyFound = false
for (const t of tokens) {
  try {
    const pools = await discoverPools(hood, t.address)
    for (const p of pools) {
      const logs = await hood.public.getLogs({
        address: p.pool,
        event: { type: 'event', name: 'Swap', inputs: [
          { name: 'sender', type: 'address', indexed: true },
          { name: 'recipient', type: 'address', indexed: true },
          { name: 'amount0', type: 'int256', indexed: false },
          { name: 'amount1', type: 'int256', indexed: false },
          { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
          { name: 'liquidity', type: 'uint128', indexed: false },
          { name: 'tick', type: 'int24', indexed: false },
        ]},
        fromBlock: head - 200000n,
        toBlock: head,
      })
      if (logs.length > 0) {
        anyFound = true
        console.log(t.symbol, p.pool, 'fee', p.fee, 'swaps(200k blocks)=', logs.length, 'lastBlock', logs[logs.length-1].blockNumber)
      }
    }
  } catch (e) {}
}
console.log('anyFound', anyFound)
