# hood-js

**The five-lines-to-your-first-trade wrapper for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

One import, sensible defaults, promise-first, browser and Node. Built on top of
[`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) — think `axios` to its `http`.

```js
import hood from 'hood-js'

const { usd } = await hood.price('AAPL')
console.log(`AAPL: $${usd}`)
```

No RPC URL, no chain config, no ABI. Public RPC by default. Read calls (`price`, `prices`,
`portfolio`, `coins`, `launches`, `quote`) need nothing at all — no wallet, no key. Only
`swap` needs one.

Docs + live in-browser demo: **https://nirholas.github.io/hood-js/**

## Install

```bash
npm install hood-js viem
```

Node ≥ 20, or any modern browser via a bundler / `<script type="module">` CDN import.
Until the package is on npm, install from a checkout: `npm i ../hood-js`.

## 30-second quickstart

Save as `quickstart.mjs`, run with `node quickstart.mjs` — this is verbatim what ships in
the repo root.

```js
import hood from 'hood-js'

const { symbol, usd, updatedAt } = await hood.price('AAPL')
console.log(`${symbol}: $${usd} (updated ${updatedAt.toISOString()})`)

const top = await hood.coins({ limit: 5 })
console.log('\nTop 5 trending on Robinhood Chain:')
for (const c of top) console.log(`  ${c.symbol.padEnd(10)} $${c.priceUsd}  ${c.change24h}%`)

const q = await hood.quote({ sell: 'USDG', buy: 'WETH', amount: 100 })
console.log(`\n100 USDG → ${q.buyAmount} WETH (${q.route.length}-hop route)`)
```

## API reference

Every function is async (except `config`/`testnet`/`mainnet`, which are synchronous and
chainable) and throws a single [`HoodError`](#errors) on failure — never a raw viem error.

| Call | Returns | Needs a wallet? |
| --- | --- | --- |
| `hood.price(symbol)` | `{ symbol, usd, updatedAt }` — live Chainlink price for one Stock Token | no |
| `hood.prices([symbols])` | `Price[]` in the same order, one batched multicall | no |
| `hood.portfolio(address)` | `{ owner, totalUsd, positions[], unpriced[] }` — multiplier-correct, USD-valued | no |
| `hood.coins({ limit?, window? })` | `TrendingCoin[]` — live memecoin prices + 24h stats (launchpads + Uniswap) | no |
| `hood.launches({ live?, launchpad?, lookbackBlocks? }, cb?)` | recent launches (Promise) or a live stream (pass `cb`, get an unwatch fn back) | no |
| `hood.quote({ sell, buy, amount })` | a `Quote` — spread it into `swap()` | no |
| `hood.swap({ ...quote, wallet })` | `{ hash, url, sold, bought, amountOut, minReceived, status }` | **yes** |
| `hood.config({ rpcUrl?, alchemyKey?, acknowledgeEligibility?, geckoNetwork? })` | `hood` (chainable) | — |
| `hood.testnet()` / `hood.mainnet()` | `hood` (chainable) — switches every subsequent call | — |

`sell` / `buy` accept a Stock Token ticker (`'AAPL'`, case-insensitive), `'USDG'` / `'WETH'`
/ `'ETH'`, or any `0x…` token address (memecoins included).

### `price` / `prices`

```js
const aapl = await hood.price('AAPL')
// { symbol: 'AAPL', usd: 315.5, updatedAt: 2026-07-10T19:04:34.000Z }

const [aapl2, tsla, nvda] = await hood.prices(['AAPL', 'TSLA', 'NVDA'])
```

Symbols with no live Chainlink feed come back as `{ usd: null, updatedAt: null }` in
`prices()` rather than throwing — only `price()` on a single unpriced symbol throws
(`NO_FEED`), so a batch of many tickers never fails wholesale over one bad one.

### `portfolio`

```js
const { totalUsd, positions } = await hood.portfolio('0xYourAddress')
for (const p of positions) {
  console.log(`${p.symbol}: ${p.tokens} tokens (${p.shares} shares) → $${p.usd}`)
}
```

`shares` is the ERC-8056 multiplier-corrected share-equivalent (splits/dividends aware);
`tokens` is the raw balance. Positions with no live feed report `usd: null` and are also
listed in `unpriced`.

### `coins`

```js
const top = await hood.coins({ limit: 10, window: '24h' })
// [{ symbol: 'CASHCAT', priceUsd: 0.174, change24h: -15.6, volume24hUsd: 28937451, ... }]
```

Aggregated across NOXA, The Odyssey, and every indexed Uniswap pool by GeckoTerminal's
public onchain API (no key required). `window` is `'5m' | '1h' | '6h' | '24h'`.

### `launches`

```js
// Recent history
const recent = await hood.launches({ lookbackBlocks: 30_000n }) // ~1h of blocks

// Live stream
const stop = hood.launches({ live: true }, (coin) => {
  console.log(`${coin.launchpad}: ${coin.token} by ${coin.creator}`)
})
// later: stop()
```

Backed directly by on-chain `TokenLaunched` (NOXA) / `TokenCreated` (The Odyssey) events —
not a generic "new pool" feed, which would double-count re-listings and different fee-tier
pools for the same token. **Both launchpads are real and independently verified** (NOXA
alone has produced 60,000+ launches since deploy), but either can go quiet for hours at a
time — an empty array is a legitimate result, not an error.

### `quote` / `swap`

```js
const q = await hood.quote({ sell: 'USDG', buy: 'CASHCAT', amount: 100 })
console.log(`Get ${q.buyAmount} CASHCAT`)

const { hash, url } = await hood.swap({ ...q, wallet: process.env.PK })
console.log(`Done: ${url}`)
```

`quote` probes every Uniswap v3 fee tier plus two-hop routes via WETH/USDG and picks the
best output — the same routing `hoodchain` implements. **Only Uniswap v3 liquidity is
reachable this way**: a coin trading solely on a v2 or v4 pool (some of `coins()`'s results
are) has no route through `quote`/`swap` and throws `NO_ROUTE`; likewise a v3 pool can have
real 24h price action on very thin depth and reject a given amount. Both are real,
observed on-chain conditions, not bugs — retry with a smaller amount or a different pair.

`wallet` is either a `0x`-prefixed private key (Node — read from an env var, never hardcode
one) or an injected EIP-1193 provider (browser — e.g. `window.ethereum`). Token approvals
are handled automatically.

**Stock Token eligibility.** Stock Tokens are tokenized debt securities (issuer: Robinhood
Assets (Jersey) Ltd) and may not be offered, sold, or delivered to US persons (additional
limits: Canada, UK, Switzerland). Buying one throws `NEEDS_ELIGIBILITY` until you call:

```js
hood.config({ acknowledgeEligibility: true })
```

This is the operator's affirmation of eligibility — set it only if true. Selling a Stock
Token, holding one, and reading any Stock Token data are never gated. Memecoins are never
gated either way.

### Config

```js
hood.config({
  rpcUrl: 'https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY', // custom RPC
  alchemyKey: 'YOUR_KEY',          // shorthand — builds the URL above for mainnet
  acknowledgeEligibility: true,     // see above
  geckoNetwork: 'robinhood',        // GeckoTerminal slug used by coins()
})

hood.testnet() // chain 46630 for every following call
hood.mainnet() // back to chain 4663
```

All three are chainable and return `hood`.

## Testnet guide

```js
hood.testnet()
const q = await hood.quote({ sell: 'WETH', buy: 'NFLX', amount: '0.0001' })
const result = await hood.swap({ ...q, wallet: process.env.ROBINHOOD_CHAIN_PRIVATE_KEY })
```

Testnet (chain 46630) has a fixed faucet-dripped Stock Token set — `TSLA`, `AMZN`, `PLTR`,
`NFLX`, `AMD` — plus `USDG`/`WETH`. No official Uniswap exists there; the SDK routes
through the one liquid community pool (NFLX/WETH). Fund a key at
[faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/) (0.01 ETH
+ five of each test Stock Token, once per 24h, browser-only — Cloudflare Turnstile + Google
Sign-In, so it can't be automated headlessly).

## Errors

Every failure is a `HoodError` — plain-language `message`, a stable `code`, and the
original error on `cause`:

```js
import hood, { HoodError } from 'hood-js'

try {
  await hood.price('NOTREAL')
} catch (err) {
  if (err instanceof HoodError) console.log(err.code) // 'UNKNOWN_SYMBOL'
}
```

| Code | When |
| --- | --- |
| `UNKNOWN_SYMBOL` | Ticker isn't a canonical Stock Token |
| `NO_FEED` | Token exists but has no live Chainlink price feed |
| `STALE_PRICE` | Feed answer older than the staleness window (rare — 72h default tolerates the 24/5 weekend gap) |
| `BAD_PRICE` | Feed returned a non-positive or incomplete answer |
| `NO_ROUTE` | No swappable Uniswap v3 route/liquidity between the two tokens |
| `NEEDS_WALLET` | `swap()` called with no `wallet` |
| `NEEDS_ELIGIBILITY` | Buying a Stock Token without `acknowledgeEligibility: true` |
| `FEED_CONNECTION` | Sequencer feed dropped (not used by hood-js's own calls) |
| `BAD_INPUT` | A hood-js argument itself is malformed (validated before any network call) |
| `NETWORK` | Couldn't reach the chain / GeckoTerminal |
| `UNKNOWN` | Anything else |

## Bundle size

hood-js's own code is **4.55 kB gzipped** (budget: ≤ 15 kB) — `viem` (peer) and
`hoodchain` (dependency) install alongside, same as any viem-based library. Verify with:

```bash
npm run build && npm run size
```

## Browser usage

Works from a plain `<script type="module">` import against any CDN that serves ESM
packages, no bundler required:

```html
<script type="module">
  import hood from 'https://esm.sh/hood-js'
  const { usd } = await hood.price('AAPL')
  document.body.textContent = `AAPL: $${usd}`
</script>
```

For `swap()` in the browser, pass `window.ethereum` (or any EIP-1193 provider) as `wallet`
— hood-js requests accounts and drives the injected provider directly.

## Testing

```bash
npm run build
npm test        # unit — arg validation, error mapping, offline token resolution
npm run test:live   # live — real reads against mainnet 4663 + GeckoTerminal
```

`test:live` needs network access and hits real endpoints — no mocks anywhere in this
package. A testnet swap test also exists (`tests/live/testnet.test.ts`) but is skipped
unless `ROBINHOOD_CHAIN_PRIVATE_KEY` is set to a faucet-funded key (see **Testnet guide**).

## Examples

Four runnable scripts in [`examples/`](./examples) — prices, trending coins, portfolio
lookup, and a real testnet swap. See [`examples/README.md`](./examples/README.md).

## Relationship to `hoodchain`

hood-js wraps [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk), the
lower-level typed SDK (raw viem clients, every module exposed individually, no opinionated
defaults). Reach for `hoodchain` directly when you need routing internals, the raw
sequencer firehose, or fine-grained control over slippage/deadlines/multi-token batching
beyond what this facade exposes.

## License

[Apache-2.0](./LICENSE) © 2026 nirholas

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
