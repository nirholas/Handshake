# robinhood-feed

The PumpPortal-equivalent for **Robinhood Chain** (mainnet chain ID 4663): a
long-lived Node worker that watches NOXA + The Odyssey memecoin launchpads and
their Uniswap v3 pools, normalizes every launch/trade/graduation into the same
shape three.ws's pump.fun consumers already understand, and serves it over
SSE + WebSocket + a REST snapshot. No mocks — every field comes from a real
on-chain read (RPC logs + the Arbitrum sequencer feed).

It is also useful standalone: any Robinhood Chain trading bot, alert bot or
dashboard needs exactly this firehose, and nothing here is three.ws-specific
apart from the pump-compatible field names.

## Why it exists

three.ws's `/play` feature turns every pump.fun coin into a deterministic 3D
world you walk into as your avatar, with live trades animating the space. This
worker is the data plane that lets `/play` do the same for Robinhood Chain
coins — see `api/robinhood/coin-trades.js` and `api/robinhood/play-worlds.js`,
which proxy it into the exact contract `src/game/chart-screen.js` (the in-world
trading terminal) already polls.

### What the two API bridges guarantee their callers

The terminal re-polls `/api/robinhood/coin-trades` every 5 seconds and the
`/worlds` lobby swallows any non-2xx from `/api/robinhood/play-worlds`, so a
single bad event in `/recent` must never become a 5xx. Both bridges therefore
treat this worker as untrusted input:

- An event with a missing or non-object `data` payload is skipped, and the rest
  of the snapshot still renders.
- A `timestamp` that is not a positive number is served as `null`, which
  `chart-screen.js` already reads as "now", instead of an invalid date.
- A missing `price_usd` / `usd_amount` stays `null` rather than becoming a real
  `0` print on the chart.
- A launch whose `mint` is not a `0x`-prefixed 40-hex address is dropped, since
  its lobby card would seed a world from nothing.
- An unreachable or non-2xx worker yields an empty list with
  `configured: false`, never invented trades or worlds.

Caller input is validated separately: `coin-trades` answers `400
{"error":"invalid_mint"}` for an address that is not an EVM contract address,
so a client bug cannot read as "this coin has never traded".
`tests/api/robinhood-play-endpoints.test.js` pins all of the above.

## Architecture

| File | Role |
|------|------|
| `index.js` | Entrypoint: starts the firehose, wires it into the server, probes every configured RPC once so a dead one is visible in the logs, graceful SIGINT/SIGTERM shutdown. |
| `src/config.js` | Env-driven config (network, RPC URLs, sequencer feed URL, poll intervals, buffer sizes). Every default works with zero config against the public endpoints. |
| `src/chain.js` | Shared `hoodchain` (the `robinhood-chain-sdk` npm package) read client over a viem `fallback` transport; cached ERC-20 name/symbol resolution; cached block timestamps; one-time Uniswap v3 pool inspection (which side is the coin, ETH vs USDG quote). |
| `src/rpc.js` | `withRpcRetry`: the transient-failure classifier the bulk log reads run through. See "Public RPC behaviour" below. |
| `src/eth-price.js` | ETH/USD spot, 4-source failover (Coinbase → Kraken → CoinGecko → DefiLlama), cached ~60s — the ETH-gas-chain analogue of three.ws's `sol-price.js`. |
| `src/normalize.js` | **Pure** functions mapping decoded on-chain events to the pump-compatible shape. No chain reads — unit-tests directly against captured real logs (`tests/fixtures/`). |
| `src/feed.js` | The orchestrator: composes the SDK's `watchLaunches`/`watchCurveTrades`/`watchGraduations` (NOXA + Odyssey via RPC logs), a dynamic Uniswap v3 `Swap` watcher over tracked pools (NOXA pools from block one, Odyssey pools post-graduation), and the sequencer feed as a liveness/gap watchdog. Backfills on cold start, gap-fills on a stalled watcher, dedupes cross-source. |
| `src/server.js` | HTTP + WS server: `/healthz`, `/recent`, SSE `/events`, WebSocket `/ws`. Keeps a small replay buffer so a fresh subscriber sees recent history instead of a blank feed. |

Built entirely on `hoodchain` (`robinhood/robinhood-chain-sdk/`, published npm
name `hoodchain`) — this worker adds composition, pump-shape normalization, and
serving on top; it does not reimplement chain reads the SDK already provides.

## Divergences from the pump.fun (PumpPortal) feed

Documented per the mission brief — fields map 1:1 where semantics align:

