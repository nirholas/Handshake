Robinhood Chain moves fast — ~100ms blocks, hundreds of transactions per second at peak. This tutorial covers the two ways to watch it live: **confirmed event streams** (launchpad watchers, the pattern you'll use for almost everything) and the **raw sequencer firehose** (transactions decoded before they're even in a block). Both examples below are real captures against mainnet.

## Two memecoin launchpads, two designs

Robinhood Chain is permissionless (Tutorial 1), and two launchpads have grown on top of it, with genuinely different mechanics:

- **NOXA** — an *instant* launcher. One transaction deploys the ERC-20, creates a Uniswap v3 pool at the 1% tier, seeds single-sided liquidity, and permanently locks the LP NFT. There's no bonding curve and no graduation — the token trades as a normal Uniswap v3 pool from block one.
- **The Odyssey** — a *pump.fun-style bonding curve*, priced in native ETH with virtual reserves. Trades happen against the curve (`Traded` events) until it fills, at which point `PoolCompleted` + `PoolMigrated` fire and liquidity moves to a locked Uniswap v3 pool — the "graduation" moment.

The [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) ships decoded event ABIs and watcher functions for both, extracted from each platform's frontend bundle and confirmed against live logs during SDK development (neither publishes verified source on Blockscout, so this took direct log inspection rather than an ABI download).

## Watching for new launches

```ts
import { createHoodClient, getRecentLaunches, watchLaunches, watchGraduations } from 'hoodchain'

const hood = createHoodClient()

console.log('recent launches (last ~2h of blocks):')
const recent = await getRecentLaunches(hood, { lookbackBlocks: 60_000n })
for (const l of recent.slice(-10)) {
  console.log(`  [${l.launchpad}] token ${l.token} by ${l.creator}${l.pool ? ` pool ${l.pool}` : ' (on curve)'}`)
}
console.log(`  (${recent.length} total)\n`)

const unwatchLaunches = watchLaunches(hood, (launch) => {
  const venue = launch.launchpad === 'noxa' ? 'NOXA (instant pool)' : 'Odyssey (bonding curve)'
  console.log(`LAUNCH ${venue}: ${launch.token} by ${launch.creator} — tx ${launch.transactionHash}`)
})
const unwatchGraduations = watchGraduations(hood, (g) => {
  console.log(`GRADUATION: ${g.token} → Uniswap v3 pool ${g.pool} — tx ${g.transactionHash}`)
})
```

Running `getRecentLaunches` with the default 30,000-block lookback (roughly the last hour) against live mainnet returned **zero** launches at the time of writing — both launchpads were genuinely quiet in that window. That's a real, useful data point about the current state of the ecosystem, not a bug: widening the scan confirms the watcher logic itself is correct.

### Proving the decoder works: a historical scan

To confirm `getRecentLaunches` actually decodes NOXA's `TokenLaunched` event correctly (rather than just returning zero because nothing happened), scan the 9,000 blocks starting at NOXA's own recorded deploy block:

```ts
import { createHoodClient, NOXA_ADDRESSES, noxaTokenLaunchedEvent } from 'hoodchain'

const hood = createHoodClient()
const logs = await hood.public.getLogs({
  address: NOXA_ADDRESSES.launchFactory,
  event: noxaTokenLaunchedEvent,
  fromBlock: NOXA_ADDRESSES.deployBlock,
  toBlock: NOXA_ADDRESSES.deployBlock + 9000n,
})
console.log(`TokenLaunched logs near deploy: ${logs.length}`)
console.log(`first token: ${logs[0].args.token}`)
```

```text
TokenLaunched logs near deploy: 21
first token: 0x6399E2Bd8af62C0ac13f55613C3469b67332a6Fd
```

Real result: **21 launches**, decoded correctly, first token address included. The watcher works; the launchpads have simply had quiet stretches. This is a useful verification technique generally — when a live "recent activity" query returns zero, don't assume it's broken; confirm the decoder against a window you know had activity before you trust the "quiet" result.

:::warning The public RPC rate-limits wide scans
Scanning a **million-block** window (`lookbackBlocks: 1_000_000n`) against the public RPC returned a real `429 Too Many Requests` from `eth_getLogs` during testing — even with `getRecentLaunches`'s built-in chunking (`chunkSize`, default 10,000 blocks per request). For anything beyond a rough "last hour or two" scan, use a dedicated RPC key (Tutorial 2) or narrow your chunk size further.
:::

## The raw sequencer firehose

Confirmed-event watching (above) is what you want for almost everything — it's simple and it's what block explorers show. But Robinhood Chain also publishes its **Arbitrum Nitro sequencer feed** directly: every transaction the sequencer accepts, decoded, **~100–300ms before it's queryable over RPC**. That latency matters for MEV-sensitive or ultra-low-latency use cases; for everyone else it's a fascinating window into how much traffic the chain actually carries.

