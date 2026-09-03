# Autonomous x402 Loop

The autonomous x402 loop is the engine that makes three.ws an **active
participant** in the x402 agent-to-agent economy rather than just a passive
facilitator. On a schedule it pays — with real USDC over x402 — to call our own
paid endpoints (and a bounded set of external, bazaar-discovered services),
turning the results into market intel, health checks, and analytics the rest of
the platform consumes.

This is the system that already does "an agent buys polling information": the
loop's seeder wallet pays per call for crypto/token intel and feeds the result to
the sniper oracle gate.

> Source: [`api/cron/x402-autonomous-loop.js`](../api/cron/x402-autonomous-loop.js),
> registry [`api/_lib/x402/autonomous-registry.js`](../api/_lib/x402/autonomous-registry.js),
> pipelines under `api/_lib/x402/pipelines/`.

---

## How a tick works

The loop runs from the `x402-autonomous-loop` cron endpoint, invoked every
**minute** by the `economy-tick` dispatcher (see the
[economy heartbeat](economy-heartbeat.md)) rather than by its own schedule
entry; per-entry Redis cooldowns decide what actually fires on any given tick.
Each tick:

1. Selects up to `X402_AUTONOMOUS_MAX_PER_TICK` **ready** registry entries —
   those whose Redis cooldown has elapsed — sorted by priority descending.
2. For each entry, probes the endpoint for a `402` challenge, builds a Solana
   USDC payment, and fires the request with an `X-PAYMENT` header.
3. If the paid replay itself answers `402`, re-fetches the challenge once and
   settles against the **fresh** requirements before giving up. A 402 on the
   replay means the endpoint refused the proof (a re-quote between probe and
   replay, or re-issued requirements), and the signed transfer is never
   broadcast in that case, so no money moved and one retry is safe. The retry is
   bounded at one attempt, re-applies the spend cap and the recipient allowlist
   to the new quote, and is reported as `retriedAfter402` by the buyer client.
4. Records every call (success **and** failure) to `x402_autonomous_log`.
5. For `oracle` / `sniper` pipeline entries, extracts signal data and upserts it
   into `oracle_intel_signals` for the sniper oracle gate to consume.
6. Enforces a **daily USDC spend cap** across all calls in the loop.

Payments are real on chain — no mocks, no simulations.

Two per-tick balance reads act as hard pause switches in front of every paid
call, because neither cap above can see them: the payer's **USDC float** (an
empty float skips paid entries instead of signing payments that die at settle
with "Simulation failed") and the sponsor fee wallet's **SOL settle floor**
(below `X402_SPONSOR_SOL_FLOOR_LAMPORTS` the self-facilitator fail-closes every
sponsor-mode settle, so the loop skips paid entries rather than hammering
hundreds of doomed 502s per hour). Both fire one deduped CRITICAL ops alert
naming the wallet; free endpoints and `run()`-style monitors keep running while
paused, and `api/cron/treasury-topup` refuels the wallets when the economy
master holds funds.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `X402_SEED_SOLANA_SECRET_BASE58` | _(preferred)_ | The seeder keypair that pays for calls. |
| `X402_AGENT_SOLANA_SECRET_BASE58` | _(fallback)_ | Used if the seeder secret is absent. |
| `X402_AUTONOMOUS_ENABLED` | enabled | Set to `false` to pause without removing entries. |
| `X402_AUTONOMOUS_MAX_PER_TICK` | `12` | Max calls per cron tick. Raised from the original demo curve (8) to serve more of the ready backlog each tick; per-endpoint cooldowns still gate how often any one endpoint is hit. |
| `X402_AUTONOMOUS_DAILY_CAP_ATOMIC` | `15000000` ($15) | Daily USDC cap across the whole loop, in 6-decimal atomics. Raised from $5 so the higher per-tick throughput isn't money-starved mid-day; still a hard, env-tunable ceiling enforced per tick. |
| `X402_VOLUME_BATCH_PER_RUN` | `6` | Volume Bootstrap Loop: endpoints swept per run (cursor advances by this). Default sized so a default-cadence hour covers the full autobuy rotation — trailing-30-day settle activity is what keeps endpoints ranked on the x402 discovery surfaces. |
| `X402_VOLUME_PER_RUN_CAP_ATOMIC` | `1100000` ($1.10) | Volume Bootstrap Loop: self-imposed per-run cap, on top of the daily cap, so one tick can't drain the day. Floor set by `RING_SETTLE_DEFAULT_PRICE_ATOMICS` ($1.00): drop below it and the config validator raises `ring_price_exceeds_run_cap` and the ring skips `ring-settle` every tick. Source of truth: [`api/_lib/x402/ring-constants.js`](../api/_lib/x402/ring-constants.js). |
| `X402_DATAPOINT_SWEEP_BATCH` | `6` | Datapoint Fabric Volume Sweep: distinct datapoint URLs settled per run (cursor advances by this over the ~5k-URL live pool). |
| `X402_DATAPOINT_SWEEP_CAP_ATOMIC` | `50000` ($0.05) | Datapoint Fabric Volume Sweep: self-imposed per-run cap, on top of the shared daily cap. |
| `CRON_SECRET` | _(required)_ | Shared secret authorizing cron invocations (Cloud Scheduler). |
| `X402_ASSET_MINT_SOLANA` | USDC mint | The asset paid with (Solana USDC). |
| `SOLANA_RPC_URL` | — | RPC used to build and submit the payment. |

