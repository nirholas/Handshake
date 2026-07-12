import { createHoodClient, getRecentLaunches } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const launches = await getRecentLaunches(hood, { lookbackBlocks: 1000000n, chunkSize: 10000n })
console.log('launches found (1M blocks, ~36h)', launches.length)
console.log(launches.slice(-15))
