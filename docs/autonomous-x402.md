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

The loop runs from the `x402-autonomous-loop` cron, scheduled every **5 minutes**
(the `*/5 * * * *` entry in [`vercel.json`](../vercel.json)'s cron list, run by
Google Cloud Scheduler). Each tick:

1. Selects up to `X402_AUTONOMOUS_MAX_PER_TICK` **ready** registry entries —
   those whose Redis cooldown has elapsed — sorted by priority descending.
2. For each entry, probes the endpoint for a `402` challenge, builds a Solana
   USDC payment, and fires the request with an `X-PAYMENT` header.
3. Records every call (success **and** failure) to `x402_autonomous_log`.
4. For `oracle` / `sniper` pipeline entries, extracts signal data and upserts it
   into `oracle_intel_signals` for the sniper oracle gate to consume.
5. Enforces a **daily USDC spend cap** across all calls in the loop.

Payments are real on chain — no mocks, no simulations.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `X402_SEED_SOLANA_SECRET_BASE58` | _(preferred)_ | The seeder keypair that pays for calls. |
| `X402_AGENT_SOLANA_SECRET_BASE58` | _(fallback)_ | Used if the seeder secret is absent. |
| `X402_AUTONOMOUS_ENABLED` | enabled | Set to `false` to pause without removing entries. |
| `X402_AUTONOMOUS_MAX_PER_TICK` | `12` | Max calls per cron tick. Raised from the original demo curve (8) to serve more of the ready backlog each tick; per-endpoint cooldowns still gate how often any one endpoint is hit. |
| `X402_AUTONOMOUS_DAILY_CAP_ATOMIC` | `15000000` ($15) | Daily USDC cap across the whole loop, in 6-decimal atomics. Raised from $5 so the higher per-tick throughput isn't money-starved mid-day; still a hard, env-tunable ceiling enforced per tick. |
| `X402_VOLUME_BATCH_PER_RUN` | `4` | Volume Bootstrap Loop: endpoints swept per run (cursor advances by this). |
| `X402_VOLUME_PER_RUN_CAP_ATOMIC` | `50000` ($0.05) | Volume Bootstrap Loop: self-imposed per-run cap, on top of the daily cap, so one tick can't drain the day. |
| `CRON_SECRET` | _(required)_ | Shared secret authorizing cron invocations (Cloud Scheduler). |
| `X402_ASSET_MINT_SOLANA` | USDC mint | The asset paid with (Solana USDC). |
| `SOLANA_RPC_URL` | — | RPC used to build and submit the payment. |

This loop's treasury is **separate** from the [circulation engine](circulation-engine.md)
treasury (`CIRCULATION_TREASURY_SECRET`). Circulation funds agent-to-agent SOL /
$THREE activity; this loop funds USDC intel purchases. They do not fund each
other.

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
| `pipeline` | Tag: `oracle`, `health`, `volume`, `sniper`, `qa`, `forge`, `discovery`, `security`, `circuit-breaker`, `self`, `external`. |
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

## The Volume Bootstrap Loop (`self/026`)

One registry entry — `volume-bootstrap-loop`, pipeline `volume`, cooldown 300s —
owns a full sweep rather than a single call. On each run it advances a
Redis-backed round-robin cursor, reserves the next `X402_VOLUME_BATCH_PER_RUN`
endpoints from the autobuy rotation in
[`api/_lib/x402/ring-catalog.js`](../api/_lib/x402/ring-catalog.js) (mapped into
the shared driver by [`pipelines/volume-shared.js`](../api/_lib/x402/pipelines/volume-shared.js)),
and pays each one a real on-chain USDC payment ($0.001–$0.01). It respects both
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
> volume — real transactions, fake demand, and detectable on-chain. The full
> reasoning lives in
> [x402 revenue → Synthetic vs organic](x402-revenue.md#proof-of-volume--x402_volume_metrics).
> Drive *real* volume through external demand (the
> [Circulation engine](circulation-engine.md), real `agent_hire` commerce,
> discovery), not a heavier self-paid sweep.

## Reconciliation (`self/027`)

The `revenue-reconciliation` entry (pipeline `reconciliation`, cooldown 86400s —
**daily**) is the financial-integrity watchdog. It cross-checks every record that
claims an on-chain settlement — outbound `x402_autonomous_log` rows and inbound
`agent_payment_intents` — against the actual Solana transaction via
`getSignatureStatuses`, and upserts a verdict per record into
`payment_reconciliation`. It is **read-only**, so it runs even with no spend
wallet configured (keyless RPC; the `/api/x402-status` probe it reads is free). A
`reconciled = false` row means the books claim a settlement the chain does not
corroborate — the ops financial-integrity surface alerts on those. Detail:
[x402 revenue → Reconciliation](x402-revenue.md#reconciliation--payment_reconciliation).

## Where results land

| Sink | Written by |
|---|---|
| `x402_autonomous_log` | Every call (success or failure), with `signal_data` / `value_extracted`. |
| `oracle_intel_signals` | `oracle` / `sniper` entries, keyed by source + topic; consumed by the sniper oracle gate. |
| `agent_custody_events` | The USDC spend, with `category: 'x402'` (see [Money feed](money-feed.md)). |
| `x402_volume_metrics` | Per-endpoint proof-of-volume + liveness ledger from the Volume Bootstrap Loop (see [x402 revenue](x402-revenue.md#proof-of-volume--x402_volume_metrics)). |
| `payment_reconciliation` | One verdict per settlement claim from the daily reconciliation job (see [x402 revenue](x402-revenue.md#reconciliation--payment_reconciliation)). |
| Dedicated stores | Pipeline-specific tables (pricing tracker, reputation snapshots, leaderboard, sniper analytics, …). |

## Related

- [x402 endpoints](x402-endpoints.md) — the paid endpoints this loop calls.
- [x402 revenue & receipts](x402-revenue.md) — where settlements land, the proof-of-volume ledger, and the reconciliation job.
- [x402 buyer client](x402-buyer.md) — the client wrappers it pays with.
- [Circulation engine](circulation-engine.md) — the separate SOL/$THREE activity loop.