```ts
import { subscribeFeed } from 'hoodchain'
import { formatEther } from 'viem'

let messages = 0
let txs = 0
const startedAt = Date.now()

const sub = await subscribeFeed(
  (msg) => {
    messages += 1
    for (const tx of msg.transactions) {
      txs += 1
      const t = tx.transaction
      console.log(`${tx.hash}  ->${t.to ?? '(create)'}`)
    }
  },
  { onConnect: () => console.log('connected.') },
)

setTimeout(() => {
  sub.close()
  const rate = (txs / ((Date.now() - startedAt) / 1000)).toFixed(1)
  console.log(`${messages} messages, ${txs} txs in ${((Date.now() - startedAt) / 1000).toFixed(0)}s (${rate} tx/s)`)
}, 12_000)
```

A real 12-second capture against `wss://feed.mainnet.chain.robinhood.com`:

```text
connected.
0xcbadb5925ef1f8716a52ee6caefb01c5b4aa226dd815777f6dff3c00f2f15d35  ->0x00bfd5004d8503007c007bfb7500158500f90052
0x1f5a5d2b62a57cbe6eb4795fbda6e90e8da17c979877203785b323680cd95def  ->0x77afb8cb800bd0688c78a3ca322226b4f1401e3a
0xebf02e0e86381a389a287caba0b23dfac44b7d1d2c17d8105584c9da3b413d17  ->0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc
...
979 messages, 6451 txs in 12s (537.6 tx/s)
```

**6,451 real transactions in 12 seconds** — over 500 tx/s sustained. That number alone tells you Robinhood Chain is carrying meaningfully more traffic than a quiet L2; at ~100ms blocks, that's roughly 50+ transactions landing in every block. If your mental model of activity on this chain came from watching a slow block explorer feed, the firehose is a useful correction.

### How the decoding works

The sequencer publishes frames matching the Nitro broadcast feed shape: a header (kind, sender, L1 block number, timestamp) plus a base64 `l2Msg` payload. The first byte of the decoded payload is the message kind — `0x04` (`SignedTx`: the rest is one raw RLP/typed transaction) or `0x03` (`Batch`: a sequence of length-prefixed nested L2 messages, decoded recursively). `subscribeFeed` handles both, reconnects with exponential backoff on drops, and — critically — **never throws on an unparseable payload**; malformed or unrecognized frames simply decode to zero transactions rather than crashing your stream.

```ts
// simplified from the SDK's feed.ts — the kind-byte dispatch
const kind = bytes[0]
if (kind === 0x04) return [decodeSignedTx(bytes.subarray(1))]
if (kind === 0x03) return decodeBatch(bytes.subarray(1))  // recurses per nested message
return [] // unknown kind — never throw
```

:::tip No auth, no key, works in the browser too
The firehose endpoint needs no authentication. On Node ≥ 22 and in browsers it uses the global `WebSocket`; on Node 20/21 install the optional `ws` peer dependency (`npm install ws`).
:::

## A simpler alternative: watching confirmed transfers

Not every use case needs launchpad decoding or firehose-level latency. For "notify me when this token moves," `watchTransfers` polls confirmed `Transfer` logs — the simplest possible event stream:

```ts
import { watchTransfers, MAINNET_ADDRESSES, formatUsdg } from 'hoodchain'

const unwatch = watchTransfers(hood, { token: MAINNET_ADDRESSES.usdg }, (t) => {
  console.log(`${t.from} -> ${t.to}: ${formatUsdg(t.value)} USDG`)
})
```

## Troubleshooting

**`getRecentLaunches` returns 0 and I don't trust it** — widen the window, or run the historical-scan verification above against `NOXA_ADDRESSES.deployBlock`. Zero is a legitimate answer when the launchpads are quiet.

**`429 Too Many Requests` from `eth_getLogs`** — you're scanning too wide a block range on the public RPC. Shrink `lookbackBlocks`, shrink `chunkSize`, or move to a dedicated RPC (Tutorial 2).

**Firehose connects then immediately disconnects repeatedly** — check `onError` in your `subscribeFeed` options; the client backs off exponentially (capped at 30s) and gives up after `maxReconnects` (default 10). A flaky network will show this pattern; a genuinely down feed will exhaust the retries and call `onError` with a `FeedConnectionError`.

**`no WebSocket implementation available`** — you're on Node < 22 without the `ws` package. Run `npm install ws`.

## What you built

Two live streams against real mainnet traffic: a launch/graduation watcher (verified against 21 real historical NOXA launches) and a raw firehose clocking over 500 tx/s. You also hit and worked around a real RPC rate limit — a lesson that'll save you time on any wide historical scan. Next, we turn read access into revenue: selling your own API for USDG.