- **Chain**: Robinhood Chain is EVM (Arbitrum Orbit L2), not Solana. Addresses
  are `0x…` (40 hex chars), not base58. `mint` in every event is the coin's ERC-20
  contract address.
- **Native asset**: ETH, not SOL. The `sol_amount` / `sol_value_usd` field names
  are kept **verbatim** for compatibility with the existing consumer field
  reads (`ingest()` in `src/game/chart-screen.js` maps `sol_amount`/`usd_amount`
  into the `sol`/`usd` the in-world ticker and `MarketReactor` animate from):
  the *value* carried is the trade's
  native-ETH magnitude, not SOL. A `quote_symbol` field (`'ETH'` or `'USDG'`)
  always tells you which.
- **Launchpads**: two exist, not one — **NOXA** (instant Uniswap v3 listing,
  one tx: deploy + pool + locked liquidity, no bonding curve) and **The
  Odyssey** (pump.fun-style ETH bonding curve; graduates via `PoolMigrated` to
  a locked Uniswap v3 pool). NOXA coins have no `graduation` event — they're
  tradeable via Uniswap swaps from block one, which this worker watches
  directly (`trade.source: 'uniswap-v3'` vs `'odyssey-curve'`).
  `launchpad` on every launch event tells you which.
- **No off-chain metadata service**: pump.fun ships `image_uri`/description/
  socials from its own API; Robinhood Chain launchpads don't expose an
  equivalent yet, so `image_uri`/`description`/`twitter`/etc. are always `null`.
  `name`/`symbol` ARE real — resolved on-chain via the ERC-20 `name()`/
  `symbol()` calls.
- **`initial_buy_native`/`initial_buy_usd`** on a launch event are best-effort:
  the hoodchain SDK's high-level launch watchers don't carry NOXA's raw
  `initialBuyAmount` log field through their decoded `Launch` type, so these
  resolve to `null` rather than a fabricated figure when unavailable.
- **Sequencer feed vs RPC logs**: the Arbitrum Nitro sequencer feed
  (`wss://feed.mainnet.chain.robinhood.com`) delivers every L2 transaction
  ~100–300ms before it's queryable over RPC, but decoding trade *semantics*
  (which pool, buy vs sell, amounts) out of its raw RLP payload is far less
  reliable than reading decoded event logs. This worker uses RPC logs (via
  `hoodchain`'s `watchContractEvent`, polled at `RH_POLL_MS`, default 2s) for
  every decoded event, and the sequencer feed only as a sub-second block-tip /
  gap-detection signal (`GET /healthz` → `firehose.feed.seconds_since_frame`).
- **`market_cap_usd`** is always `null` — computing a live circulating market
  cap needs a total-supply read this worker doesn't do per-trade (would be one
  more RPC call per event); left `null` rather than approximated.

## Running it

```bash
cd workers/robinhood-feed
npm install            # symlinks hoodchain from ../../robinhood/robinhood-chain-sdk
npm start              # listens on :8788 (mainnet, public RPC + sequencer feed)
```

`npm install` on a `file:` dependency only symlinks the source directory: npm
does not build it, and the SDK is TypeScript whose `dist/` is gitignored. So
`npm start` runs `scripts/ensure-sdk.mjs` first (`prestart`), which builds the
SDK's `dist/` when it is missing. That takes a few seconds on a fresh clone and
is a no-op afterwards. To do it by hand: `npm run build:sdk`.

Zero-config defaults hit the public Robinhood Chain endpoints. Every knob is an
env var:

| Var | Default | Meaning |
|-----|---------|---------|
| `RH_NETWORK` | `mainnet` | `mainnet` (4663) or `testnet` (46630). |
| `RH_RPC_URL` | public RPC | Preferred HTTP RPC. The public RPC always stays in the list behind it as a fallback rung. |
| `ALCHEMY_API_KEY` | (unset) | If set, mainnet calls try Alchemy first and fall back to the public RPC. See Known limitations. |
| `RH_FEED_URL` | public sequencer feed | Override the sequencer WS URL. |
| `RH_USE_FEED` | `1` | Set `0` to disable the sequencer-feed watchdog entirely (RPC-only mode). |
| `RH_POLL_MS` | `2000` | RPC log poll interval for the SDK watchers. |
| `PORT` | `8788` | HTTP/WS server port. |
| `RH_BACKFILL_BLOCKS` | `200000` | How many blocks of launch history to backfill on cold start. |
| `RH_GAP_BLOCKS` | `2000` | Chain-head lead that triggers a gap-fill rescan (≈3.3 min of blocks at Robinhood Chain's ~100ms cadence — must clear one poll tick's normal advance or every tick misreads itself as stalled). |
| `RH_MAX_POOLS` | `400` | LRU cap on concurrently-watched Uniswap v3 pools. |
| `RH_BUFFER_LIMIT` | `40` | Replay-buffer depth per event kind (what a fresh subscriber and `/recent` see). |
| `RH_SEEN_LIMIT` | `4000` | Cross-source dedupe memory, in event keys. |

