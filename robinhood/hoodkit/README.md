# hoodkit

**The power-user toolkit for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663) — built on top of [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk).**

`hoodchain` gives you typed reads and writes. `hoodkit` gives you what a production trading
bot, a live dashboard, or an on-chain analytics service actually needs on top of that:

- **Real-time streams with reconnect gap-fill** — Chainlink price ticks, Uniswap v3 swaps,
  NOXA/Odyssey launches, and wallet portfolio changes, all as a backpressure-safe `Stream<T>`
  that survives a dropped RPC connection without silently losing an event.
- **Read-through caching with request coalescing** — collapse N concurrent identical reads
  into one upstream call, cached per-datatype TTL.
- **Multicall batching** — `plan()` for one-shot bulk reads, `createBatcher()` for a
  DataLoader-style batcher that coalesces reads from unrelated code paths automatically.
- **A local SQLite indexer** — holders, OHLCV candles, and rolling 24h volume, computed from
  indexed `Transfer`/`Swap` events with zero RPC at query time.
- **Agent strategy primitives** — weighted-average-cost PnL tracking, price-cross triggers, a
  dry-run-by-default TWAP executor, and hard spend caps.
- **SSR-safe React hooks** — `hoodkit/react` wraps the streaming and read layers in hooks that
  render inert on the server and hydrate on the client.

Who it's for: anyone building a bot, dashboard, indexer, or agent against Robinhood Chain who
doesn't want to hand-roll reconnect logic, cache invalidation, or multicall batching on top of
the base SDK.

## Install

```bash
npm install hoodkit hoodchain viem
```

```bash
pnpm add hoodkit hoodchain viem
```

`hoodchain` and `viem` are required peer dependencies — `hoodkit` never bundles them, so your
app controls the exact versions. Two more peers are optional and only needed if you use the
feature that requires them:

| Peer | Required for | Optional? |
| --- | --- | --- |
| `hoodchain` `^0.1.0` | every module — `HoodClient` is the shared entry point | required |
| `viem` `^2.55.0` | every module | required |
| `react` `>=18` | `hoodkit/react` hooks only | optional |
| `better-sqlite3` `>=11` | `Indexer`/`createIndexer` only | optional |
| `ws` `^8.18.0` | kept external for environments that need it alongside `hoodchain` | optional |

