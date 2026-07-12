import { createHoodClient } from 'hoodchain'
import { discoverPools } from './dist/index.js'
import { listPricedStockTokens } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const tokens = listPricedStockTokens().slice(0, 15)
for (const t of tokens) {
  try {
    const pools = await discoverPools(hood, t.address)
    if (pools.length === 0) continue
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
        fromBlock: head - 20000n,
        toBlock: head,
      })
      console.log(t.symbol, p.pool, 'fee', p.fee, 'swaps(last 20k blocks)=', logs.length)
    }
  } catch (e) {
    console.log(t.symbol, 'error', e.message?.slice(0,80))
  }
}