## Public RPC behaviour (measured, not assumed)

Two things about `rpc.mainnet.chain.robinhood.com` shape the worker's design.
Both were measured live against mainnet, not inferred:

1. **It sheds load with a wrong error code.** Under load it answers a perfectly
   valid `eth_getLogs` with JSON-RPC `-32602 "Missing or invalid parameters."`
   The identical request succeeds on the very next attempt (measured: 4/4 on a
   range that had just failed). viem never retries `-32602`, because that code
   means "the caller sent nonsense" everywhere else, so one shed request used to
   abort an entire cold-start backfill. Every bulk read now goes through
   `withRpcRetry` (`src/rpc.js`), which treats `-32602` as transient and backs
   off. Retries are reported as `status` events (`src: 'backfill' | 'gap-fill'`)
   so they show up on `/events` instead of disappearing.
2. **Ranges are generous.** A 4 000 000-block `eth_getLogs` window is accepted;
   the SDK's own 10 000-block chunking in `getRecentLaunches` is well inside the
   limit. The failures above are load, not range.

The launchpads themselves idle for long stretches: at the time of writing the
newest NOXA launch on mainnet is block 6 880 646 (2026-07-11), roughly 26.4 M
blocks behind the head. A cold start with the default `RH_BACKFILL_BLOCKS`
(200 000 blocks ≈ 5.5 h) therefore normally finds nothing and the replay buffer
starts empty. That is the chain being quiet, not the worker being broken:
`/healthz` still shows a live `feed.last_sequence` and `last_scanned_block`.
`npm run smoke:live` proves the decode path end to end regardless, by finding
the newest launch that actually exists.

## API

- `GET /healthz` → `{ ok, network, uptime_s, subscribers, buffer, firehose: { chain_id, rpc, last_scanned_block, tracked_pools, feed: { last_sequence, seconds_since_frame } } }`
  (`rpc` lists the configured endpoints with any provider key masked.)
- `GET /recent?kind=launch|trade|graduation|all&limit=20` → `{ events: [{ kind, data }] }`, newest first.
- `GET /events?kinds=launch,trade,graduation` (SSE) → replays the buffer (`replay: true`), then streams live. `text/event-stream`, each line `data: {"kind":"trade","data":{...}}`.
- `WS /ws?kinds=launch,trade,graduation` → identical events over a WebSocket.

Event shapes are documented inline in `src/normalize.js`. Every trade carries
both the legacy pump-compatible fields (`sol_amount`, `usd_amount`, `user`,
`tx`, `is_buy`) and chain-explicit fields (`chain`, `chain_id`, `quote_symbol`,
`explorer_tx_url`).

## Tests

```bash
npm test          # offline: normalizer + retry classifier + HTTP/WS/SSE plumbing
npm run smoke:live  # online: the real chain end to end (read-only, ~20s)
```

`npm test` never touches the network, so it runs anywhere and never fails
because a launchpad is quiet:

- `tests/normalize.test.js` runs the pure normalizer against real captured logs
  (below).
- `tests/rpc.test.js` pins the transient-error classifier, including the
  public RPC's `-32602` load-shed response.
- `tests/server.test.js` is the core-path smoke test: real fixture logs go
  through the real normalizers into the real server, and are asserted back out
  over real sockets (`/healthz`, `/recent` ordering + kind filtering + dedupe,
  SSE replay-then-live with `?kinds=`, WebSocket replay + fan-out, shutdown
  with a subscriber still attached).

`npm run smoke:live` covers what only the live chain can: that the configured
RPCs answer, that the SDK's decoding still matches the deployed launchpad
contracts, that ERC-20 metadata / block times / the ETH price resolve, that a
real Uniswap swap classifies buy-vs-sell correctly, that the sequencer feed
delivers frames, and that all of it survives `/recent` and SSE. It reads only:
no keys, no writes, no spend. Because the launchpads idle for long stretches, it
scans backward from the head until it finds the newest launch that exists rather
than assuming recent activity.

