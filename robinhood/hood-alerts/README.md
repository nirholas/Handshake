# hood-alerts

[![license](https://img.shields.io/badge/license-MIT-93a1af?labelColor=101418)](./LICENSE)

The alert layer for **Robinhood Chain** (chain ID 4663): Telegram and Discord bots backed by one
shared detection engine that watches launches, graduations, whale trades, Stock Token price moves,
on-chain premium/discount arbitrage, holder milestones, and liquidity-pull rug warnings. Free tier
plus x402 USDG premium.

## What it detects

| Detector | Topic | Source |
| --- | --- | --- |
| New token launch | `launches` (`launches:noxa`, `launches:odyssey`) | NOXA (instant Uniswap v3 pool) and The Odyssey (bonding curve) |
| Bonding-curve graduation | `graduations` | Odyssey curve fills and migrates to a locked Uniswap v3 pool |
| Whale trades | `whales`, or per-token `token:0x…` | Odyssey curve trades and Uniswap v3 swaps, chain-wide, threshold in USD |
| Stock Token price moves | `stock:SYMBOL` | Chainlink feed, rolling window, signed percent change |
| On-chain premium/discount (the arb signal) | `premiums` (premium tier) | DEX mid vs Chainlink feed, hysteresis ladder at 1/2/3/5/10/20/50% |
| Holder milestones | per-token `token:0x…` | Blockscout `token_holders_count`, crossing 10 through 100,000 |
| Liquidity-pull rug warning | `rugs` (premium tier), or per-token `token:0x…` | tracked pool's quote-side (USDG/WETH) reserves dropping sharply |

Every event is deduped per fingerprint before it reaches a subscriber, routed through a
premium/quiet-hours/digest gate, and rendered as a platform-native card (Telegram HTML, Discord
embed, or a structured console log line) with links back to the chain explorer and
`three.ws/markets/robinhood`.

## Quickstart (self-host)

```sh
npm install
npm run dev     # tsx watch, console transport only if no bot tokens are set
```

With zero environment variables the engine still runs: detectors connect to the public Robinhood
Chain RPC, alerts print as structured JSON log lines (the console transport), and `/healthz` comes
up on `:8080`. That is the self-host smoke-test mode. Copy `.env.example` to `.env` and fill in a
Telegram and/or Discord bot token to go live on those platforms; see `.env.example` for every
variable, defaults, and what each detector threshold controls.

```sh
npm run build   # tsc -> dist/
npm start       # node dist/src/index.js
```

### Creating the bots

- **Telegram**: message [@BotFather](https://t.me/BotFather), `/newbot`, paste the token into
  `HOOD_ALERTS_TELEGRAM_TOKEN`. The bot registers its command list on startup.
- **Discord**: create an application at the
  [Developer Portal](https://discord.com/developers/applications), add a bot, copy the bot token
  into `HOOD_ALERTS_DISCORD_TOKEN` and the application id into `HOOD_ALERTS_DISCORD_APP_ID`. Slash
  commands register (guild-visible immediately) on startup.

Leaving either token unset disables that transport; the engine and the console transport keep
running regardless.

## Bot commands

Both bots share one command router (`src/commands/commands.ts`), so the UX is identical modulo
native slash-command vs `/command arg` syntax:

```
watch <what> [threshold]
  launches            every new token (add noxa/odyssey to filter)
  graduations         Odyssey curves migrating to Uniswap v3
  whales [usd]        trades >= usd, chain-wide (default 5000)
  premiums [pct]      Stock Token DEX premium/discount vs Chainlink (premium tier)
  rugs [pct]          liquidity-pull rug warnings (premium tier)
  <TICKER>            a Stock Token: price moves + premium crossings (e.g. TSLA)
  <0x address>        a memecoin: whale trades, graduation, holders, liquidity

unwatch <what|all>    stop watching
list                  your subscriptions
threshold <what> <n>  change a subscription's threshold
digest on|off [min]   batch alerts into digests (default 60 min)
quiet <from> <to>     quiet hours in UTC (e.g. quiet 22 7); quiet off
premium               premium status + how to upgrade
help                  this message
```

In a group chat or server, `watch`, `unwatch`, `threshold`, `digest`, and `quiet` are restricted to
admins; `list`, `premium`, and `help` are open to everyone.

## Free vs premium

| | Free | Premium |
| --- | --- | --- |
| Subscriptions | 3 | Unlimited |
| Delivery | Batched to at most one immediate alert per 60s; extras fold into a digest | Real-time, subject only to quiet hours / digest mode you set |
| `premiums` (Stock Token arb signal) | Not available | Included |
| `rugs` (liquidity-pull warning) | Not available | Included |
| Price | Free | `HOOD_ALERTS_PREMIUM_PRICE_USDG` (default 5) USDG for `HOOD_ALERTS_PREMIUM_DAYS` (default 30) days |

Premium is paid on Robinhood Chain via **x402** using [`hood402`](../hood402) (USDG,
EIP-3009 `transferWithAuthorization`, chain 4663). The bot's `premium` command hands back a
`POST /premium/activate?platform=...&chat=...` URL: the first request gets a 402 challenge with
payment instructions, and any x402 client (`hood402`, `x402-fetch`) that can sign a USDG
authorization completes the purchase. The entitlement never activates before the transfer settles
on-chain, so a signature alone buys nothing.

Purchases stay disabled (`503` + setup instructions) until the instance sets `HOOD402_PAY_TO` and
either `HOOD402_FACILITATOR_URL` (delegates verification and settlement, no gas key on this box) or
`HOOD402_SETTLER_KEY` (this instance broadcasts the settlement itself). See `.env.example` for both
modes.

## HTTP API

The same process that runs the bots serves a small Hono app on `PORT` (default 8080):

| Endpoint | Method | Returns |
| --- | --- | --- |
| `/` | GET | service metadata and endpoint list |
| `/healthz` | GET | uptime, last detector event time, per-event-type counts, whether premium purchases are enabled |
| `/premium/status?platform=telegram\|discord\|console&chat=<id>` | GET | `{ tier: 'free' \| 'premium', expiresAt }` for that chat |
| `/premium/activate?platform=...&chat=...` | POST | the x402 purchase flow: 402 challenge, then 200 + entitlement once payment settles |

## Example: reading the alert engine's pure logic directly

`src/engine/gate.ts` and `src/engine/topics.ts` have no I/O and are safe to import standalone, for
example to preview how a threshold will gate before wiring a subscription:

```ts
import { gate } from './src/engine/gate.js'
import { resolveWatchTarget, parseTopic } from './src/engine/topics.js'

const target = resolveWatchTarget('whales') // { ok: true, topic: 'whales' }
if (target.ok) {
  const topic = parseTopic(target.topic) // { kind: 'whales' }
  const decision = gate(
    { premium: false, digest: false, quietStart: null, quietEnd: null, lastDeliveredAt: null, deliveredLastMinute: 0 },
    Math.floor(Date.now() / 1000),
  )
  console.log(topic, decision) // { kind: 'whales' } { action: 'deliver' }
}
```

A threshold typed after the target (`watch whales 10000`) is parsed separately by
`Commands.watch()`, not by `resolveWatchTarget` itself.

The package does not ship a public library entry point today (`main`/`bin` both point at the CLI
process in `src/index.ts`, which starts the bots and the HTTP server and does not export anything);
importing from `src/` as above works in this checkout but is not a published API contract.

## Configuration

Every variable, its default, and what it controls: [`.env.example`](.env.example). Highlights:

- `HOOD_ALERTS_RPC_URL` — custom RPC; defaults to viem's public `robinhood` chain RPC.
- `HOOD_ALERTS_DB` — SQLite path (subscriptions, entitlements, dedup, delivery log). `:memory:`
  works for tests.
- `HOOD_ALERTS_WHALE_FLOOR_USD` / `HOOD_ALERTS_WHALE_DEFAULT_USD` — engine-side emission floor vs.
  the default per-subscription threshold.
- `HOOD_ALERTS_PRICE_WINDOW_S` / `HOOD_ALERTS_PRICE_DEFAULT_PCT` — Chainlink rolling-window move
  detector.
- `HOOD_ALERTS_PREMIUM_POLL_S` / `HOOD_ALERTS_PREMIUM_DEFAULT_PCT` — Stock Token arb poll cadence
  and default ladder entry.
- `HOOD_ALERTS_RUG_DEFAULT_PCT` — default liquidity-pull threshold (percent of quote reserves).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
npm test            # vitest: dedup/rate-limit gate, digest batching, topic parsing and
                     # matching, event fingerprinting/TTL, alert card rendering, config
                     # loading, the command router, and the subscriber/entitlement/delivery
                     # repositories — all offline, no chain or bot credentials required
npm run build       # tsc -> dist/
```

The `whale-classify` and `detectors` suites run against **real captured mainnet event streams** in
`tests/fixtures/` (real Uniswap v3 swaps, Odyssey bonding-curve trades, and Chainlink prices).
Refresh them any time with `npm run capture-fixtures`, which re-reads live chain 4663.

`npm run test:live` and `npm run probe` exercise the live detector set against real Robinhood Chain
RPC and, for `probe`, the console transport; they need real network access and are not part of the
offline unit suite above. `npm run grant-premium` comps or inspects a premium entitlement directly
in the database (handy for testing premium delivery before a payment rail is wired).

### Local sibling packages

`hood402`, `hoodkit`, and `hoodchain` are consumed as `file:` dependencies of the other Robinhood
Chain repos in this workspace (`../hood402`, `../hoodkit`, `../robinhood-chain-sdk`) rather than
their published npm versions, so a change to any of them is picked up on the next `npm install`
here. A `file:` link keeps each sibling's own `viem` copy, so a patch-level skew (e.g. `2.55.2`
here vs `2.55.1` in `hood402`) makes viem's structural `Chain` / `WalletClient` types diverge across
the two copies. `src/premium/paywall.ts` bridges that boundary explicitly (casting the local viem
clients to `hood402`'s `HoodBroadcaster` / `HoodConfirmer`), so the build stays green across a patch
skew; the runtime objects are the same correct viem clients. Once the siblings are on npm and a
single `viem` resolves, the cast is a no-op.

## Deploy

hood-alerts is one long-running process (engine + HTTP server + both bots), so run it as a service
with a warm instance, not a job.

Because the sibling packages are `file:` links, the Docker build context is the **parent
`robinhood/` directory** so they resolve:

```sh
# from robinhood/ (the parent of hood-alerts/)
docker build -f hood-alerts/Dockerfile -t hood-alerts .

gcloud run deploy hood-alerts \
  --image=REGION-docker.pkg.dev/PROJECT/repo/hood-alerts:latest \
  --min-instances=1 --no-cpu-throttling --port=8080 \
  --set-env-vars=HOOD_ALERTS_TELEGRAM_TOKEN=…,HOOD_ALERTS_DISCORD_TOKEN=…,HOOD_ALERTS_DISCORD_APP_ID=…
```

Mount a volume at `/data` (the default `HOOD_ALERTS_DB` path) so subscriptions, entitlements, and
the delivery log survive restarts. The container answers `GET /healthz`; `SIGTERM` flushes pending
digests before exit. Once the siblings are published to npm, switch the `file:` specs in
`package.json` and the image builds from the `hood-alerts/` directory alone. Full self-host and
premium-wiring guide: the `docs/` site.

## Docs site (GitHub Pages)

`docs/` is a static, hand-built site (no framework, no build step): open `docs/index.html` locally,
or serve it from GitHub Pages. Its landing page renders a **live** premium/discount feed client-side
straight from the public RPC (real Chainlink feeds vs real DEX pools, no server). One-time setup:
Settings -> Pages -> Deploy from a branch -> `main` -> `/docs`.

## Architecture notes

- **Console transport is not a fallback, it's the smoke-test mode.** With no bot tokens configured
  the engine still ingests real chain events and logs every alert/digest as structured JSON; that
  is how a fresh self-host proves the pipeline works before touching Telegram or Discord.
- **The entitlement never activates before settlement.** `PremiumPaywall.activate()` calls
  `hood402`'s verify-then-settle flow and only writes the entitlement row after the on-chain
  transfer succeeds.
- **Digest buffering is in-memory by design.** A restart loses at most one pending batch, never a
  subscription (subscriptions and the delivery log are in SQLite); `AlertEngine.stop()` flushes
  every buffered digest before shutdown.
- **Auto-tracked pools expire; watched pools do not.** A NOXA/Odyssey launch or graduation starts a
  24h rug-watch on its pool automatically; a user `watch 0x…` keeps that pool's liquidity monitor
  running indefinitely.

## Repo layout

```
src/index.ts                 CLI entry: wires config, db, engine, detectors, transports, HTTP server
src/config.ts                environment -> validated Config
src/server.ts                Hono app: /, /healthz, /premium/status, /premium/activate
src/engine/                  event types, dedup fingerprinting, topic parsing/matching, the
                              digest buffer, the delivery gate, and the live detector set
src/engine/detectors/        pure per-signal detectors (price move, premium ladder, holder
                              milestones, liquidity pull, whale classification) plus live.ts,
                              which wires them to hoodchain/hoodkit streams
src/db/                      better-sqlite3 repositories: subscribers, entitlements, deliveries
src/premium/paywall.ts       the hood402 x402 purchase flow
src/transports/              Telegram (grammY), Discord (discord.js), and console transports
src/commands/commands.ts     the shared, platform-neutral command router
src/format/cards.ts          alert -> platform-neutral card -> per-platform rendering
tests/                       vitest unit suite + tests/fixtures (real captured chain events) +
                             tests/live (opt-in on-chain reads)
scripts/                     capture-fixtures, live-probe, grant-premium (see Development above)
docs/                        static GitHub Pages site with a live client-side premium feed
Dockerfile                   one-container build (engine + both bots), build from robinhood/
```

## Notes

- **Stock Tokens.** Stock Tokens are tokenized debt securities (issuer: Robinhood Assets (Jersey)
  Ltd) and may not be offered, sold, or delivered to US persons (additional limits: Canada, UK,
  Switzerland). hood-alerts only ever displays price/premium data derived from public Chainlink
  feeds and DEX pools; it never facilitates acquiring a Stock Token.
- Liquidity-pull alerts are an early warning, not proof of a rug: always check the pool before
  acting on one.
- Not affiliated with Robinhood Markets, Inc.

## License

MIT. See [LICENSE](./LICENSE).

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