Node ≥ 20. If a peer is missing at runtime for the feature you're using, `hoodkit` throws a
clear error telling you which package to install (see [`createIndexer`](#indexer) for an
example) rather than failing silently.

## Quickstart

```ts
import { createHoodClient } from 'hoodchain'
import { streamPrices, createHoodCache, plan } from 'hoodkit'

const hood = createHoodClient() // mainnet 4663, public RPC, multicall batching on

// Live Chainlink prices — emits only when a feed's round actually advances
const prices = streamPrices(hood, ['AAPL', 'TSLA', 'NVDA'])
for await (const tick of prices) {
  console.log(`${tick.symbol}: $${tick.priceUsd} (round #${tick.roundId})`)
  break // for await naturally supports `break` to stop consuming
}

// Read-through cache — 100 concurrent calls collapse into ~1 RPC round-trip
const cache = createHoodCache(hood)
await Promise.all(Array.from({ length: 100 }, () => cache.getQuote('AAPL')))
console.log(cache.stats) // { hits, misses, coalesced }

// Batch many independent multicall reads
import { erc20Abi, listStockTokens } from 'hoodchain'
const results = await plan(
  hood,
  listStockTokens().map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'totalSupply' })),
)
```

Four more runnable, end-to-end scripts plus a full React dashboard live in
[`examples/`](./examples) — see [Examples](#examples) below.

## API reference

`hoodkit` has two entry points: the default export (`hoodkit`) with everything below except the
React hooks, and `hoodkit/react` for the hook layer. Every export below is a real, verified
export from [`src/index.ts`](./src/index.ts) and [`src/react/index.ts`](./src/react/index.ts) —
nothing here is aspirational.

### Stream

The real-time layer. Every stream helper returns a `Stream<T>`, which is both an event emitter
(`stream.on('data' | 'error' | 'close', cb)`) and a backpressure-safe async iterable
(`for await (const v of stream)`), sharing one source so a slow `for await` consumer never grows
memory unboundedly.

```ts
class Stream<T> implements AsyncIterable<T> {
  on(event: 'data', listener: (value: T) => void): () => void
  on(event: 'error', listener: (error: Error) => void): () => void
  on(event: 'close', listener: () => void): () => void
  off(event, listener): void
  push(value: T): void          // producer API
  fail(error: Error): void      // producer API — transient error, stream stays open
  end(): void                   // producer API — graceful close
  destroy(error: Error): void   // producer API — terminal error, closes the stream
  close(): void                 // alias for end()
  readonly isClosed: boolean
  readonly buffered: number
  dropped: number               // values dropped by the overflow policy
}
```

`StreamOptions`: `{ highWaterMark?: number /* default 1024 */, overflow?: OverflowPolicy }`.
`OverflowPolicy` is `'drop-oldest'` (default — keep the newest `highWaterMark` values),
`'latest'` (keep only the single most recent value — right for price ticks), or `'block'`
(never drop, for naturally slow producers).

| Export | Signature | What it does |
| --- | --- | --- |
| `streamPrices(client, symbols?, options?)` | → `Stream<PriceTick>` | Polls every feed in one multicall on an interval (default 4000ms); emits a `PriceTick` only when a symbol's Chainlink round advances. `symbols` omitted streams every priced Stock Token. |
| `streamSwaps(client, target, options?)` | → `Promise<Stream<SwapEvent>>` | Streams Uniswap v3 swaps for `{ pool }` or every WETH/USDG pool of `{ token }`. Gap-fill backed — a dropped RPC connection re-reads the missed block range. |
| `streamLaunches(client, options?)` | → `Stream<Launch>` | Streams new token launches from NOXA and The Odyssey, gap-filled. Pass `fromBlock` to backfill history. |
| `streamPortfolio(client, address, options?)` | → `Stream<PortfolioUpdate>` | Streams balance changes for `address` across every Stock Token (and USDG) by watching `Transfer` logs and re-reading the affected balance. |
| `runLogCursor(options)` | → `() => void` | The gap-fill engine behind every RPC-backed stream above. Maintains a persistent block cursor that only advances after logs for a range are decoded and pushed — a poll error retries the exact same range next tick, so no confirmed event is silently skipped. Returns a `stop()` function. |
| `discoverPools(client, token)` | → `Promise<PoolInfo[]>` | Discovers the live Uniswap v3 pools for `token`, probed against WETH and USDG across every fee tier. |
| `loadPoolInfo(client, pool)` | → `Promise<PoolInfo>` | Reads a pool's `token0`/`token1`/`fee` and both token decimals in one multicall. |
| `decodeSwapLog(log, info)` | → `SwapEvent \| null` | Decodes a raw viem `Swap` log against a known pool's decimals. |
| `sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1)` | → `number` | Converts a pool's `sqrtPriceX96` to the human price of token0 in token1. |
| `uniswapV3SwapEvent` | `const` | The Uniswap v3 `Swap` event ABI fragment. |
| `uniswapV3PoolMetaAbi` | `const` | Minimal `token0`/`token1`/`fee` pool ABI. |

Types: `OverflowPolicy`, `StreamOptions`, `StreamPollOptions` (`StreamOptions & { pollingIntervalMs? }`),
`StreamSwapsOptions` (`StreamOptions & { pollingIntervalMs?, fromBlock?, chunkSize?, confirmations? }`),
`PriceTick { symbol, feed, priceUsd, roundId, updatedAt, ageSeconds }`,
`PortfolioUpdate { token, symbol, balance, balanceFormatted, transfer }`,
`PoolInfo { pool, token0, token1, fee, decimals0, decimals1 }`,
`SwapEvent { pool, amount0, amount1, buysToken0, price, volume0, volume1, spotPrice, sqrtPriceX96, liquidity, tick, blockNumber, logIndex, transactionHash, sender, recipient }`,
`LogCursorOptions<TLog, TEvent>`, `LogSource { getBlockNumber(): Promise<bigint> }`.

```ts
// Watch every swap touching a token, gap-filled across reconnects
const swaps = await streamSwaps(hood, { token: '0x…' })
swaps.on('data', (s) => console.log(s.buysToken0 ? 'BUY' : 'SELL', s.price))
```

### Cache

A read-through cache over the `hoodchain` reads, with request coalescing: N concurrent
identical reads collapse into exactly one upstream call.

| Export | Signature | What it does |
| --- | --- | --- |
| `createHoodCache(client, options?)` | → `HoodCache` | Creates a cache bound to a `HoodClient`. |
| `MemoryLruStore` | `class`, `new MemoryLruStore(maxEntries = 5000)` | The default in-memory LRU `CacheStore` with per-entry TTL. |

`HoodCache`:

```ts
interface HoodCache {
  getQuote(symbol: string, options?: GetQuoteOptions): Promise<StockQuote>
  getMultiplier(symbol: string): Promise<bigint | null>
  getPortfolio(owner: Address, options?: GetQuoteOptions): Promise<Portfolio>
  getPosition(owner: Address, symbol: string, options?: GetQuoteOptions): Promise<StockPosition>
  getUsdgBalance(owner: Address): Promise<bigint>
  read<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> // cache your own reads
  invalidate(key: string): Promise<void>
  clear(): Promise<void>
  readonly stats: CacheStats   // { hits, misses, coalesced }
  readonly ttls: CacheTtls
}
```

Default TTLs (override any subset via `options.ttls`): `quote: 2000`, `multiplier: 600_000`,
`portfolio: 5000`, `balance: 5000`, `registry: 3_600_000` (all ms).

`CacheStore` is pluggable — implement `get`/`set`/`delete`/`clear` to back the cache with
Redis, Cloudflare KV, or anything else:

```ts
const store: CacheStore = {
  async get(key) { const v = await redis.get(key); return v ? JSON.parse(v) : undefined },
  async set(key, value, ttlMs) { await redis.set(key, JSON.stringify(value), 'PX', ttlMs) },
  async delete(key) { await redis.del(key) },
}
const cache = createHoodCache(hood, { store })
```

Types: `HoodCache`, `HoodCacheOptions { store?, ttls? }`, `CacheStore`, `CacheTtls`, `CacheStats`.

### Batch

Multicall batching on top of `client.public.multicall`, with per-read failure isolation.

| Export | Signature | What it does |
| --- | --- | --- |
| `plan(client, reads, options?)` | → `Promise<BatchResult<T>[]>` | Executes many contract reads in the fewest possible Multicall3 round-trips, chunked to `maxBatchSize` (default 500) and run concurrently. Unlike a raw `multicall`, one reverting read never sinks the whole batch — every result carries a `status`. |
| `createBatcher(client, options?)` | → `Batcher` | A DataLoader-style batcher: reads enqueued within the same event-loop tick are coalesced into one Multicall3 call automatically, even across unrelated code paths. |

`Batcher`:

```ts
interface Batcher {
  call<T = unknown>(read: ContractRead): Promise<T>          // throws only if the call reverts
  callSafe<T = unknown>(read: ContractRead): Promise<BatchResult<T>> // never rejects
  flush(): Promise<void>       // force-flush now (rarely needed — flush is automatic via a microtask)
  readonly pending: number
}
```

Types: `ContractRead { address, abi, functionName, args? }`,
`BatchResult<T> = { status: 'success', result: T } | { status: 'failure', error: Error }`,
`BatchOptions { maxBatchSize? }`, `Batcher`.

```ts
const batch = createBatcher(hood)
// These three run as ONE multicall even though they're separate awaits:
const [a, b, c] = await Promise.all([
  batch.call({ address: t1, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
  batch.call({ address: t2, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
  batch.call({ address: t3, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
])
```

### Indexer

A local, incremental SQLite indexer: syncs `Transfer` and Uniswap v3 `Swap` events for a token
set, resumes from the last synced block, and answers holder/OHLCV/volume queries from local
data with **zero RPC at query time**. Requires the optional `better-sqlite3` peer dependency —
`createIndexer` throws a clear install instruction if it's missing.

| Export | Signature | What it does |
| --- | --- | --- |
| `createIndexer(options)` | → `Promise<Indexer>` | Opens (or creates) a SQLite-backed `Indexer` and discovers each token's Uniswap v3 pools. |
| `Indexer` | `class` | The indexer instance — see methods below. |
| `buildCandles(trades, intervalSec)` | → `Candle[]` | Buckets raw trades into OHLCV candles by `floor(ts / intervalSec) * intervalSec`. Sparse — omits empty buckets. |
| `fillGaps(candles, intervalSec)` | → `Candle[]` | Forward-fills gaps between candles at the previous close with zero volume, for a continuous chartable series. |
| `INTERVAL_SECONDS` | `Record<Interval, number>` | `'1m'→60, '5m'→300, '15m'→900, '1h'→3600, '4h'→14400, '1d'→86400`. |

`IndexerOptions { client, path, tokens, chunkSize?, timestampConcurrency?, throttleMs? }` — `path`
is a SQLite file path, or `':memory:'` for an ephemeral in-process db.

`Indexer` methods:

```ts
class Indexer {
  init(): Promise<void>                                   // called automatically by createIndexer
  sync(options?: { fromBlock?, swapFromBlock?, toBlock?, onProgress? }): Promise<SyncResult>
  holders(token: Address, options?: { minBalance?: bigint }): Holder[]
  holderCount(token: Address): number
  primaryPool(token: Address): Address | null              // most-traded indexed pool
  candles(token: Address, interval: Interval, options?: { pool?, fill? }): Candle[]
  volume24h(token: Address, now?: number): number           // rolling 24h swap volume
  stats(): { transfers: number; swaps: number; blocks: number; pools: number }
  readonly database: BetterSqlite3.Database                 // raw handle for advanced queries
  close(): void
}
```

Types: `IndexerOptions`, `SyncProgress`, `SyncResult`, `Holder { address, balance, balanceFormatted }`,
`Candle { time, open, high, low, close, volume, trades }`, `Interval`, `TradePoint { ts, price, volume }`.

```ts
const indexer = await createIndexer({ client: hood, path: './hood.sqlite', tokens: ['0x…'] })
await indexer.sync({ fromBlock: 0n })            // full backfill on first run
console.log(indexer.holderCount('0x…'))
console.log(indexer.candles('0x…', '1h'))
```

### Strategy

Agent-facing primitives for trading against Robinhood Chain: PnL tracking, price triggers, a
dry-run-by-default TWAP executor, and hard spend caps.

| Export | Signature | What it does |
| --- | --- | --- |
| `Position` | `class`, `new Position(options?: { multiplier?: bigint })` | A multiplier-aware, weighted-average-cost position/PnL tracker. |
| `SpendCap` | `class`, `new SpendCap(cap: bigint)` | A hard cumulative spend limit in raw units of one token; throws `SpendCapExceededError` once the cap is hit. |
| `SpendCapExceededError` | `class extends Error` | `{ attempted, remaining }` — thrown by `SpendCap.spend()` and consumed internally by the TWAP executor. |
| `createPriceTriggers(client, options?)` | → `PriceTriggers` | Fires callbacks when Stock Token prices cross thresholds, built on `streamPrices`. |
| `createTwapExecutor(client, config)` | → `TwapExecutor` | Splits a swap into equal time-spaced slices, each independently quoted and slippage-bounded, with a hard `SpendCap`, an `AbortSignal` kill switch, and **dry-run by default** (simulates via `eth_call`; opt into live sending with `dryRun: false`). |

`Position`:

```ts
class Position {
  constructor(options?: { multiplier?: bigint })   // 1e18-scaled ERC-8056 multiplier, default 1e18
  record(fill: Fill): void                          // buy: updates avg cost; sell: banks realized PnL
  readonly quantity: number
  readonly averageCost: number
  readonly realized: number
  readonly shareEquivalent: number
  unrealized(markPrice: number): number
  snapshot(markPrice: number): PnlSnapshot
}
```

`PriceTriggers`:

```ts
interface PriceTriggers {
  onCross(symbol: string, threshold: number, direction: CrossDirection, callback: (event: CrossEvent) => void): () => void
  stop(): void
}
```

`TwapExecutor`:

```ts
interface TwapExecutor {
  plan(): TwapSlicePlan[]         // the slice schedule, without running it
  run(): Promise<TwapSliceResult[]>
}
```

Types: `Fill { side, quantity, price, fee?, timestamp? }`, `PnlSnapshot { quantity, averageCost, realized, unrealized, marketValue, total, shareEquivalent }`,
`CrossDirection = 'up' | 'down' | 'any'`, `CrossEvent { symbol, threshold, direction, price, previous }`,
`TwapConfig { tokenIn, tokenOut, totalAmountIn, slices?, intervalMs?, slippageBps?, spendCap?, signal?, dryRun?, recipient?, onBeforeSlice?, onSlice? }`,
`TwapSlicePlan { index, total, amountIn }`,
`TwapSliceResult extends TwapSlicePlan { status: 'sent' | 'simulated' | 'skipped' | 'failed', quote?, amountOutMinimum?, hash?, error? }`.

```ts
const triggers = createPriceTriggers(hood)
triggers.onCross('AAPL', 250, 'up', (e) => console.log('AAPL broke $250', e.price))
// later: triggers.stop()

const twap = createTwapExecutor(hood, {
  tokenIn: usdg, tokenOut: weth, totalAmountIn: parseUsdg('1000'), slices: 5,
})
const results = await twap.run() // dryRun defaults on with no wallet — quoted + eth_call-simulated only
```

### React (`hoodkit/react`)

SSR-safe hooks over the streaming and read layers. Every subscription runs inside `useEffect`,
so components render inert on the server and hydrate on the client. Requires the optional
`react` `>=18` peer dependency.

```ts
import { HoodProvider, useHoodClient, useQuote, usePortfolio, useLaunches, useSwap } from 'hoodkit/react'
```

| Export | Signature | What it does |
| --- | --- | --- |
| `HoodProvider` | `(props: { client: HoodClient; children: ReactNode })` | Provides a `HoodClient` to the hook tree via context. |
| `useHoodClient(explicit?)` | → `HoodClient` | Resolves the active client from an explicit override or `HoodProvider`; throws a descriptive error if neither is present. |
| `useQuote(symbol, options?)` | → `AsyncState<PriceTick>` | Live Chainlink price for one Stock Token, updating whenever the feed's round advances. `options: { client?, pollingIntervalMs? }`. |
| `usePortfolio(address, options?)` | → `AsyncState<Portfolio> & { refetch: () => void }` | A wallet's multiplier-correct Stock Token portfolio, auto-refreshing on `options.refetchIntervalMs`. |
| `useLaunches(options?)` | → `{ launches: Launch[]; isLoading: boolean; error: Error \| null }` | Live launch feed from NOXA + The Odyssey, newest first, capped at `options.limit` (default 50). |
| `useSwap(options?)` | → `UseSwapResult` | Action hook: `getQuote(args)` to preview, `swap(args, swapOptions?)` to execute (requires a wallet-backed client), `reset()` to clear state. |

`AsyncState<T> = { data: T | null; isLoading: boolean; error: Error | null }`.
`HookOptions = { client?: HoodClient }`.
`UseSwapResult = { quote, isQuoting, isSwapping, error, txHash, getQuote, swap, reset }`.

```tsx
import { createHoodClient } from 'hoodchain'
import { HoodProvider, useQuote, useLaunches } from 'hoodkit/react'

function QuoteTile({ symbol }: { symbol: string }) {
  const { data, isLoading, error } = useQuote(symbol)
  if (error) return <span>feed error</span>
  return <span>{data ? `$${data.priceUsd.toFixed(2)}` : isLoading ? 'connecting…' : '—'}</span>
}

function App() {
  const client = createHoodClient()
  return (
    <HoodProvider client={client}>
      <QuoteTile symbol="AAPL" />
    </HoodProvider>
  )
}
```

A full runnable dashboard using every hook above lives in
[`examples/react-demo`](./examples/react-demo) — real Chainlink prices and a real launch feed,
no backend. Run it with `cd examples/react-demo && npm install && npm run dev`.

## Examples

Four runnable scripts in [`examples/`](./examples), each with a `Run:` comment at the top, plus
a full React dashboard:

| Script | Demonstrates |
| --- | --- |
| [`index-token.ts`](./examples/index-token.ts) | Full `Indexer` flow: sync a token's transfers + swaps, then query holders, OHLCV candles, and 24h volume with zero RPC. |
| [`batch-plan.ts`](./examples/batch-plan.ts) | `plan()` reading `totalSupply()` for every Stock Token in a handful of multicall round-trips. |
| [`twap-dry-run.ts`](./examples/twap-dry-run.ts) | `createTwapExecutor` planning and dry-run-simulating a sliced USDG → WETH swap, no wallet key needed. |
| [`cache-coalescing.ts`](./examples/cache-coalescing.ts) | `createHoodCache` collapsing 50 concurrent `getQuote` calls into 1 upstream read. |
| [`examples/react-demo`](./examples/react-demo) | A full Vite + React dashboard built on `hoodkit/react` — live prices, live launches. |

Build first, then run any script directly with `tsx` (they import the built package):

```bash
npm run build
npx tsx examples/batch-plan.ts
```

## Documentation

- **API reference**: generate the full TypeDoc reference locally with `npm run docs:api`
  (outputs to `docs/api`, entry points `src/index.ts` and `src/react/index.ts` — see
  [`typedoc.json`](./typedoc.json)).
- **Homepage**: https://nirholas.github.io/hoodkit/
- **Base SDK**: [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) — the typed
  client, Stock Token registry, swap routing, and firehose that every `hoodkit` module builds on.
- **Robinhood Chain docs**: https://docs.robinhood.com/chain/

## Testing

```bash
npm test          # unit: Stream semantics, gap-fill cursor, cache coalescing, batching, candles, PnL/TWAP math
npm run test:live # integration: real mainnet reads, no API key needed (180s timeout)
```

## Contributing

Issues and PRs welcome at [github.com/nirholas/hoodkit](https://github.com/nirholas/hoodkit/issues).
Before opening a PR: `npm run typecheck && npm test && npm run build`. Keep new public exports
covered by a unit test in [`tests/unit`](./tests/unit) and documented here.

## License

Apache-2.0 © 2026 nirholas

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
