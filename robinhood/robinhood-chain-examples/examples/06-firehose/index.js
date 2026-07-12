/**
 * 06 — Sequencer firehose → filtered event stream.
 *
 * Robinhood Chain publishes its Arbitrum Nitro sequencer feed at
 * wss://feed.mainnet.chain.robinhood.com. `subscribeFeed` decodes each frame
 * into viem transactions ~100-300ms BEFORE they're queryable over RPC. This
 * prints a live tally and a sample of decoded transactions, optionally filtered
 * to those touching a given address (contract or wallet). Reads only.
 *
 * Run:
 *   node index.js               # 15s of everything
 *   node index.js 0             # stream forever (Ctrl-C)
 *   node index.js 30 0x5fc5...  # 30s, only txs to/from this address (e.g. USDG)
 */
import { subscribeFeed } from 'hoodchain'

const runSeconds = process.argv[2] !== undefined ? Number(process.argv[2]) : 15
const filterAddr = (process.argv[3] || '').toLowerCase()

let frames = 0
let txCount = 0
let shown = 0
const SHOW_LIMIT = 12

const matches = (tx) => {
  if (!filterAddr) return true
  const to = (tx.transaction.to || '').toLowerCase()
  return to === filterAddr
}

console.log(`Connecting to the sequencer firehose${filterAddr ? ` (filter: ${filterAddr})` : ''}…`)

const sub = await subscribeFeed(
  (msg) => {
    frames++
    for (const tx of msg.transactions) {
      txCount++
      if (shown < SHOW_LIMIT && matches(tx)) {
        shown++
        const t = tx.transaction
        const val = t.value ? Number(t.value) / 1e18 : 0
        console.log(
          `  seq ${String(msg.sequenceNumber).padStart(9)}  ${tx.hash.slice(0, 18)}…  ` +
            `to ${t.to ?? '(contract create)'}  ${val ? val.toFixed(6) + ' ETH' : ''}`,
        )
      }
    }
  },
  {
    onConnect: () => console.log('Connected. Decoding L2 messages as they stream…\n'),
    onError: (e) => console.error('  feed error (auto-reconnecting):', e.message),
  },
)

const stop = () => {
  sub.close()
  console.log(`\n${frames} frames, ${txCount} transactions decoded${filterAddr ? ` (${shown} matched the filter)` : ''}.`)
  process.exit(0)
}
process.on('SIGINT', stop)
if (runSeconds > 0) setTimeout(stop, runSeconds * 1000)
