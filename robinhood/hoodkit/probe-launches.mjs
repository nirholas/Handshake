import { createHoodClient, getRecentLaunches, NOXA_ADDRESSES, ODYSSEY_ADDRESSES } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const launches = await getRecentLaunches(hood, { lookbackBlocks: 50000n })
console.log('launches found', launches.length)
// Check swap activity on the most recent few NOXA launches (instant pools)
const noxa = launches.filter(l => l.launchpad === 'noxa' && l.pool).slice(-10)
for (const l of noxa) {
  const logs = await hood.public.getLogs({
    address: l.pool,
    event: { type: 'event', name: 'Swap', inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount0', type: 'int256', indexed: false },
      { name: 'amount1', type: 'int256', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'liquidity', type: 'uint128', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
    ]},
    fromBlock: l.blockNumber,
    toBlock: head,
  })
  console.log('noxa token', l.token, 'pool', l.pool, 'launchBlock', l.blockNumber, 'swaps', logs.length)
}