This loop's treasury is **separate** from the [circulation engine](circulation-engine.md)
treasury (`CIRCULATION_TREASURY_SECRET`). Circulation funds agent-to-agent SOL /
$THREE activity; this loop funds USDC intel purchases. They do not fund each
other.

The seeder wallet is the same keypair the ring economy calls the
`x402-ring-payer` signer role, and it **refills its own USDC**: the
`economy-rebalance` cron (every 30 minutes) swaps a capped slice of the wallet's
own SOL into USDC whenever its USDC float drops below a floor (default $10,
`ECONOMY_REBALANCE_RING_USDC_FLOOR`). The rebalancer is inert (dry-run plan
only) unless `ECONOMY_REBALANCE_ENABLED=1`, and every swap is reserve-,
per-swap-, per-run- and slippage-capped.

## The registry

Every scheduled call is a registry entry in `autonomous-registry.js`. An entry
declares:

| Field | Purpose |
|---|---|
| `id` | Unique key; also the Redis cooldown key. |
| `name` | Human label for logs and analytics. |
| `path` | URL path (self-call) or full URL (external bazaar service). |
| `method`, `body` | Request shape; `body` may be a function of the run context. |
| `cooldown_s` | Minimum seconds between calls. |
| `priority` | 1–100; higher wins when several entries are ready. |
| `pipeline` | Tag grouping related entries. In production today: `health`, `oracle`, `volume`, `self`, `finance`, `discovery`, `sniper`, `agents`, `security`, `reconciliation`, `datapoint`, `qa`, `forge`, `external`, `circuit-breaker`, and a few singletons (`reliability`, `observability`, `feed`, `commerce`, `canonicalize`). |
| `enabled` | Set `false` to pause an entry. |
| `extractSignal` | Optional: maps the response into `signal_data` (for oracle entries, `{ mint?, signal, confidence, headline }`). |
| `resolveTarget` | Optional: computes the request path dynamically per call (for entries that rotate over a set of resources). |
| `storeValue` | Optional: persists the extracted value to a dedicated table; wrapped in try/catch so a DB failure never crashes the tick. |
| `run` | Optional: owns a full multi-call sequence (its own payments, recording, extraction) and returns one summary row. |

## Pipelines

The registry groups entries into pipelines. The main ones in production:

- **`oracle`** — pays for our own `crypto-intel` (SOL / BTC / ETH / $THREE /
  pump), `token-intel`, USDC peg monitoring, pump volume/whale anomaly scans,
  fact-checks, bazaar price trends and new-listing scans, and skill-marketplace
  price distribution. Results upsert into `oracle_intel_signals`.
- **`sniper`** — token-intel pre-snipe gate and sniper intel enrichment that feed
  the sniper's entry decisions.
- **`discovery` / `external`** — bazaar discovery warmup and catalog refresh that
  sweep external x402 service categories so the platform's directory stays fresh.
- **`health` / `circuit-breaker`** — wallet-balance monitors, cross-network
  circuit-breaker probes, club/social analytics.
- **`security`** — payment-proof idempotency and API-key bypass audits that
  exercise our own payment guards end to end.
