/**
 * Build a local SQLite index for a token: holders, OHLCV candles, and 24h
 * volume, computed from indexed swaps/transfers with zero RPC at query time.
 *
 * Run: npx tsx examples/index-token.ts [TOKEN_ADDRESS] [DEPLOY_BLOCK]
 *
 * Defaults to WEN ("Wen Lambo"), a NOXA-launched memecoin on mainnet, verified
 * live during development. Full holder history requires syncing from the
 * token's actual deployment block — pass one for any other token, or the
 * holder count will only reflect activity since block 0's chunked scan start.
 */
import { createHoodClient } from 'hoodchain'
import { createIndexer } from '../src/index.js'

const hood = createHoodClient()
const token = (process.argv[2] ?? '0xA80eb66b3E0CF66ccB46f8b8C9e7ff5803eEb820') as `0x${string}`
const deployBlock = process.argv[3] ? BigInt(process.argv[3]) : 4_774_733n

console.log(`Indexing ${token} from block ${deployBlock}...\n`)

const indexer = await createIndexer({
  client: hood,
  path: `/tmp/hoodkit-index-${token}.sqlite`,
  tokens: [token],
  chunkSize: 50_000n,
  throttleMs: 100,
})

const head = await hood.public.getBlockNumber()
const result = await indexer.sync({
  fromBlock: deployBlock,
  swapFromBlock: head - 50_000n, // full transfer history, recent swap window
  onProgress: (p) => process.stdout.write(`\r  syncing ${p.kind} @ ${p.toBlock}/${head}...   `),
})
console.log(`\n\nSynced: ${result.transfersIndexed} transfers, ${result.swapsIndexed} swaps, ${result.timestampsFetched} block timestamps.\n`)

const holders = indexer.holders(token)
console.log(`Holders: ${holders.length}`)
console.log('Top 5:')
for (const h of holders.slice(0, 5)) {
  console.log(`  ${h.address}  ${h.balanceFormatted.toLocaleString()} tokens`)
}

const candles = indexer.candles(token, '15m')
console.log(`\n15m candles (last ~${Math.round((50_000 * 0.13) / 60)} min of swaps): ${candles.length}`)
for (const c of candles.slice(-5)) {
  console.log(`  ${new Date(c.time * 1000).toISOString()}  O ${c.open.toFixed(6)} H ${c.high.toFixed(6)} L ${c.low.toFixed(6)} C ${c.close.toFixed(6)}  vol ${c.volume.toFixed(2)}`)
}

const now = Number((await hood.public.getBlock({ blockNumber: head })).timestamp)
console.log(`\n24h volume (token units): ${indexer.volume24h(token, now).toLocaleString()}`)

indexer.close()
