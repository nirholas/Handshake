import { createHoodClient } from 'hoodchain'
import { loadPoolInfo } from './dist/index.js'

const hood = createHoodClient()
const pool = '0x3F98045d6bc0fEF56bf69E85F1efA7F5100e7c48'
const info = await loadPoolInfo(hood, pool)
console.log(info)

const head = await hood.public.getBlockNumber()
const SWAP = { type: 'event', name: 'Swap', inputs: [
  { name: 'sender', type: 'address', indexed: true },
  { name: 'recipient', type: 'address', indexed: true },
  { name: 'amount0', type: 'int256', indexed: false },
  { name: 'amount1', type: 'int256', indexed: false },
  { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
  { name: 'liquidity', type: 'uint128', indexed: false },
  { name: 'tick', type: 'int24', indexed: false },
]}
const logs = await hood.public.getLogs({ address: pool, event: SWAP, fromBlock: head - 2000n, toBlock: head })
console.log('swaps in last 2000 blocks (~4.3 min):', logs.length)