- **`volume`** — small, bounded activity entries that keep the economy's heartbeat
  visible, including the **Volume Bootstrap Loop** (see below).
- **`reconciliation`** — the daily financial-integrity job (see below).
- **`qa` / `forge` / `self`** — animation-retarget QA, forge content generation,
  GLB size optimization, avatar thumbnail regeneration.

To pause any entry without a deploy, set its `enabled: false`; to pause the whole
loop, set `X402_AUTONOMOUS_ENABLED=false`.

## The Volume Bootstrap Loop (`volume-bootstrap-loop`)

One registry entry — `volume-bootstrap-loop`, pipeline `volume`, cooldown 300s —
owns a full sweep rather than a single call. On each run it advances a
Redis-backed round-robin cursor, reserves the next `X402_VOLUME_BATCH_PER_RUN`
endpoints from the autobuy rotation in
[`api/_lib/x402/ring-catalog.js`](../api/_lib/x402/ring-catalog.js) (mapped into
the shared driver by [`pipelines/volume-shared.js`](../api/_lib/x402/pipelines/volume-shared.js)),
and pays each one a real on-chain USDC payment at that endpoint's own price
(from $0.001 for the cheap probes up to $1.00 for `ring-settle`, the rotation's
largest single call). It respects both
the loop's daily cap and its own `X402_VOLUME_PER_RUN_CAP_ATOMIC` per-run cap. It
records every call in `x402_autonomous_log` and upserts the per-endpoint ledger
`x402_volume_metrics` (call / success / fail counts, total + last USDC spent, last
tx signature, liveness timestamps). To add an endpoint to the sweep, add it to
`ring-catalog.js` with `autobuy: true` — the cursor and ledger pick it up
automatically (and `tests/x402-ring-catalog.test.js` fails until it is cataloged).

> **This is synthetic, not organic.** The sweep pays our **own** endpoints from
> our **own** seed wallet; the USDC round-trips back to the platform treasury. It
> is a **liveness canary + proof-of-volume** mechanism, deliberately kept small —
> not external demand. Treat `x402_volume_metrics` as monitoring, and exclude the
> seed wallet's `payer` from any "marketplace volume" or facilitator-ranking
> number you publish. Scaling this loop to manufacture a big volume figure is wash
> volume: real transactions, fake demand, and detectable on-chain.
> Drive *real* volume through external demand (the
> [Circulation engine](circulation-engine.md), real `agent_hire` commerce,
> discovery), not a heavier self-paid sweep.

**Excluding it is mechanical, not a matter of remembering to.**
`api/_lib/x402/revenue-split.js` classifies every settled payment in
`x402_audit_log` into three buckets by payer: `internal` (any
platform-controlled wallet, resolved through `ringAllowedAddresses()`),
`synthetic` (a payer string that is not a plausible on-chain address at all, such
as the literal `PAYER` written by replay-test paths), and `external` (a real
address we do not control). Only the last one is revenue.

```bash
npm run readout:revenue                 # trailing 30 days
npm run readout:revenue -- --window all # all time
npm run readout:revenue -- --json       # machine-readable
```

The same split ships as `revenue_split` on the `x402_volume` report of the paid
`/api/x402/analytics` endpoint, so a buyer reading `total_usdc_paid` can see what
share of it is our own money, and the volume loop's own
`x402_autonomous_log.signal_data` now carries `external_usdc` beside the gross
figure.

The classification is deliberately conservative in one direction. If the
controlled-wallet registry (`x402_ring_wallets`) returns no enabled rows, the
ring's own wallets would be classified as external customers and the headline
number would inflate. The split reports `confident: false` with the reason
instead, and the readout script exits 2 rather than printing a figure it cannot
stand behind. An unavailable split is reported as `null`, never as a confident
zero: "we could not classify" and "there was no external revenue" are different
claims.

## The Datapoint Fabric Volume Sweep

