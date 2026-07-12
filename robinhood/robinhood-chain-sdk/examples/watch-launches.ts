/**
 * Watch NOXA and The Odyssey for new memecoin launches in real time,
 * and print recent history first. No wallet or key needed.
 *
 * Run: npx tsx examples/watch-launches.ts
 */
import { createHoodClient, getRecentLaunches, watchLaunches, watchGraduations } from 'hoodchain'

const hood = createHoodClient()

console.log('recent launches (last ~2h of blocks):')
const recent = await getRecentLaunches(hood, { lookbackBlocks: 60_000n })
for (const l of recent.slice(-10)) {
  console.log(`  [${l.launchpad}] token ${l.token} by ${l.creator}${l.pool ? ` pool ${l.pool}` : ' (on curve)'}`)
}
console.log(`  (${recent.length} total)\n`)

console.log('watching for new launches — Ctrl-C to stop')
const unwatchLaunches = watchLaunches(hood, (launch) => {
  const venue = launch.launchpad === 'noxa' ? 'NOXA (instant pool)' : 'Odyssey (bonding curve)'
  console.log(`LAUNCH ${venue}: ${launch.token} by ${launch.creator} — tx ${launch.transactionHash}`)
})
const unwatchGraduations = watchGraduations(hood, (g) => {
  console.log(`GRADUATION: ${g.token} → Uniswap v3 pool ${g.pool} — tx ${g.transactionHash}`)
})

process.on('SIGINT', () => {
  unwatchLaunches()
  unwatchGraduations()
  process.exit(0)
})
