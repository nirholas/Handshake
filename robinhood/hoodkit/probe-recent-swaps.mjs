import { createHoodClient, getRecentLaunches } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const launches = await getRecentLaunches(hood, { lookbackBlocks: 100000n, chunkSize: 10000n })
const noxa = launches.filter(l => l.launchpad === 'noxa' && l.pool)
console.log('noxa launches in last 100k blocks', noxa.length)

const SWAP = { type: 'event', name: 'Swap', inputs: [
  { name: 'sender', type: 'address', indexed: true },
  { name: 'recipient', type: 'address', indexed: true },
  { name: 'amount0', type: 'int256', indexed: false },
  { name: 'amount1', type: 'int256', indexed: false },
  { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
  { name: 'liquidity', type: 'uint128', indexed: false },
  { name: 'tick', type: 'int24', indexed: false },
]}

let best = null
for (const l of noxa.slice(-40)) {
  try {
    const logs = await hood.public.getLogs({ address: l.pool, event: SWAP, fromBlock: l.blockNumber, toBlock: head })
    console.log(l.token, l.pool, 'launchBlock', l.blockNumber, 'swaps', logs.length)
    if (!best || logs.length > best.count) best = { token: l.token, pool: l.pool, count: logs.length, launchBlock: l.blockNumber }
  } catch (e) { console.log('err', e.message?.slice(0,60)) }
}
console.log('BEST', best)
