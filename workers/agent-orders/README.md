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

### Env

| Var | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL`, `JWT_SECRET` | — | required |
| `ORDERS_NETWORK` | `mainnet` | `mainnet`\|`devnet` |
| `ORDERS_MODE` | `simulate` | `live` requires `SOLANA_RPC_URL` or `HELIUS_API_KEY` |
| `ORDERS_POLL_MS` | `10000` | sweep cadence (min 3000) |
| `ORDERS_CONCURRENCY` | `4` | agents evaluated in parallel per sweep |
| `ORDERS_STALE_FIRING_MS` | `180000` | recover crash-orphaned `firing` claims older than this |
| `ORDERS_GLOBAL_KILL` | `0` | halt all fires (orders untouched; cancel still works via the API) |
| `ORDERS_HEARTBEAT_MS` | `30000` | `bot_heartbeat` liveness write (0 disables) |

## Deploy

Deployed on Cloud Run as a **background-daemon service**, like `agent-sniper`. It
isn't request-driven, but `index.js` binds a liveness endpoint on `$PORT` so the
startup probe passes; `--no-cpu-throttling` + `--min-instances=1` keep the sweep
timer ticking between probes. Build and deploy from the repo root:

```bash
# one-time secret setup is documented in cloudbuild.yaml
gcloud builds submit --config workers/agent-orders/cloudbuild.yaml .
```

It ships in `ORDERS_MODE=simulate` (real quotes, no broadcast). Flip
`_ORDERS_MODE=live` (build substitution) or update the running service's
`ORDERS_MODE` only after the RPC secret is set and agent wallets are funded. It
can equally run as a Cloud Run **Job** — jobs get no startup probe, so `PORT` is
unset and no listener binds; the sweep loop is unaffected either way.

The migration is
`api/_lib/migrations/20260623160000_programmable_orders.sql` (`npm run db:migrate`).
The owner-facing surface is the **Orders** tab in the agent wallet hub
(`src/agent-wallet-hub/tabs/orders.js`), backed by `/api/agents/:id/orders`.
