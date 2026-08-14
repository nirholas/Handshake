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

### Sizing a percentage sell (DCA and TWAP differ on purpose)

Both scheduled types accept `sell_pct`, and they mean different things:

- **DCA** measures against the **live bag** every slice. "DCA out 10% an hour"
  disposes 10% of whatever is still held, so the position asymptotes rather than
  closing, which is what a dollar-cost exit is.
- **TWAP** measures against the **bag at creation**. The API divides the owner's
  total across the slices (`total_pct / slices`), so the worker re-bases each
  later slice onto what is left of that promise: `sell 100% over 4 slices`
  disposes a real quarter of the original bag each time and the last slice sells
  the remainder outright. Applying the stored per-slice percentage to the live
  holding instead would dispose 25 / 18.75 / 14.06 / 10.55%, strand ~31.6% of the
  position, and still mark the order `filled`.

One sweep reads at most 500 active orders per network, ordered by
`COALESCE(next_fire_at, last_eval_at, created_at)`: due slices first, then
least-recently-evaluated. Past that cap the work set rotates rather than starving
one side of the book.

## Run

```bash
npm run worker:orders          # ORDERS_MODE=simulate (real quotes, no broadcast)
npm run worker:orders:live     # ORDERS_MODE=live (real fills)
```

Both scripts load the repo-root `.env` **and** `.env.local` if they exist
(`node --env-file-if-exists`, applied in that order so `.env.local` wins), so a
local run needs no extra flags. Loading both matters: in this worktree `.env`
holds only the QA audit login and the worker's own credentials
(`DATABASE_URL`, `JWT_SECRET`, `WALLET_ENCRYPTION_KEY`, `SOLANA_RPC_URL`) live in
`.env.local`. Reading `.env` alone makes the worker die at boot on
`missing required env var: DATABASE_URL`. The container sets its env from Cloud
Run instead and ships neither file. On boot the worker prints one JSON line per event
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
land in `error` vs back in `active`, DCA slice advance, TWAP percentage-sell
re-basing (including the full-exit last slice), per-agent serialization, and the
boot-config guards. Only the chain reads and the trade executor are stubbed, so
the real store SQL and the real trigger predicates run.

Beyond the suites, two checks prove the live edges the stubs replace. The market
reader against `$THREE` on mainnet returns a real graduated-AMM quote:

```bash
node --env-file-if-exists=.env -e "import('./workers/agent-orders/market.js').then(async m => \
  console.log(await m.getSignals({ network: 'mainnet', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' })))"
```

And a short `npm run worker:orders` run writes the heartbeat row and answers the
liveness endpoint (`PORT=8791 npm run worker:orders`, then
`curl localhost:8791`). Both were last exercised on 2026-08-14: the quote came
back as a real graduated-AMM price in ~12 s through the RPC failover chain, and a
30 s boot ran 5 sweeps (427 ms each), answered `/` with
`{"ok":true,"worker":"agent-orders",…}`, wrote `bot_heartbeat`, and drained
cleanly on SIGTERM.

## Deploy

**Status: built and wired, not yet running in production** (re-checked
2026-08-14: no `agent-orders` service, no job, and no image in the `workers`
Artifact Registry repo). No order fires on its own until someone runs the command
below. Orders created
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
and are readable by the `three-ws@` runtime service account; all four were
re-checked on 2026-08-14 (each carries the `roles/secretmanager.secretAccessor`
binding, and each payload hashes identical to the value `three-ws-api` runs
with). Do **not** repoint them at
the project's generic `JWT_SECRET` / `WALLET_ENCRYPTION_KEY` secrets: those hold
older values and would break custodial key recovery on every live fill.

It ships in `ORDERS_MODE=simulate` (real quotes, no broadcast). Flip
`_ORDERS_MODE=live` (build substitution) or update the running service's
`ORDERS_MODE` only after agent wallets are funded. It can equally run as a Cloud
Run **Job** (jobs get no startup probe, so `PORT` is unset and no listener binds;
the sweep loop is unaffected either way).

### Verifying the image without deploying

The deploy config above always ends in `gcloud run deploy`. To prove the image
still builds without shipping it, use the build-only config next to it:

```bash
gcloud builds submit . \
  --config workers/agent-orders/cloudbuild.verify.yaml \
  --ignore-file workers/agent-orders/verify.gcloudignore \
  --region us-central1 --project aerial-vehicle-466722-p5
```

Same Dockerfile, same repo-root context, no push and no deploy. Last green
2026-08-14 (build `28d998f3`, 4m43s, all 14 layers, 95.7 MiB uploaded).

The equivalent local build is `docker build -f workers/agent-orders/Dockerfile
-t agent-orders .`, but expect it to fail on a dev container: the image installs
the whole root workspace (3000+ packages) and then compiles `agent-payments-sdk`,
which is more memory than a Codespace has, and the local context is not filtered
by `.gcloudignore` so it also walks a multi-GB `dist/`. Cloud Build is the
supported path.

A green build proves less than it looks like it does, because two ways of
breaking this image only show up when the container boots. Re-check both if you
add an import to any file under `workers/agent-orders/`:

- **Every module the worker reaches must be inside the Dockerfile's `COPY` set**
  (`agent-payments-sdk/`, `api/`, `src/`, `workers/agent-orders/`, and the single
  file `workers/agent-sniper/amm-exit.js`). Reaching outside it builds fine and
  then dies at `ERR_MODULE_NOT_FOUND` on the first sweep.
- **Every bare import must be a prod dependency.** The image runs
  `npm prune --omit=dev`, so an import that resolves to a devDependency
  disappears from the shipped layer.

Both held on 2026-08-14: 59 modules reached, all inside the `COPY` set, and all
17 distinct bare specifiers resolve to prod dependencies or the workspace SDK.

One thing about the build log is worth knowing before you read it as a failure:
the repo-root `package-lock.json` is out of sync with `package.json`, so the
image's `npm ci` exits with EUSAGE (missing `@ethereum-attestation-service/*`
and friends) and the Dockerfile's `|| npm install` fallback carries the install.
Expected today, and shared with every other worker image.

The migration is
`api/_lib/migrations/20260623160000_programmable_orders.sql` (`npm run db:migrate`).
The owner-facing surface is the **Orders** tab in the agent wallet hub
(`src/agent-wallet-hub/tabs/orders.js`), backed by `/api/agents/:id/orders`.
