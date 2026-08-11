# agent-orders — Programmable Orders Engine worker

Set-and-forget institutional order tooling for memecoins. Pump.fun has no native
order types; this worker gives every agent wallet a real programmable order layer:
**limit**, **stop**, **trailing stop**, **DCA**, **TWAP**, and validated
**conditional triggers** ("buy when smart-money score > 60 and mcap < $40k", "sell
if the dev dumps", "buy on graduation").

## What it does

Every `ORDERS_POLL_MS` it sweeps all `active`/`partial` orders, re-quotes each
mint off **live on-chain state** (bonding curve → AMM after graduation), evaluates
the trigger/schedule, and on a match fires the order through
`executeAgentTrade` (`api/agents/agent-trade.js`) — the **same** pipeline the
owner-driven trade endpoint uses:

```
quote → rug/honeypot firewall → spend guards (kill switch, per-trade cap,
daily budget, USD ceiling) → custody claim → MEV-aware sign+confirm → audit
```

The orders worker adds **no new way to move funds** — it only decides *when* to
call that one audited path. Every fill is firewall-gated, capped by the agent's
spend policy, and written to `agent_custody_events` (the canonical spend ledger),
with an `order_fills` receipt linking back to it.

## Order lifecycle

`active → firing → filled` (price/conditional, single fill) ·
`active → partial → … → filled` (DCA/TWAP, one slice per interval) ·
`→ cancelled` (instant, owner) · `→ expired` (deadline) · `→ error` (a terminal
block such as a firewall rug verdict).

- **Idempotent.** Each fire claims its order atomically (`active|partial → firing`)
  so exactly one sweep fires it; across processes the custody `idempotency_key`
  (`order:<id>:slice:<n>`) is the double-spend backstop.
- **Per-agent serialized.** An agent's orders run under a per-agent lock so two
  orders can't both pass the daily-budget check on the same stale total.
- **Honest on data gaps.** No live quote → the order holds (never fires on a
  missing/zero price). A conditional with a missing signal does not fire.
- **Self-healing.** Stale `firing` claims (a crash mid-fire) are recovered each
  sweep; expired deadlines are swept to `expired`.

## Triggers

| Type | Fires when |
|------|------------|
| `limit` buy / sell | metric ≤ target (dip) / ≥ target (rise) |
| `stop` sell / buy | metric ≤ stop (stop-loss) / ≥ stop (breakout) |
| `trailing` sell / buy | metric ≤ peak·(1−trail%) / ≥ trough·(1+trail%) |
| `dca` | `next_fire_at ≤ now`, one slice per interval, N slices |
| `twap` | same scheduling; slices ONE total order to cut impact |
| `conditional` | a validated `{ all\|any: [{ signal, op, value }] }` is true |

`trigger_metric` ∈ `price_sol | mcap_sol | mcap_usd`. Conditional signals:
`price_sol`, `mcap_sol`, `mcap_usd`, `price_change_pct`, `smart_money_score`,
`dev_dump`, `graduated` — all real, code-free (see `api/_lib/orders.js`).

## Run

```bash
npm run worker:orders          # ORDERS_MODE=simulate (real quotes, no broadcast)
npm run worker:orders:live     # ORDERS_MODE=live (real fills)
```

Both scripts load the repo-root `.env` if it exists (`node --env-file-if-exists`),
so a local run needs no extra flags. The container sets its env from Cloud Run
instead and ships no `.env`. On boot the worker prints one JSON line per event
(`boot`, `housekeeping`, `fill`, …) and writes a `bot_heartbeat` row under the
worker name `agent-orders`, which is the fastest liveness check:

```sql
SELECT mode, last_beat_at, meta FROM bot_heartbeat WHERE worker = 'agent-orders';
```

### Env

`loadConfig` (`config.js`) validates all of this once at boot and throws rather
than start half-configured.

| Var | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL`, `JWT_SECRET` | none | required (any `POSTGRES_URL`/`NEON_DATABASE_URL` alias also satisfies the first) |
| `WALLET_ENCRYPTION_KEY` | none | required in `live` mode: it decrypts the custodial agent key. Wrong/absent, every fill dies at key recovery and retries forever |
| `ORDERS_NETWORK` | `mainnet` | `mainnet`\|`devnet` |
| `ORDERS_MODE` | `simulate` | `live` also requires `SOLANA_RPC_URL` or `HELIUS_API_KEY` |
| `ORDERS_POLL_MS` | `10000` | sweep cadence, floored at 3000 |
| `ORDERS_CONCURRENCY` | `4` | agents evaluated in parallel per sweep, clamped to 1-16 |
| `ORDERS_STALE_FIRING_MS` | `180000` | recover crash-orphaned `firing` claims older than this, floored at 60000 |
| `ORDERS_GLOBAL_KILL` | `0` | halt all fires (orders untouched; cancel still works via the API) |
| `ORDERS_HEARTBEAT_MS` | `30000` | `bot_heartbeat` liveness write (0 disables) |

The worker never serves user traffic, so it needs no rate-limit backend; the
execution path touches Postgres and Solana RPC only.

## Tests

```bash
npx vitest run tests/orders-engine.test.js tests/agent-orders-sweep.test.js
```

`tests/orders-engine.test.js` covers the pure rule layer (`api/_lib/orders.js`:
validation, condition evaluation, price predicates).
`tests/agent-orders-sweep.test.js` covers this worker: that a matched trigger
fires exactly once through `executeAgentTrade` with the custody idempotency key,
that a missing quote holds instead of firing, that terminal vs clearable blocks
land in `error` vs back in `active`, DCA slice advance, per-agent serialization,
and the boot-config guards. Only the chain reads and the trade executor are
stubbed, so the real store SQL and the real trigger predicates run.

## Deploy

**Status: built and wired, not yet running in production.** There is no
`agent-orders` Cloud Run service or job in `aerial-vehicle-466722-p5` today, so no
order fires on its own until someone runs the command below. Orders created
through the API sit in `active` until then, which is the honest failure mode
(nothing fires early, nothing fires wrong). Deploys are owner-gated; everything
else is ready.

The target is Cloud Run as a **background-daemon service**, like `agent-sniper`.
It isn't request-driven, but `index.js` binds a liveness endpoint on `$PORT` so
the startup probe passes; `--no-cpu-throttling` + `--min-instances=1` keep the
sweep timer ticking between probes. One command, from the repo root:

```bash
gcloud builds submit --config workers/agent-orders/cloudbuild.yaml . \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

`SHORT_SHA` is only auto-populated for trigger-driven builds; a manual submit
must pass it or the image tag comes out empty. The four secrets the config mounts
(`agent-orders-database-url`, `agent-orders-jwt-secret`,
`agent-orders-wallet-encryption-key`, `agent-orders-solana-rpc-url`) already exist
and are readable by the `three-ws@` runtime service account; their values are
verified identical to what `three-ws-api` runs with. Do **not** repoint them at
the project's generic `JWT_SECRET` / `WALLET_ENCRYPTION_KEY` secrets: those hold
older values and would break custodial key recovery on every live fill.

It ships in `ORDERS_MODE=simulate` (real quotes, no broadcast). Flip
`_ORDERS_MODE=live` (build substitution) or update the running service's
`ORDERS_MODE` only after agent wallets are funded. It can equally run as a Cloud
Run **Job** (jobs get no startup probe, so `PORT` is unset and no listener binds;
the sweep loop is unaffected either way).

Build it locally the same way Cloud Build does:

```bash
docker build -f workers/agent-orders/Dockerfile -t agent-orders .
```

The build context is the repo root because the image copies `api/`, `src/`, and
the `agent-payments-sdk` workspace it compiles. On a machine that also holds
built `dist/` artifacts that context is multi-GB; the image needs none of it, so
a slow or memory-starved local build is the context walk, not the build.

The migration is
`api/_lib/migrations/20260623160000_programmable_orders.sql` (`npm run db:migrate`).
The owner-facing surface is the **Orders** tab in the agent wallet hub
(`src/agent-wallet-hub/tabs/orders.js`), backed by `/api/agents/:id/orders`.