One registry entry — `datapoint-volume-sweep`, pipeline `datapoint`, cooldown
300s, settles real on-chain USDC against the
[datapoint fabric](market-data-api.md#the-datapoint-fabric--1000000-standalone-endpoints)
(the 1,000,000+ endpoints served by the single `api/x402/d/[...path].js` route),
which the Volume Bootstrap Loop above never touches (its rotation is the ~45
*named* catalog endpoints flagged `autobuy: true`). On each run it advances its own Redis-backed cursor
over a pool of concrete datapoint URLs — resolved at runtime from the same cached
feeds the paid route reads, so no third-party id is hardcoded — and pays the next
`X402_DATAPOINT_SWEEP_BATCH` (default 6) of them on Solana through the shared
[`pipelines/volume-shared.js`](../api/_lib/x402/pipelines/volume-shared.js)
`settleAndRecord` path. A datapoint is the cheapest call in the catalog
($0.0005), so this is the most transactions-per-dollar-efficient sweep; over
successive runs the cursor walks the whole ~5k-URL pool, giving each distinct
datapoint URL its own on-chain settlement history. It draws from the **same**
daily cap the main loop respects (`remainingCap`) plus its own
`X402_DATAPOINT_SWEEP_CAP_ATOMIC` per-run cap, so it cannot increase total ring
spend — it only routes a slice of the capped budget at the cheapest endpoints.
No-op (graceful skip, no spend) when the wallet/RPC is unconfigured. See
[`pipelines/datapoint-volume-sweep.js`](../api/_lib/x402/pipelines/datapoint-volume-sweep.js).

> **Same synthetic-vs-organic caveat as the Volume Bootstrap Loop applies.** This
> pays our **own** datapoint endpoints from our **own** seed wallet; the USDC
> round-trips to the treasury. It proves the fabric's payment path settles and
> gives x402scan per-resource settlement history, but it is **canary volume, not
> demand**. Do not publish it as marketplace volume, and do not read a high
> datapoint settle count as external traction — that would be wash volume. Real
> ranking comes from external buyers, not a heavier self-paid sweep.

## Reconciliation (`revenue-reconciliation`)

The `revenue-reconciliation` entry (pipeline `reconciliation`, cooldown 86400s —
**daily**) is the financial-integrity watchdog. It cross-checks every record that
claims an on-chain settlement — outbound `x402_autonomous_log` rows and inbound
`agent_payment_intents` — against the actual Solana transaction via
`getSignatureStatuses`, and upserts a verdict per record into
`payment_reconciliation`. It is **read-only**, so it runs even with no spend
wallet configured (keyless RPC; the `/api/x402-status` probe it reads is free). A
`reconciled = false` row means the books claim a settlement the chain does not
corroborate — the ops financial-integrity surface alerts on those. Detail:
[Financial controls](financial-controls.md).

## Where results land

| Sink | Written by |
|---|---|
| `x402_autonomous_log` | Every call (success or failure), with `signal_data` / `value_extracted`. `error_msg` is reserved for calls that actually failed: the external uptime monitor probes third-party services for free and records an alive-but-unexpected status (a templated path answering 400, a verb-picky route answering 405) in `value_extracted.status` only, so a liveness observation never lands in the loop's failure stats. |
| `oracle_intel_signals` | `oracle` / `sniper` entries, keyed by source + topic; consumed by the sniper oracle gate. Each row carries `tx_signature`, the settle signature of the paid call that bought it, so a gate decision can cite its receipt (surfaced as `signal_receipts` on gate results). |
| `forge_creations` | Every settled `POST /api/x402/forge` generation (any buyer, not just this loop). The row lands in the public community gallery with `x402_payer` / `x402_tx_sig` / `x402_price_atomic` provenance; the gallery renders a Solscan-linked "x402 · $price" badge. Inline-done lanes materialize immediately; async lanes store the full job token and `api/cron/forge-finalize` completes them server-side. |
| `agent_custody_events` | The USDC spend, with `category: 'x402'` (see [Money feed](money-feed.md)). |
| `x402_volume_metrics` | Per-endpoint proof-of-volume + liveness ledger from the Volume Bootstrap Loop. |
| `payment_reconciliation` | One verdict per settlement claim from the daily reconciliation job (see [Financial controls](financial-controls.md)). |
| Dedicated stores | Pipeline-specific tables (pricing tracker, reputation snapshots, leaderboard, sniper analytics, …). |

## Related

- [x402 endpoints](x402-endpoints.md) — the paid endpoints this loop calls.
- [Financial controls](financial-controls.md): where settlements land and how the reconciliation job audits them.
- [x402 buyer client](x402-buyer.md) — the client wrappers it pays with.
- [Circulation engine](circulation-engine.md) — the separate SOL/$THREE activity loop.
