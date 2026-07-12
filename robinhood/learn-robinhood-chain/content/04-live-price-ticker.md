Time to build something that runs. A live price ticker is the "hello world" of market data: it reads prices, formats them, and refreshes. By the end you'll have a terminal that streams multiplier-adjusted Chainlink quotes for any Stock Token — and you'll have handled the two things beginners skip, staleness and unpriced tokens.

## The naive version (and why we won't ship it)

You *could* read a Chainlink feed directly and print the answer:

```ts
import { createHoodClient } from 'hoodchain'
const hood = createHoodClient()
const [, answer] = await hood.public.readContract({
  address: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', // AAPL feed
  abi: [{ name: 'latestRoundData', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [{type:'uint80'},{type:'int256'},{type:'uint256'},{type:'uint256'},{type:'uint80'}] }],
  functionName: 'latestRoundData',
})
console.log(Number(answer) / 1e8)
```

This works, but it hardcodes an address, ignores whether the round is complete, and will happily print a price from a feed that hasn't updated in a month. We can do better in the same number of lines.

## The real ticker

`getQuote` from the [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) does the address lookup, the multiplier-correct interpretation, the staleness guard, and the answer validation. Create `ticker.ts`:

```ts
import { createHoodClient, getQuote, listPricedStockTokens, FeedNotFoundError, StaleFeedError } from 'hoodchain'

const hood = createHoodClient()

// symbols from argv, or a sensible default set
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL', 'TSLA', 'NVDA', 'SPY']

// stock feeds update 24/5 — a week-wide window means weekend runs don't throw
const maxAgeSeconds = 7 * 24 * 60 * 60

async function tick() {
  const rows = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const q = await getQuote(hood, symbol, { maxAgeSeconds })
        const age = (q.ageSeconds / 3600).toFixed(1)
        return `${symbol.padEnd(6)} $${q.priceUsd.toFixed(2).padStart(10)}   (feed ${age}h old)`
      } catch (e) {
        if (e instanceof FeedNotFoundError) return `${symbol.padEnd(6)} ${'no feed'.padStart(11)}`
        if (e instanceof StaleFeedError) return `${symbol.padEnd(6)} ${'stale'.padStart(11)}`
        return `${symbol.padEnd(6)} ${'error'.padStart(11)}`
      }
    }),
  )
  // redraw in place
  process.stdout.write('\x1b[2J\x1b[H')
  console.log(`Robinhood Chain — ${listPricedStockTokens().length} priced Stock Tokens · ${new Date().toLocaleTimeString()}\n`)
  console.log(rows.join('\n'))
}

await tick()
setInterval(tick, 15_000) // feeds don't move every second; 15s is plenty
```

Run it:

```bash
npx tsx ticker.ts AAPL TSLA NVDA SPY
```

```text
Robinhood Chain — 34 priced Stock Tokens · 12:18:41 PM

AAPL   $    315.50   (feed 41.2h old)
TSLA   $    407.82   (feed 40.4h old)
NVDA   $    210.19   (feed 44.0h old)
SPY    $    753.62   (feed 44.1h old)
```

Those are real prices, pulled live while writing this. The feed ages are ~40 hours because this run happened over a weekend — the market was closed, the feeds paused, and our 7-day window correctly accepted them instead of throwing. That's the staleness handling from Tutorial 3, doing its job in production.

:::tip Every design decision here is deliberate
- **15-second interval, not 1s.** Chainlink stock feeds update on the order of minutes to hours, gated by a heartbeat and a deviation threshold. Polling every second just wastes RPC calls to see the same number.
- **`Promise.all`, not a loop.** All symbols are fetched concurrently; the ticker's latency is one RPC round-trip, not N of them.
- **Typed catches.** `FeedNotFoundError` and `StaleFeedError` are distinct outcomes with distinct UI — "no feed" is permanent, "stale" is temporary. Never collapse them into a generic "error."
:::

## Add the multiplier, for context

Users like to see share-equivalents. Remember the Tutorial 3 rule: the multiplier is for *display*, never for the dollar math. Add it as a separate column:

```ts
import { getMultiplier } from 'hoodchain'

const [q, m] = await Promise.all([getQuote(hood, symbol, { maxAgeSeconds }), getMultiplier(hood, symbol)])
const shares = m === null ? 'n/a' : (Number(m) / 1e18).toFixed(4)
console.log(`${symbol}  $${q.priceUsd.toFixed(2)}  (1 token = ${shares} shares)`)
```

For the mega-cap tickers above, the multiplier is `1.0000` — no corporate action since the token launched. When one does have a split or dividend, this column is where you'd surface it, while your USD math stays untouched.

## A browser version (no backend needed)

Everything here works client-side too — that's how this site's [home-page ticker](../) runs. In a browser you'd skip the SDK's Node bits and hit the RPC with `fetch`, decoding `latestRoundData()` yourself (the answer is the second 32-byte word of the response). The [`ticker.js`](https://github.com/nirholas/learn-robinhood-chain/blob/main/assets/ticker.js) on this very site is a complete, dependency-free reference for that — read it if you want the raw JSON-RPC version.

## Troubleshooting

**Every symbol prints `stale`** — your `maxAgeSeconds` is too tight for the current time (weekend/holiday). Widen it. During market hours you can go as tight as the feed's heartbeat.

**`UnknownSymbolError`** — the ticker you passed isn't in the registry. Symbols are case-insensitive tickers as listed on-chain. Run `listStockTokens()` to see all 95, or `listPricedStockTokens()` for the priceable ones.

**Screen flicker on redraw** — the `\x1b[2J\x1b[H` clear-and-home is crude but portable. For a polished TUI, reach for a library like `blessed` or `ink`; for a learning ticker, the escape codes are fine.

**`429 Too Many Requests`** — you're on the public RPC and polling too hard, or running several scripts at once. Raise the interval or switch to an Alchemy endpoint (Tutorial 2).

## What you built

A real, live, multiplier-correct price ticker with proper staleness and unpriced-token handling — the market-data foundation every other app in this course builds on. Next, we take reads a step further: valuing an entire portfolio in a single call, and getting it *right* where naive trackers get it wrong.
