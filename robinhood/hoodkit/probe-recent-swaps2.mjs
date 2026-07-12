import { createHoodClient, getRecentLaunches } from 'hoodchain'

const hood = createHoodClient()
const head = await hood.public.getBlockNumber()
console.log('head', head)

const launches = await getRecentLaunches(hood, { lookbackBlocks: 1000000n, chunkSize: 10000n })
const noxa = launches.filter(l => l.launchpad === 'noxa' && l.pool).sort((a,b)=> a.blockNumber < b.blockNumber ? 1 : -1)
console.log('total noxa', noxa.length)
console.log('most recent 10 blockNumbers:', noxa.slice(0,10).map(l=>l.blockNumber.toString()))
console.log('gap from head:', (head - noxa[0].blockNumber).toString(), 'blocks')

const odyssey = launches.filter(l => l.launchpad === 'odyssey').sort((a,b)=> a.blockNumber < b.blockNumber ? 1 : -1)
console.log('total odyssey', odyssey.length)
if (odyssey.length) console.log('most recent odyssey blockNumbers:', odyssey.slice(0,10).map(l=>l.blockNumber.toString()))
