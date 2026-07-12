/**
 * 05 — Live launchpad stream to the console.
 *
 * Robinhood Chain has two pump.fun-style launchpads: NOXA (instant Uniswap v3
 * listing) and The Odyssey (native-ETH bonding curve that graduates to
 * Uniswap). This prints the recent launch history, then streams new launches
 * in real time until you Ctrl-C. Reads only.
 *
 * Run: node index.js [seconds]   (0 = stream forever; default 20)
 */
import { createHoodClient, getRecentLaunches, watchLaunches, MAINNET_EXPLORER_URL } from 'hoodchain'

const runSeconds = process.argv[2] !== undefined ? Number(process.argv[2]) : 20
const hood = createHoodClient()

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
const line = (l) =>
  `${l.launchpad.padEnd(7)} ${short(l.token)}  by ${short(l.creator)}  blk ${l.blockNumber}` +
  (l.pool ? `  pool ${short(l.pool)}` : '  (on curve)')

console.log('Recent launches (scanning back ~1M blocks)…')
const recent = await getRecentLaunches(hood, { lookbackBlocks: 1_000_000n, chunkSize: 50_000n })
if (recent.length === 0) {
  console.log('  none in range — the launchpads are quiet right now.')
} else {
  for (const l of recent.slice(-10)) console.log('  ' + line(l))
  console.log(`  … ${recent.length} launches total in range.`)
}

console.log(`\nStreaming new launches${runSeconds ? ` for ${runSeconds}s` : ' (Ctrl-C to stop)'}…`)
const unwatch = watchLaunches(
  hood,
  (l) => {
    console.log('  NEW ' + line(l))
    console.log(`      ${MAINNET_EXPLORER_URL}/token/${l.token}`)
  },
  { onError: (e) => console.error('  watch error (still polling):', e.message) },
)

const stop = () => {
  unwatch()
  console.log('\nStopped.')
  process.exit(0)
}
process.on('SIGINT', stop)
if (runSeconds > 0) setTimeout(stop, runSeconds * 1000)
