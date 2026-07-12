import { createHoodClient } from 'hoodchain'
const hood = createHoodClient()
const TRANSFER = { type: 'event', name: 'Transfer', inputs: [
  { name: 'from', type: 'address', indexed: true },
  { name: 'to', type: 'address', indexed: true },
  { name: 'value', type: 'uint256', indexed: false },
]}
const token = '0xA80eb66b3E0CF66ccB46f8b8C9e7ff5803eEb820'
const head = await hood.public.getBlockNumber()
console.log('head', head)

for (const chunk of [5000n, 20000n, 50000n, 100000n]) {
  const t0 = Date.now()
  try {
    const logs = await hood.public.getLogs({ address: token, event: TRANSFER, fromBlock: head - chunk, toBlock: head })
    console.log('chunk', chunk, 'logs', logs.length, 'ms', Date.now()-t0)
  } catch (e) {
    console.log('chunk', chunk, 'ERROR', e.shortMessage || e.message?.slice(0,150))
  }
}
