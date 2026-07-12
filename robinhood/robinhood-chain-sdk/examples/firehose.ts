/**
 * Stream the sequencer firehose: every transaction Robinhood Chain's
 * sequencer publishes, decoded ~100–300ms before it is queryable over RPC.
 * No wallet or key needed.
 *
 * Run: npx tsx examples/firehose.ts
 */
import { formatEther } from 'viem'
import { subscribeFeed } from 'hoodchain'

let messages = 0
let txs = 0
const startedAt = Date.now()

console.log('connecting to wss://feed.mainnet.chain.robinhood.com — Ctrl-C to stop')
const sub = await subscribeFeed(
  (msg) => {
    messages += 1
    for (const tx of msg.transactions) {
      txs += 1
      const t = tx.transaction
      const value = 'value' in t && t.value ? ` value ${formatEther(t.value)} ETH` : ''
      console.log(`${tx.hash}  →${t.to ?? '(create)'}${value}`)
    }
    if (messages % 500 === 0) {
      const rate = (txs / ((Date.now() - startedAt) / 1000)).toFixed(1)
      console.log(`--- ${messages} feed messages, ${txs} txs decoded (${rate} tx/s) ---`)
    }
  },
  { onConnect: () => console.log('connected.'), onError: (e) => console.error('feed error:', e.message) },
)

process.on('SIGINT', () => {
  sub.close()
  console.log(`\n${messages} messages, ${txs} transactions in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
  process.exit(0)
})
