# robinhood-feed

The PumpPortal-equivalent for **Robinhood Chain** (mainnet chain ID 4663): a
long-lived Node worker that watches NOXA + The Odyssey memecoin launchpads and
their Uniswap v3 pools, normalizes every launch/trade/graduation into the same
shape three.ws's pump.fun consumers already understand, and serves it over
SSE + WebSocket + a REST snapshot. No mocks — every field comes from a real
on-chain read (RPC logs + the Arbitrum sequencer feed).

Nothing like this exists for Robinhood Chain today. It's also sellable
standalone: any RH-chain trading bot, alert bot, or dashboard needs exactly
this firehose.

## Why it exists

three.ws's `/play` feature turns every pump.fun coin into a deterministic 3D
world you walk into as your avatar, with live trades animating the space. This
worker is the data plane that lets `/play` do the same for Robinhood Chain
coins — see `api/robinhood/coin-trades.js` and `api/robinhood/play-worlds.js`,
which proxy it into the exact contract `src/game/chart-screen.js` (the in-world
trading terminal) already polls.

## Architecture

| File | Role |
|------|------|
| `index.js` | Entrypoint — starts the firehose, wires it into the server, graceful SIGINT/SIGTERM shutdown. |
| `src/config.js` | Env-driven config (network, RPC URL, sequencer feed URL, poll intervals, buffer sizes). Every default works with zero config against the public endpoints. |
| `src/chain.js` | Shared `hoodchain` (the `robinhood-chain-sdk` npm package) read client; cached ERC-20 name/symbol resolution; one-time Uniswap v3 pool inspection (which side is the coin, ETH vs USDG quote). |
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
  are kept **verbatim** for compatibility with existing chart-screen.js /
  market-reactor.js field reads (`src/game/chart-screen.js:186-195`,
  `src/game/market-reactor.js:78-79`) — the *value* carried is the trade's
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
npm install            # pulls hoodchain via file:../../robinhood/robinhood-chain-sdk
npm start               # listens on :8788 (mainnet, public RPC + sequencer feed)
```

Zero-config defaults hit the public Robinhood Chain endpoints. Every knob is an
env var:

| Var | Default | Meaning |
|-----|---------|---------|
| `RH_NETWORK` | `mainnet` | `mainnet` (4663) or `testnet` (46630). |
| `RH_RPC_URL` | public RPC | Override the HTTP RPC (e.g. an Alchemy endpoint once `ROBINHOOD_MAINNET` is enabled on the app — see Known limitations). |
| `ALCHEMY_API_KEY` | — | If set, mainnet RPC calls route through Alchemy automatically. |
| `RH_FEED_URL` | public sequencer feed | Override the sequencer WS URL. |
| `RH_USE_FEED` | `1` | Set `0` to disable the sequencer-feed watchdog entirely (RPC-only mode). |
| `RH_POLL_MS` | `2000` | RPC log poll interval for the SDK watchers. |
| `PORT` | `8788` | HTTP/WS server port. |
| `RH_BACKFILL_BLOCKS` | `200000` | How many blocks of launch history to backfill on cold start. |
| `RH_GAP_BLOCKS` | `2000` | Chain-head lead that triggers a gap-fill rescan (≈3.3 min of blocks at Robinhood Chain's ~100ms cadence — must clear one poll tick's normal advance or every tick misreads itself as stalled). |
| `RH_MAX_POOLS` | `400` | LRU cap on concurrently-watched Uniswap v3 pools. |

## API

- `GET /healthz` → `{ ok, network, uptime_s, subscribers, buffer, firehose: { last_scanned_block, tracked_pools, feed: { last_sequence, seconds_since_frame } } }`
- `GET /recent?kind=launch|trade|graduation|all&limit=20` → `{ events: [{ kind, data }] }`, newest first.
- `GET /events?kinds=launch,trade,graduation` (SSE) → replays the buffer (`replay: true`), then streams live. `text/event-stream`, each line `data: {"kind":"trade","data":{...}}`.
- `WS /ws?kinds=launch,trade,graduation` → identical events over a WebSocket.

Event shapes are documented inline in `src/normalize.js`. Every trade carries
both the legacy pump-compatible fields (`sol_amount`, `usd_amount`, `user`,
`tx`, `is_buy`) and chain-explicit fields (`chain`, `chain_id`, `quote_symbol`,
`explorer_tx_url`).

## Tests

```bash
npm test
```

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

Same shape as the other long-lived Node workers in `workers/` (e.g.
`agent-sniper`): a Cloud Run **service** (not a job — it's a persistent
WS/SSE server), min instances ≥ 1 so the SDK watchers and replay buffer stay
warm.

```bash
gcloud run deploy robinhood-feed \
  --source workers/robinhood-feed \
  --region us-central1 \
  --min-instances 1 --max-instances 1 \
  --no-cpu-throttling \
  --set-env-vars RH_NETWORK=mainnet
```

`--max-instances 1`: the firehose is a single logical stream (RPC watchers +
sequencer feed + replay buffer); running two instances would double the RPC
load and split subscribers across two independent buffers. Scale reads by
fronting it with a CDN/cache on `/recent`, not by adding instances.

Once deployed, set `ROBINHOOD_FEED_URL` on the three.ws API service (Cloud Run
`three-ws-api`) to this worker's URL so `api/robinhood/coin-trades.js` and
`api/robinhood/play-worlds.js` stop falling back to their empty-but-honest
`configured: false` state.

## Known limitations (owner action)

- **Alchemy accelerator not yet enabled**: `ALCHEMY_API_KEY` is set in the
  environment, but the Alchemy app doesn't have the Robinhood Chain network
  enabled (`ROBINHOOD_MAINNET is not enabled for this app` — verified live
  during development). The worker runs correctly against the public RPC
  without it; enabling it would mainly cut RPC latency, not add capability.
  Enable at `https://dashboard.alchemy.com/apps/<app>/networks`.
- **Public RPC rate limits**: the public `rpc.mainnet.chain.robinhood.com`
  has no documented SLA. Under sustained load, point `RH_RPC_URL` at a paid
  provider (Alchemy, once enabled).

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
