# 03 — Advanced toolkit: `hoodkit` (the power-user layer)

Read `prompts/robinhood-chain/_shared.md` first. Requires Wave 1 core SDK
(`file:../robinhood-chain-sdk` + npm name dep).

## Mission
Build `robinhood/hoodkit/` — the advanced wrapper for teams building real products on Robinhood
Chain: streaming, caching, batching, indexing, strategy primitives, React hooks. Where `hood-js`
hides complexity, `hoodkit` weaponizes it. npm `hoodkit` (fallbacks: `hood-kit`, `hoodchain-kit`).

## Modules

1. **`stream`** — unified real-time layer over the sequencer firehose + RPC log subscriptions:
   `streamPrices(symbols)`, `streamSwaps({ pool | token })`, `streamLaunches()`,
   `streamPortfolio(address)`. Backpressure-safe async iterators AND event-emitter forms.
   Automatic reconnect with resume-from-block gap fill (no silently dropped events — test this
   by killing the socket mid-stream in an integration test).
2. **`cache`** — pluggable read-through cache (memory LRU default, Redis adapter interface) with
   per-datatype TTLs (quotes 2s, registry 1h, multipliers 10m); request coalescing so N
   concurrent identical reads → 1 RPC call (test with 100 parallel `getQuote`s → assert 1 fetch).
3. **`batch`** — multicall aggregation with automatic chunking + a `plan()` API that batches
   arbitrary SDK reads into minimal RPC round-trips.
4. **`index`** — lightweight local indexer: sync Transfer/Swap/launch events for a token set
   into SQLite (better-sqlite3), incremental from last synced block, exposing
   `holders(token)`, `candles(token, interval)` (build OHLCV from swap events — real math,
   tested against a known pool's Blockscout history), `volume24h(token)`.
5. **`strategy`** — primitives autonomous agents need (prompt 07 consumes this): position
   tracker with PnL (realized/unrealized, multiplier-aware for Stock Tokens), TWAP executor
   (slice a big swap across time with per-slice slippage bounds), price triggers
   (`onCross(symbol, threshold, cb)`), spend-cap guard, dry-run mode that builds+simulates
   (`eth_call`) without sending.
6. **`react`** — `@hoodkit/react` subpath: `useQuote`, `usePortfolio`, `useLaunches`, `useSwap`
   hooks over the stream/cache layers, SSR-safe, with a small real demo app in `examples/react-demo`
   (Vite) actually run during verification.

## Requirements
- Same packaging bar as the core SDK (ESM+CJS, exports map, Node ≥ 20). Keep heavy deps optional:
  better-sqlite3 and react are optional peer deps; core installs light.
- Vitest: unit for cache/batch/strategy math; integration: live stream 60s of real mainnet
  swaps on a busy pool (paste event count), index a real token's last 1000 blocks and assert
  holder math against Blockscout's holder count (tolerance documented).
- `docs/` static site per `_shared.md`: landing = live dashboard demo (client-side: streaming
  prices + latest launches rendered beautifully), guides per module, API reference (typedoc).
- README: when to use hoodkit vs hood-js vs core SDK (honest decision table).

## Done checklist
- [ ] Reconnect gap-fill test proves no dropped events.
- [ ] Coalescing test proves 100→1. Candle math validated against a real pool.
- [ ] React demo runs (`npm run dev` exercised, screenshot-worthy). `npm pack` clean on both entry points.
- [ ] Live-stream evidence + indexer-vs-Blockscout comparison in the report.