Unit tests (`tests/normalize.test.js`) run the pure normalizer against **real
on-chain logs**, captured live from Robinhood Chain mainnet during development
and committed as fixtures (`tests/fixtures/*.json`) — an Odyssey `Traded` log,
a NOXA `TokenLaunched` log, an Odyssey `TokenCreated` log, and a Uniswap v3
`Swap` log on the resulting pool. No mocks: every asserted value traces back to
a real transaction hash. Captured with:

```js
import { createHoodClient, ODYSSEY_ADDRESSES, NOXA_ADDRESSES,
  odysseyTradedEvent, odysseyTokenCreatedEvent, noxaTokenLaunchedEvent } from 'hoodchain';
const hood = createHoodClient();
const logs = await hood.public.getLogs({
  address: ODYSSEY_ADDRESSES.bondingCurveFactory,
  event: odysseyTradedEvent,
  fromBlock: /* recent range */, toBlock: 'latest',
});
```

## Deploying

**Not deployed today.** No `robinhood-feed` service exists on Cloud Run and
`ROBINHOOD_FEED_URL` is unset on `three-ws-api`, so
`api/robinhood/coin-trades.js` and `api/robinhood/play-worlds.js` serve their
designed empty state. Everything needed to change that is in this directory; the
deploy itself is owner-gated per CLAUDE.md.

Same shape as the other long-lived Node workers in `workers/` (e.g.
`agent-sniper`): a Cloud Run **service** (not a job, it is a persistent WS/SSE
server), min instances 1 so the SDK watchers and replay buffer stay warm.

Build from the **repo root**. `gcloud run deploy --source workers/robinhood-feed`
cannot work here: the worker depends on the local SDK through
`file:../../robinhood/robinhood-chain-sdk`, which sits outside that build
context. `Dockerfile` builds the SDK in a first stage and the worker in a
second, so the whole thing comes from a clean checkout with no manual step:

```bash
# local
docker build -f workers/robinhood-feed/Dockerfile -t robinhood-feed .
docker run --rm -p 8788:8788 robinhood-feed

# Cloud Build (from the repo root)
gcloud builds submit --config workers/robinhood-feed/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5

# first deploy
gcloud run deploy robinhood-feed --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --image us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/workers/robinhood-feed:latest \
  --service-account three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --port 8788 --allow-unauthenticated \
  --set-env-vars RH_NETWORK=mainnet
```

`--max-instances 1`: the firehose is a single logical stream (RPC watchers +
sequencer feed + replay buffer); running two instances would double the RPC
load and split subscribers across two independent buffers. Scale reads by
fronting it with a CDN/cache on `/recent`, not by adding instances.

Do **not** put `ALCHEMY_API_KEY` on the service until the Alchemy app has the
Robinhood network enabled (see Known limitations). The client falls back to the
public RPC on its own, so a disabled key costs latency rather than uptime, but
there is no reason to pay for the failed first hop.

Once deployed, set `ROBINHOOD_FEED_URL` on the three.ws API service (Cloud Run
`three-ws-api`) to this worker's URL so `api/robinhood/coin-trades.js` and
`api/robinhood/play-worlds.js` stop falling back to their empty-but-honest
`configured: false` state.

## Known limitations (owner action)

- **Alchemy accelerator not enabled**: `ALCHEMY_API_KEY` is set in `.env`, but
  the Alchemy app does not have the Robinhood Chain network enabled. Re-verified
  live on 2026-08-11: every call to `robinhood-mainnet.g.alchemy.com` returns
  `-32600 ROBINHOOD_MAINNET is not enabled for this app`. The worker runs
  correctly against the public RPC without it (the client lists Alchemy first
  and falls through), and the boot probe logs the rung as unusable so it is not
  mistaken for a quiet chain. Enabling it would cut RPC latency, not add
  capability. Enable at `https://dashboard.alchemy.com/apps/<app>/networks`.
- **Public RPC has no SLA**: `rpc.mainnet.chain.robinhood.com` sheds load with
  a misleading `-32602` (see "Public RPC behaviour"). `withRpcRetry` absorbs
  that, but under sustained load a paid provider is still the right answer:
  point `RH_RPC_URL` at it and the public RPC stays behind it as a fallback.
- **Launchpad activity is intermittent**: the newest NOXA launch as of
  2026-08-11 is a month old (block 6 880 646, 2026-07-11). Nothing to fix, but
  do not read an empty `/recent` on a fresh deploy as a failure. Confirm with
  `npm run smoke:live`.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
